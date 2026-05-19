"""FastAPI server for ESMFold-TPU backend.

Identical to esmfold-gpu/main.py except it imports predict.py which
uses torch_xla instead of CUDA. The API surface is the same so the
frontend's BackendLane component works identically.
"""

from __future__ import annotations

import asyncio
from typing import Any

import torch
import torch_xla.core.xla_model as xm
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

import predict as predict_mod

app = FastAPI(title="ai-infra-demo-proteins :: ESMFold-TPU")

_warm = False
_warm_error: str | None = None


class PredictRequest(BaseModel):
    sequence: str


@app.on_event("startup")
async def warmup() -> None:
    global _warm, _warm_error
    try:
        await asyncio.to_thread(predict_mod.load_model)
        _warm = True
    except Exception as exc:
        _warm_error = repr(exc)
        print(f"[esmfold-tpu] warm-up FAILED: {exc}")


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/ready")
def ready() -> dict[str, Any]:
    if _warm_error:
        raise HTTPException(status_code=503, detail=f"warm-up failed: {_warm_error}")
    if not _warm:
        raise HTTPException(status_code=503, detail="warming up")
    return {"ready": True}


@app.get("/api/metrics")
def metrics() -> dict[str, Any]:
    devs = xm.get_xla_supported_devices()
    return {
        "devices": [{"device_kind": str(d), "platform": "tpu", "id": i} for i, d in enumerate(devs)],
        "num_devices": xm.xrt_world_size(),
        "torch_version": torch.__version__,
        "warm": _warm,
        "warm_error": _warm_error,
    }


@app.post("/api/predict")
async def predict_endpoint(req: PredictRequest) -> dict[str, Any]:
    if not _warm:
        raise HTTPException(status_code=503, detail="not warm yet")

    result = await asyncio.to_thread(predict_mod.predict_structure, req.sequence)
    return result
