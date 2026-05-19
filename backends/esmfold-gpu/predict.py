"""ESMFold GPU predict step.

Single-sequence protein folding — no MSA, no databases.
Uses HuggingFace transformers ESMFold pipeline (facebook/esmfold_v1).
"""

from __future__ import annotations

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
