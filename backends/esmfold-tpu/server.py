"""ESMFold-TPU model server — keeps model warm between Slurm jobs.

Start once:  PJRT_DEVICE=TPU python3 server.py &
Client:      curl -X POST localhost:8090/predict -d '{"sequence":"MVLS...","out_path":"/tmp/out.pdb"}'

First request compiles XLA ops (~70s). Subsequent requests: ~9s.
"""

import json
import os
import time
from http.server import HTTPServer, BaseHTTPRequestHandler

import torch
import torch_xla
torch_xla.experimental.eager_mode(True)
import torch_xla.core.xla_model as xm
from transformers import AutoTokenizer, EsmForProteinFolding

MODEL_ID = "facebook/esmfold_v1"
PORT = int(os.environ.get("ESMFOLD_PORT", 8090))

print(f"[esmfold-server] loading {MODEL_ID}...")
device = xm.xla_device()
tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)
model = EsmForProteinFolding.from_pretrained(MODEL_ID).to(device).eval()
print(f"[esmfold-server] model loaded on {device}")


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length)) if length else {}
        sequence = body.get("sequence", "")
        out_path = body.get("out_path", "/tmp/esmfold_server_out.pdb")

        if not sequence:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b'{"error":"no sequence"}')
            return

        inputs = tokenizer(sequence, return_tensors="pt", add_special_tokens=False)
        inputs = {k: v.to(device) for k, v in inputs.items()}

        t0 = time.perf_counter()
        with torch.no_grad():
            output = model(**inputs)
        xm.mark_step()
        elapsed_ms = (time.perf_counter() - t0) * 1000.0

        pdb_str = model.output_to_pdb(output)[0]
        plddt = output["plddt"].cpu().numpy().flatten()

        os.makedirs(os.path.dirname(out_path) or "/tmp", exist_ok=True)
        with open(out_path, "w") as f:
            f.write(pdb_str)

        result = {
            "pdb_path": out_path,
            "pdb_chars": len(pdb_str),
            "plddt_mean": round(float(plddt.mean()), 2),
            "solve_time_ms": round(elapsed_ms),
            "seq_len": len(sequence),
            "device": str(device),
            "warm": elapsed_ms < 20000,
        }
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(result).encode())

    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{"status":"ready"}')

    def log_message(self, fmt, *args):
        print(f"[esmfold-server] {args[0]}")


if __name__ == "__main__":
    server = HTTPServer(("0.0.0.0", PORT), Handler)
    print(f"[esmfold-server] listening on port {PORT}")
    server.serve_forever()
