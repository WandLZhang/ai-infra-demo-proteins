"""Boltz-2 on TPU via TorchTPU.

Boltz-2 predicts structures for proteins + RNA + DNA + ligands + binding
affinity. It's a diffusion model (PyTorch). Same TorchTPU pattern as
ESMFold-TPU: model.to(xm.xla_device()).
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

import torch
import torch_xla.core.xla_model as xm


@dataclass
class ModelState:
    model: Any
    device: Any


_state: ModelState | None = None


def load_model() -> ModelState:
    global _state
    if _state is not None:
        return _state

    device = xm.xla_device()
    print(f"[boltz2-tpu] loading Boltz-2 on {device}")

    # Boltz-2 API — load from HuggingFace weights
    from boltz import Boltz2

    model = Boltz2.from_pretrained()
    model = model.to(device)
    model.eval()

    print(f"[boltz2-tpu] model loaded on {device}")
    _state = ModelState(model=model, device=device)
    return _state


def predict_structure(sequence: str) -> dict[str, Any]:
    """Predict structure from a protein sequence using Boltz-2."""
    state = load_model()
    seq_len = len(sequence)
    print(f"[boltz2-tpu] predicting structure for {seq_len}-residue protein")

    t0 = time.perf_counter()

    # Boltz-2's predict API takes a FASTA-like input
    result = state.model.predict(sequence)
    xm.mark_step()

    elapsed_ms = (time.perf_counter() - t0) * 1000.0

    pdb_str = result.to_pdb() if hasattr(result, 'to_pdb') else str(result)
    confidence = result.confidence if hasattr(result, 'confidence') else 0.0

    return {
        "pdb": pdb_str,
        "plddt_mean": float(confidence) if isinstance(confidence, (int, float)) else 0.0,
        "solve_time_ms": elapsed_ms,
        "device_kind": f"TPU ({str(state.device)})",
        "num_devices": xm.xrt_world_size(),
        "seq_len": seq_len,
        "model": "Boltz-2",
    }
