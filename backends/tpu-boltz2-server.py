"""Boltz-2-only TPU model server. Full HBM for one model = always warm.

Port 8091: Boltz-2 (GET /health, POST /predict)
"""
import glob, json, os, shutil, sys, threading, time
from dataclasses import asdict
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path

# Priority-aware serialization: real POSTs from Slurm jobs jump ahead of
# keep-warm POSTs (X-Keepwarm: true). See ESMFold server for full notes.
INFERENCE_LOCK = threading.Lock()
PRIORITY_CV = threading.Condition()
HIGH_PRIO_PENDING = 0

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "boltz2-tpu"))
import predict as boltz_predict  # noqa — applies all patches

import torch
import torch_xla.core.xla_model as xm
from boltz.main import (
    Boltz2, Boltz2DiffusionParams, Boltz2InferenceDataModule,
    BoltzProcessedInput, BoltzSteeringParams, BoltzWriter,
    PairformerArgsV2, process_inputs,
)
from boltz.main import filter_inputs_structure

DEVICE = xm.xla_device()
CACHE = Path(os.environ.get("BOLTZ_CACHE", "/tmp/.boltz"))

print("[boltz2-server] loading Boltz-2...")
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
        "recycling_steps": 1, "sampling_steps": 10, "diffusion_samples": 1,
        "max_parallel_samples": None, "write_confidence_summary": False,
        "write_full_pae": False, "write_full_pde": False,
    },
    map_location="cpu",
    diffusion_process_args=asdict(diffusion_params),
    ema=False, use_trifast=False,
    pairformer_args=asdict(pairformer_args),
    steering_args=asdict(steering_args),
)
MODEL = MODEL.to(DEVICE)
MODEL.eval()
torch.set_grad_enabled(False)
xm.mark_step()
print("[boltz2-server] Boltz-2 loaded on TPU")


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        global HIGH_PRIO_PENDING
        is_keepwarm = self.headers.get("X-Keepwarm", "").lower() == "true"

        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length)) if length else {}
        # Two input modes:
        #   1. fasta_content: caller sends the FASTA text directly (cross-VM safe).
        #   2. fasta_path: legacy, path must exist on this VM's filesystem.
        fasta_content = body.get("fasta_content", "")
        fasta_path = body.get("fasta_path", "")
        out_dir = body.get("out_dir", "/tmp/boltz2_server_out")
        sampling_steps = body.get("sampling_steps", 10)
        name = body.get("name", "boltz_job")

        if fasta_content:
            fasta_path = f"/tmp/{name}.fasta"
            with open(fasta_path, "w") as f:
                f.write(fasta_content)
        elif not fasta_path or not os.path.exists(fasta_path):
            self._respond(400, {"error": "need fasta_content or local fasta_path"})
            return

        # Priority gate: real Slurm POSTs jump ahead; keep-warm waits.
        if not is_keepwarm:
            with PRIORITY_CV:
                HIGH_PRIO_PENDING += 1
        else:
            with PRIORITY_CV:
                while HIGH_PRIO_PENDING > 0:
                    PRIORITY_CV.wait()

        try:
          with INFERENCE_LOCK:
            # Start timer AFTER lock — exclude queue wait from elapsed_s
            t0 = time.perf_counter()
            if os.path.exists(out_dir):
                shutil.rmtree(out_dir, ignore_errors=True)
            os.makedirs(out_dir, exist_ok=True)
            out_path = Path(out_dir)
            MODEL.predict_args["sampling_steps"] = sampling_steps
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
                out = MODEL.predict_step(batch, batch_idx, 0)
                xm.mark_step()
                writer.write_on_batch_end(None, None, out, None, batch, batch_idx, 0)
            elapsed = time.perf_counter() - t0
        except Exception as e:
            import traceback
            print(f"[boltz2] error: {type(e).__name__}: {e}")
            traceback.print_exc()
            elapsed = 0
        finally:
            if not is_keepwarm:
                with PRIORITY_CV:
                    HIGH_PRIO_PENDING -= 1
                    PRIORITY_CV.notify_all()
        cif_files = glob.glob(f"{out_dir}/**/*.cif", recursive=True)
        result = {
            "elapsed_s": round(elapsed, 1),
            "cif_path": None,
            "cif_content": None,
            "cif_chars": 0,
            "warm": elapsed < 60,
        }
        if cif_files:
            result["cif_path"] = cif_files[0]
            with open(cif_files[0]) as f:
                content = f.read()
            result["cif_content"] = content
            result["cif_chars"] = len(content)
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


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", 8091), Handler)
    server.request_queue_size = 64
    print("[boltz2-server] serving Boltz-2:8091")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()
