"""Combined TPU model server — ESMFold + Boltz-2 in one process.

Single VFIO handle, both models warm on TPU. Stays running perpetually
between demo runs. Killed only during AF2-TPU (JAX needs exclusive VFIO),
then auto-restarted by run_backend.sh after AF2-TPU completes.

Port 8090: ESMFold  (GET /healthz, POST /predict)
Port 8091: Boltz-2  (GET /healthz, POST /predict)

Start:
  cd /opt/backends && PJRT_DEVICE=TPU python3 tpu-model-server.py &

Pre-warm (one call each to compile XLA ops):
  curl -X POST localhost:8090/predict -d '{"sequence":"MGSS...","out_path":"/tmp/w.pdb"}'
  curl -X POST localhost:8091/predict -d '{"fasta_path":"/tmp/w.fasta","out_dir":"/tmp/w"}'
"""

import glob
import json
import os
import shutil
import sys
import threading
import time
from dataclasses import asdict
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

# ── Apply Boltz-2 monkey-patches (must happen before any boltz import) ──────
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "boltz2-tpu"))
import predict as boltz_predict  # noqa — applies all 10 patches

import torch
import torch_xla.core.xla_model as xm
from transformers import AutoTokenizer, EsmForProteinFolding

# Boltz-2 imports (patches already applied)
from boltz.main import (
    Boltz2, Boltz2DiffusionParams, Boltz2InferenceDataModule,
    BoltzProcessedInput, BoltzSteeringParams, BoltzWriter,
    PairformerArgsV2, process_inputs,
)
from boltz.main import filter_inputs_structure

DEVICE = xm.xla_device()
CACHE = Path(os.environ.get("BOLTZ_CACHE", "/tmp/.boltz"))

# ═══════════════════════════════════════════════════════════════════════════
# Load BOTH models at startup
# ═══════════════════════════════════════════════════════════════════════════

# ── ESMFold ──────────────────────────────────────────────────────────────
print("[tpu-server] loading ESMFold...")
ESM_TOKENIZER = AutoTokenizer.from_pretrained("facebook/esmfold_v1")
ESM_MODEL = EsmForProteinFolding.from_pretrained("facebook/esmfold_v1").to(DEVICE).eval()
print("[tpu-server] ESMFold loaded on TPU")

# ── Boltz-2 ──────────────────────────────────────────────────────────────
print(f"[tpu-server] loading Boltz-2 from {CACHE / 'boltz2_conf.ckpt'}...")
diffusion_params = Boltz2DiffusionParams()
diffusion_params.step_scale = 1.638
pairformer_args = PairformerArgsV2()
steering_args = BoltzSteeringParams()
steering_args.fk_steering = False
steering_args.guidance_update = False

BOLTZ_MODEL = Boltz2.load_from_checkpoint(
    str(CACHE / "boltz2_conf.ckpt"),
    strict=True,
    predict_args={
        "recycling_steps": 1, "sampling_steps": 10, "diffusion_samples": 1,
        "max_parallel_samples": None, "write_confidence_summary": True,
        "write_full_pae": False, "write_full_pde": False,
    },
    map_location="cpu",
    diffusion_process_args=asdict(diffusion_params),
    ema=False, use_trifast=False,
    pairformer_args=asdict(pairformer_args),
    steering_args=asdict(steering_args),
)
BOLTZ_MODEL = BOLTZ_MODEL.to(DEVICE)
BOLTZ_MODEL.eval()
torch.set_grad_enabled(False)
xm.mark_step()
print("[tpu-server] Boltz-2 loaded on TPU")
print("[tpu-server] both models ready")


# ═══════════════════════════════════════════════════════════════════════════
# ESMFold handler (port 8090)
# ═══════════════════════════════════════════════════════════════════════════
class ESMFoldHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length)) if length else {}
        sequence = body.get("sequence", "")
        out_path = body.get("out_path", "/tmp/esmfold_server_out.pdb")
        if not sequence:
            self._respond(400, {"error": "no sequence"})
            return

        inputs = ESM_TOKENIZER(sequence, return_tensors="pt", add_special_tokens=False)
        inputs = {k: v.to(DEVICE) for k, v in inputs.items()}
        t0 = time.perf_counter()
        with torch.no_grad():
            output = ESM_MODEL(**inputs)
        xm.mark_step()
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        pdb_str = ESM_MODEL.output_to_pdb(output)[0]
        plddt = output["plddt"].cpu().numpy().flatten()
        os.makedirs(os.path.dirname(out_path) or "/tmp", exist_ok=True)
        with open(out_path, "w") as f:
            f.write(pdb_str)
        self._respond(200, {
            "pdb_path": out_path, "pdb_chars": len(pdb_str),
            "plddt_mean": round(float(plddt.mean()), 2),
            "solve_time_ms": round(elapsed_ms), "seq_len": len(sequence),
            "device": str(DEVICE), "warm": elapsed_ms < 20000,
        })

    def do_GET(self):
        self._respond(200, {"status": "ready", "model": "esmfold"})

    def _respond(self, code, data):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def log_message(self, fmt, *args):
        print(f"[esmfold] {args[0]}")


