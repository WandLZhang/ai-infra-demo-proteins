"""ESMFold GPU predict step.

Single-sequence protein folding — no MSA, no databases.
Uses HuggingFace transformers ESMFold pipeline (facebook/esmfold_v1).
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from typing import Any

import torch
from transformers import AutoTokenizer, EsmForProteinFolding

_MODEL_ID = "facebook/esmfold_v1"


@dataclass
class ModelState:
    model: EsmForProteinFolding
    tokenizer: AutoTokenizer
    device: str


_state: ModelState | None = None


def load_model() -> ModelState:
    global _state
    if _state is not None:
        return _state

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"[esmfold-gpu] loading {_MODEL_ID} on {device}")

    tokenizer = AutoTokenizer.from_pretrained(_MODEL_ID)
    model = EsmForProteinFolding.from_pretrained(_MODEL_ID)
    model = model.to(device)
    model.eval()

    # Warm up with a short sequence
    dummy = tokenizer("MGSSHHHHH", return_tensors="pt", add_special_tokens=False)
    dummy = {k: v.to(device) for k, v in dummy.items()}
    with torch.no_grad():
        model(**dummy)
    print(f"[esmfold-gpu] warm-up complete")

    _state = ModelState(model=model, tokenizer=tokenizer, device=device)
    return _state


def predict_structure(sequence: str) -> dict[str, Any]:
    """Fold a protein from its amino acid sequence.

    Returns dict with PDB string, pLDDT, timing, device info.
    """
    state = load_model()
    seq_len = len(sequence)
    print(f"[esmfold-gpu] predicting structure for {seq_len}-residue protein")

    inputs = state.tokenizer(sequence, return_tensors="pt", add_special_tokens=False)
    inputs = {k: v.to(state.device) for k, v in inputs.items()}

    t0 = time.perf_counter()
    with torch.no_grad():
        output = state.model(**inputs)
    elapsed_ms = (time.perf_counter() - t0) * 1000.0

    # Extract PDB and confidence
    pdb_str = state.model.output_to_pdb(output)[0]
    plddt = output["plddt"].cpu().numpy().flatten()

    return {
        "pdb": pdb_str,
        "plddt_mean": float(plddt.mean()),
        "plddt_min": float(plddt.min()),
        "plddt_max": float(plddt.max()),
        "solve_time_ms": elapsed_ms,
        "device_kind": torch.cuda.get_device_name(0) if torch.cuda.is_available() else "cpu",
        "num_devices": torch.cuda.device_count(),
        "seq_len": seq_len,
        "model": "ESMFold",
    }


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="ESMFold GPU inference")
    parser.add_argument("fasta", help="Input FASTA file")
    parser.add_argument("--out-dir", default="/tmp/esmfold_gpu_out")
    args = parser.parse_args()

    with open(args.fasta) as f:
        lines = f.read().strip().split("\n")
    sequence = "".join(l for l in lines if not l.startswith(">"))

    os.makedirs(args.out_dir, exist_ok=True)
    result = predict_structure(sequence)

    pdb_path = os.path.join(args.out_dir, "prediction.pdb")
    with open(pdb_path, "w") as f:
        f.write(result["pdb"])

    print(f"\nESMFold GPU: {result['solve_time_ms']:.0f}ms")
    print(f"pLDDT: {result['plddt_mean']:.1f} (min={result['plddt_min']:.1f}, max={result['plddt_max']:.1f})")
    print(f"PDB: {pdb_path}")
    print(f"Device: {result['device_kind']}")
