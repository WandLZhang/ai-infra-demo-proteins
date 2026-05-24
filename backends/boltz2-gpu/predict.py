"""Boltz-2 on GPU — stock PyTorch + CUDA.

Uses the `boltz predict` CLI. No patches needed for GPU (unlike TPU).
Validated: hemoglobin alpha (142 aa) on A100 — CIF 94,958 chars.
"""

from __future__ import annotations

import glob
import os
import shutil
import sys
import time


def predict_boltz2_gpu(fasta_path: str, out_dir: str, sampling_steps: int = 50) -> dict:
    """Run Boltz-2 structure prediction on GPU.

    Args:
        fasta_path: Path to input FASTA file (single chain, format: >A|protein\\nSEQUENCE)
        out_dir: Output directory for CIF files
        sampling_steps: Number of diffusion sampling steps

    Returns:
        dict with keys: cif_path, cif_chars, atom_count, elapsed_s
    """
    if os.path.exists(out_dir):
        shutil.rmtree(out_dir)

    sys.argv = [
        "boltz", "predict", fasta_path,
        "--out_dir", out_dir,
        "--accelerator", "gpu",
        "--devices", "1",
        "--use_msa_server",
        "--diffusion_samples", "1",
        "--recycling_steps", "1",
        "--sampling_steps", str(sampling_steps),
    ]

    t0 = time.perf_counter()
    from boltz.main import cli
    try:
        cli(standalone_mode=False)
    except SystemExit:
        pass
    elapsed = time.perf_counter() - t0

    cif_files = glob.glob(f"{out_dir}/**/*.cif", recursive=True)
    result = {"elapsed_s": elapsed, "cif_path": None, "cif_chars": 0, "atom_count": 0}
    if cif_files:
        result["cif_path"] = cif_files[0]
        with open(cif_files[0]) as f:
            content = f.read()
        result["cif_chars"] = len(content)
        result["atom_count"] = content.count("\nATOM ")

    return result


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Boltz-2 GPU inference")
    parser.add_argument("fasta", help="Input FASTA file")
    parser.add_argument("--out-dir", default="/tmp/boltz_gpu_out")
    parser.add_argument("--sampling-steps", type=int, default=50)
    args = parser.parse_args()

    result = predict_boltz2_gpu(args.fasta, args.out_dir, args.sampling_steps)
    print(f"\nBoltz-2 GPU: {result['elapsed_s']:.1f}s")
    print(f"CIF: {result['cif_path']}")
    print(f"Size: {result['cif_chars']} chars, ATOMs: {result['atom_count']}")
    print("STATUS:", "PASS" if result["cif_path"] else "FAIL")
