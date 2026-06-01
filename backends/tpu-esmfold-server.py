"""ESMFold-only TPU model server. Full HBM for one model = always warm.

Port 8090: ESMFold (GET /health, POST /predict)
"""

import json
import os
import threading
import time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

import torch
import torch_xla
# Eager mode skips XLA HLO compilation per shape. Lazy mode would give
# ~9s warm but eats 30+ min cold-compile on first call. Eager gives a flat
# ~136s per call with NO compile, which means a fresh server is immediately
# usable after the model finishes loading weights (~30s).
# See commit 68bb0cd for the same fix in predict.py.
torch_xla.experimental.eager_mode(True)
import torch_xla.core.xla_model as xm
from transformers import AutoTokenizer, EsmForProteinFolding

DEVICE = xm.xla_device()
# Priority-aware serialization:
#   - real POSTs (from Slurm jobs) grab INFERENCE_LOCK directly, no wait
#   - keep-warm POSTs (header X-Keepwarm: true) wait on PRIORITY_CV until
#     HIGH_PRIO_PENDING == 0, then grab the lock
# So a real request from a press-Enter never queues behind 6 keep-warm shapes.
# Worst case it waits behind the ONE keep-warm shape currently mid-flight.
INFERENCE_LOCK = threading.Lock()
PRIORITY_CV = threading.Condition()
HIGH_PRIO_PENDING = 0

print("[tpu-server] loading ESMFold...")
ESM_TOKENIZER = AutoTokenizer.from_pretrained("facebook/esmfold_v1")
ESM_MODEL = EsmForProteinFolding.from_pretrained("facebook/esmfold_v1").to(DEVICE).eval()
torch.set_grad_enabled(False)
print("[tpu-server] ESMFold loaded on TPU")


class ESMFoldHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            self._handle_predict()
        except Exception as e:
            import traceback
            traceback.print_exc()
            try:
                self._respond(500, {"error": f"{type(e).__name__}: {e}"})
            except Exception:
                pass

    def _handle_predict(self):
        global HIGH_PRIO_PENDING
        is_keepwarm = self.headers.get("X-Keepwarm", "").lower() == "true"

        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length)) if length else {}
        sequence = body.get("sequence", "")
        out_path = body.get("out_path", "/tmp/esmfold_server_out.pdb")
        if not sequence:
            self._respond(400, {"error": "no sequence"})
            return

        # Priority gate: real requests bump the counter and grab the lock
        # immediately. Keep-warm requests wait until no real request is in flight.
        if not is_keepwarm:
            with PRIORITY_CV:
                HIGH_PRIO_PENDING += 1
        else:
            with PRIORITY_CV:
                while HIGH_PRIO_PENDING > 0:
                    PRIORITY_CV.wait()

        inputs = ESM_TOKENIZER(sequence, return_tensors="pt", add_special_tokens=False)
        inputs = {k: v.to(DEVICE) for k, v in inputs.items()}
        try:
            with INFERENCE_LOCK:
                # Start timer AFTER lock acquisition so solve_ms reflects actual
                # inference time, not queue wait behind another POST.
                t0 = time.perf_counter()
                with torch.no_grad():
                    output = ESM_MODEL(**inputs)
                xm.mark_step()
                pdb_str = ESM_MODEL.output_to_pdb(output)[0]
                plddt = output["plddt"].cpu().numpy().flatten()
                elapsed_ms = (time.perf_counter() - t0) * 1000.0
        finally:
            if not is_keepwarm:
                with PRIORITY_CV:
                    HIGH_PRIO_PENDING -= 1
                    PRIORITY_CV.notify_all()
        # Caller's out_path may live in a root-owned dir (run_backend.sh chmods
        # it 777, but if that didn't happen, fall back to a slurmuser-writable
        # path and report it back).
        out_dir = os.path.dirname(out_path) or "/tmp"
        try:
            os.makedirs(out_dir, exist_ok=True)
            with open(out_path, "w") as f:
                f.write(pdb_str)
        except OSError:
            fallback = f"/tmp/esmfold_out_{os.path.basename(out_path)}"
            with open(fallback, "w") as f:
                f.write(pdb_str)
            out_path = fallback
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


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", 8090), ESMFoldHandler)
    server.request_queue_size = 64  # default 5 → RST under load; 64 absorbs polling bursts
    print("[tpu-server] serving ESMFold:8090")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()
