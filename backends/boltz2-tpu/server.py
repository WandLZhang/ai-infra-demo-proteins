"""Boltz-2 TPU warm model server — trainer-free direct inference.

Loads model ONCE on TPU at startup. Bypasses pytorch_lightning Trainer
and calls MODEL.predict_step() directly, keeping XLA op cache warm.

First request: ~360s (XLA compilation). Subsequent: target < 120s.

Start: cd /opt/backends/boltz2-tpu && PJRT_DEVICE=TPU python3 server.py &
"""

import glob
import json
import os
import shutil
import sys
import time
from dataclasses import asdict
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))
import predict  # noqa — applies all 10 monkey-patches as side effects

import torch
import torch_xla.core.xla_model as xm
from boltz.main import (
    Boltz2,
    Boltz2DiffusionParams,
    Boltz2InferenceDataModule,
    BoltzProcessedInput,
    BoltzSteeringParams,
    BoltzWriter,
    PairformerArgsV2,
    process_inputs,
)
from boltz.main import filter_inputs_structure

PORT = int(os.environ.get("BOLTZ_PORT", 8091))
CACHE = Path(os.environ.get("BOLTZ_CACHE", "/tmp/.boltz"))
DEVICE = xm.xla_device()

# ── Load model ONCE at startup, move to TPU ─────────────────────────────────
print(f"[boltz2-server] loading model from {CACHE / 'boltz2_conf.ckpt'}...")

diffusion_params = Boltz2DiffusionParams()
diffusion_params.step_scale = 1.638
pairformer_args = PairformerArgsV2()
steering_args = BoltzSteeringParams()
steering_args.fk_steering = False
steering_args.guidance_update = False

MODEL = Boltz2.load_from_checkpoint(
    str(CACHE / "boltz2_conf.ckpt"),
    strict=True,
    predict_args={
        "recycling_steps": 1,
        "sampling_steps": 10,
        "diffusion_samples": 1,
        "max_parallel_samples": None,
        "write_confidence_summary": True,
        "write_full_pae": False,
        "write_full_pde": False,
    },
    map_location="cpu",
    diffusion_process_args=asdict(diffusion_params),
    ema=False,
    use_trifast=False,
    pairformer_args=asdict(pairformer_args),
    steering_args=asdict(steering_args),
)

print(f"[boltz2-server] moving model to {DEVICE}...")
MODEL = MODEL.to(DEVICE)
MODEL.eval()
torch.set_grad_enabled(False)
xm.mark_step()
print(f"[boltz2-server] model on TPU, ready for requests")

REQUEST_COUNT = 0


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        global REQUEST_COUNT
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length)) if length else {}
        fasta_path = body.get("fasta_path", "")
        out_dir = body.get("out_dir", "/tmp/boltz2_server_out")
        sampling_steps = body.get("sampling_steps", 10)

        if not fasta_path or not os.path.exists(fasta_path):
            self._respond(400, {"error": "no fasta_path or file missing"})
            return

        REQUEST_COUNT += 1
        req_num = REQUEST_COUNT
        print(f"[boltz2-server] request #{req_num}: {fasta_path} ({sampling_steps} steps)")
        t0 = time.perf_counter()

        try:
            if os.path.exists(out_dir):
                shutil.rmtree(out_dir, ignore_errors=True)
            os.makedirs(out_dir, exist_ok=True)
            out_path = Path(out_dir)

            MODEL.predict_args["sampling_steps"] = sampling_steps

            # 1. MSA + featurization
            mol_dir = CACHE / "mols"
            manifest = process_inputs(
                data=[Path(fasta_path)],
                out_dir=out_path,
                ccd_path=mol_dir,
                mol_dir=mol_dir,
                use_msa_server=True,
                msa_server_url="https://api.colabfold.com",
                msa_pairing_strategy="greedy",
                boltz2=True,
            )
            filtered = filter_inputs_structure(manifest=manifest, outdir=out_path, override=True)
            processed_dir = out_path / "processed"
            processed = BoltzProcessedInput(
                manifest=filtered,
                targets_dir=processed_dir / "structures",
                msa_dir=processed_dir / "msa",
            )

            t_feat = time.perf_counter()
            print(f"[boltz2-server] #{req_num} featurized in {t_feat - t0:.1f}s")

            # 2. Build data loader (lightweight, no Trainer)
            dm = Boltz2InferenceDataModule(
                manifest=processed.manifest,
                target_dir=processed.targets_dir,
                msa_dir=processed.msa_dir,
                mol_dir=mol_dir,
                num_workers=1,
            )
            loader = dm.predict_dataloader()

            writer = BoltzWriter(
                data_dir=str(processed.targets_dir),
                output_dir=str(out_path / f"boltz_results_{Path(fasta_path).stem}"),
                boltz2=True,
            )

            # 3. Direct inference — NO Trainer
            for batch_idx, batch in enumerate(loader):
                batch = dm.transfer_batch_to_device(batch, DEVICE, 0)
                t_inf = time.perf_counter()
                out = MODEL.predict_step(batch, batch_idx, 0)
                xm.mark_step()
                t_done = time.perf_counter()
                print(f"[boltz2-server] #{req_num} inference in {t_done - t_inf:.1f}s")
                writer.write_on_batch_end(None, None, out, None, batch, batch_idx, 0)

        except Exception as e:
            import traceback
            print(f"[boltz2-server] #{req_num} error: {type(e).__name__}: {e}")
            traceback.print_exc()

        elapsed = time.perf_counter() - t0
        cif_files = glob.glob(f"{out_dir}/**/*.cif", recursive=True)
        result = {
            "elapsed_s": round(elapsed, 1),
            "cif_path": cif_files[0] if cif_files else None,
            "cif_chars": 0,
            "warm": elapsed < 120,
            "request_num": req_num,
        }
        if cif_files:
            with open(cif_files[0]) as f:
                result["cif_chars"] = len(f.read())

        print(f"[boltz2-server] #{req_num} done in {elapsed:.1f}s ({'WARM' if result['warm'] else 'COLD'})")
        self._respond(200, result)

    def _respond(self, code, data):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def do_GET(self):
        self._respond(200, {"status": "ready", "device": str(DEVICE), "requests_served": REQUEST_COUNT})

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    print(f"[boltz2-server] serving on port {PORT}")
    server = HTTPServer(("0.0.0.0", PORT), Handler)
    server.serve_forever()