# ═══════════════════════════════════════════════════════════════════════════
# Boltz-2 handler (port 8091)
# ═══════════════════════════════════════════════════════════════════════════
class Boltz2Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length)) if length else {}
        fasta_path = body.get("fasta_path", "")
        out_dir = body.get("out_dir", "/tmp/boltz2_server_out")
        sampling_steps = body.get("sampling_steps", 10)
        if not fasta_path or not os.path.exists(fasta_path):
            self._respond(400, {"error": "no fasta_path"})
            return

        t0 = time.perf_counter()
        try:
            if os.path.exists(out_dir):
                shutil.rmtree(out_dir, ignore_errors=True)
            os.makedirs(out_dir, exist_ok=True)
            out_path = Path(out_dir)
            BOLTZ_MODEL.predict_args["sampling_steps"] = sampling_steps
            mol_dir = CACHE / "mols"
            manifest = process_inputs(
                data=[Path(fasta_path)], out_dir=out_path,
                ccd_path=mol_dir, mol_dir=mol_dir,
                use_msa_server=True, msa_server_url="https://api.colabfold.com",
                msa_pairing_strategy="greedy", boltz2=True,
            )
            filtered = filter_inputs_structure(manifest=manifest, outdir=out_path, override=True)
            processed_dir = out_path / "processed"
            processed = BoltzProcessedInput(
                manifest=filtered,
                targets_dir=processed_dir / "structures",
                msa_dir=processed_dir / "msa",
            )
            dm = Boltz2InferenceDataModule(
                manifest=processed.manifest, target_dir=processed.targets_dir,
                msa_dir=processed.msa_dir, mol_dir=mol_dir, num_workers=1,
            )
            writer = BoltzWriter(
                data_dir=str(processed.targets_dir),
                output_dir=str(out_path / f"boltz_results_{Path(fasta_path).stem}"),
                boltz2=True,
            )
            loader = dm.predict_dataloader()
            for batch_idx, batch in enumerate(loader):
                batch = dm.transfer_batch_to_device(batch, DEVICE, 0)
                out = BOLTZ_MODEL.predict_step(batch, batch_idx, 0)
                xm.mark_step()
                writer.write_on_batch_end(None, None, out, None, batch, batch_idx, 0)
        except Exception as e:
            import traceback
            print(f"[boltz2] error: {type(e).__name__}: {e}")
            traceback.print_exc()

        elapsed = time.perf_counter() - t0
        cif_files = glob.glob(f"{out_dir}/**/*.cif", recursive=True)
        result = {"elapsed_s": round(elapsed, 1), "cif_path": None, "cif_chars": 0, "warm": elapsed < 120}
        if cif_files:
            result["cif_path"] = cif_files[0]
            with open(cif_files[0]) as f:
                result["cif_chars"] = len(f.read())
        self._respond(200, result)

    def do_GET(self):
        self._respond(200, {"status": "ready", "model": "boltz2"})

    def _respond(self, code, data):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def log_message(self, fmt, *args):
        print(f"[boltz2] {args[0]}")


# ═══════════════════════════════════════════════════════════════════════════
# Start both servers on separate threads
# ═══════════════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    esm_server = HTTPServer(("0.0.0.0", 8090), ESMFoldHandler)
    boltz_server = HTTPServer(("0.0.0.0", 8091), Boltz2Handler)

    t1 = threading.Thread(target=esm_server.serve_forever, daemon=True)
    t2 = threading.Thread(target=boltz_server.serve_forever, daemon=True)
    t1.start()
    t2.start()
    print("[tpu-server] serving ESMFold:8090 + Boltz-2:8091")

    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        esm_server.shutdown()
        boltz_server.shutdown()
