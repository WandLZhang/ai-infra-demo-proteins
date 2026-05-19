"""Boltz-2 on GPU — stock PyTorch + CUDA."""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

import torch


@dataclass
class ModelState:
    model: Any
    device: str


_state: ModelState | None = None


def load_model() -> ModelState:
    global _state
    if _state is not None:
        return _state

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"[boltz2-gpu] loading Boltz-2 on {device}")

    from boltz import Boltz2

    model = Boltz2.from_pretrained()
    model = model.to(device)
    model.eval()

    print(f"[boltz2-gpu] model loaded on {device}")
    _state = ModelState(model=model, device=device)
    return _state


def predict_structure(sequence: str) -> dict[str, Any]:
    state = load_model()
    seq_len = len(sequence)
    print(f"[boltz2-gpu] predicting structure for {seq_len}-residue protein")

    t0 = time.perf_counter()
    result = state.model.predict(sequence)
    elapsed_ms = (time.perf_counter() - t0) * 1000.0

    pdb_str = result.to_pdb() if hasattr(result, 'to_pdb') else str(result)
    confidence = result.confidence if hasattr(result, 'confidence') else 0.0

    return {
        "pdb": pdb_str,
        "plddt_mean": float(confidence) if isinstance(confidence, (int, float)) else 0.0,
        "solve_time_ms": elapsed_ms,
        "device_kind": torch.cuda.get_device_name(0) if torch.cuda.is_available() else "cpu",
        "num_devices": torch.cuda.device_count(),
        "seq_len": seq_len,
        "model": "Boltz-2",
    }
