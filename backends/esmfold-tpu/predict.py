"""ESMFold on TPU via TorchTPU (torch_xla).

Uses a persistent model server if running (port 8090). The server keeps
the model warm — first call compiles XLA ops (~70s), subsequent calls ~9s.
Falls back to direct inference if server is not available.
"""

from __future__ import annotations

import json
import os
import time
import urllib.request
import urllib.error
from typing import Any

SERVER_PORT = int(os.environ.get("ESMFOLD_PORT", 8090))


def _try_server(sequence: str, out_dir: str) -> dict[str, Any] | None:
    """Try the warm model server. Returns None if server is down."""
    pdb_path = os.path.join(out_dir, "prediction.pdb")
    payload = json.dumps({"sequence": sequence, "out_path": pdb_path}).encode()
    req = urllib.request.Request(
        f"http://localhost:{SERVER_PORT}/predict",
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            result = json.loads(resp.read())
        with open(pdb_path) as f:
            pdb_str = f.read()
        return {
            "pdb": pdb_str,
            "plddt_mean": result.get("plddt_mean", 0),
            "plddt_min": 0,
            "plddt_max": 0,
            "solve_time_ms": result.get("solve_time_ms", 0),
            "device_kind": f"TPU ({result.get('device', 'xla:0')})",
            "num_devices": 1,
            "seq_len": result.get("seq_len", len(sequence)),
            "model": "ESMFold",
        }
    except (urllib.error.URLError, ConnectionRefusedError, OSError):
        return None


def predict_structure(sequence: str) -> dict[str, Any]:
    """Direct inference — used when server is not available."""
    import torch
    import torch_xla
    torch_xla.experimental.eager_mode(True)
    import torch_xla.core.xla_model as xm
    from transformers import AutoTokenizer, EsmForProteinFolding

    device = xm.xla_device()
    print(f"[esmfold-tpu] loading facebook/esmfold_v1 on {device}")
    tokenizer = AutoTokenizer.from_pretrained("facebook/esmfold_v1")
    model = EsmForProteinFolding.from_pretrained("facebook/esmfold_v1").to(device).eval()

    seq_len = len(sequence)
    print(f"[esmfold-tpu] predicting structure for {seq_len}-residue protein")
    inputs = tokenizer(sequence, return_tensors="pt", add_special_tokens=False)
    inputs = {k: v.to(device) for k, v in inputs.items()}

    t0 = time.perf_counter()
    with torch.no_grad():
        output = model(**inputs)
    xm.mark_step()
    elapsed_ms = (time.perf_counter() - t0) * 1000.0

    pdb_str = model.output_to_pdb(output)[0]
    plddt = output["plddt"].cpu().numpy().flatten()

    return {
        "pdb": pdb_str,
        "plddt_mean": float(plddt.mean()),
        "plddt_min": float(plddt.min()),
        "plddt_max": float(plddt.max()),
        "solve_time_ms": elapsed_ms,
        "device_kind": f"TPU ({str(device)})",
        "num_devices": 1,
        "seq_len": seq_len,
        "model": "ESMFold",
    }


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="ESMFold TPU inference")
    parser.add_argument("fasta", help="Input FASTA file")
    parser.add_argument("--out-dir", default="/tmp/esmfold_tpu_out")
    args = parser.parse_args()

    with open(args.fasta) as f:
        lines = f.read().strip().split("\n")
    sequence = "".join(l for l in lines if not l.startswith(">"))

    os.makedirs(args.out_dir, exist_ok=True)

    result = _try_server(sequence, args.out_dir)
    if result:
        print(f"[esmfold-tpu] using warm server")
    else:
        print(f"[esmfold-tpu] server not available, direct inference")
        result = predict_structure(sequence)

    pdb_path = os.path.join(args.out_dir, "prediction.pdb")
    if not os.path.exists(pdb_path):
        with open(pdb_path, "w") as f:
            f.write(result["pdb"])

    print(f"\nESMFold TPU: {result['solve_time_ms']:.0f}ms")
    print(f"pLDDT: {result['plddt_mean']:.1f}")
    print(f"PDB: {pdb_path}")
