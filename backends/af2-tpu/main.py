"""FastAPI server for AF2-TPU backend.

Endpoints:
  GET  /api/health       — always 200 once uvicorn is up
  GET  /api/ready        — 200 only after model warm-up completes
  GET  /api/metrics      — jax.devices(), JAX version, warm-up state
  POST /api/predict      — predict structure from a feature_id (pre-staged in GCS)
"""

from __future__ import annotations

import asyncio
import os
import tempfile
from pathlib import Path
from typing import Any

import jax
from fastapi import FastAPI, HTTPException
from google.cloud import storage
from pydantic import BaseModel

import predict as predict_mod

app = FastAPI(title="ai-infra-demo-proteins :: AF2-TPU")

_warm = False
_warm_error: str | None = None


class PredictRequest(BaseModel):
    feature_id: str  # name of pre-computed features.pkl in shared bucket


@app.on_event("startup")
async def warmup() -> None:
    """Load model weights and run a single forward pass before /api/ready returns 200."""
    global _warm, _warm_error
    try:
        # Run blocking load in a thread so uvicorn stays responsive
        await asyncio.to_thread(predict_mod.load_model)
        _warm = True
        print(f"[af2-tpu] warm: devices={[d.device_kind for d in jax.devices()]}")
    except Exception as exc:
        _warm_error = repr(exc)
        print(f"[af2-tpu] warm-up FAILED: {exc}")


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
    devs = jax.devices()
    return {
        "devices": [
            {"device_kind": d.device_kind, "platform": d.platform, "id": d.id}
            for d in devs
        ],
        "num_devices": len(devs),
        "jax_version": jax.__version__,
        "warm": _warm,
        "warm_error": _warm_error,
    }


@app.post("/api/predict")
async def predict_endpoint(req: PredictRequest) -> dict[str, Any]:
    if not _warm:
        raise HTTPException(status_code=503, detail="not warm yet")

    # Pull features.pkl from GCS to a temp file
    bucket_name = os.environ.get("SHARED_BUCKET", "wz-nih-demo-shared")
    blob_path = f"features/{req.feature_id}.pkl"

    with tempfile.NamedTemporaryFile(suffix=".pkl", delete=False) as tmp:
        tmp_path = Path(tmp.name)

    try:
        client = storage.Client()
        blob = client.bucket(bucket_name).blob(blob_path)
        if not blob.exists():
            raise HTTPException(
                status_code=404,
                detail=f"features not found: gs://{bucket_name}/{blob_path}",
            )
        blob.download_to_filename(str(tmp_path))

        # Run inference in a thread (JAX dispatch is blocking)
        result = await asyncio.to_thread(predict_mod.predict_structure, str(tmp_path))
        return result
    finally:
        tmp_path.unlink(missing_ok=True)
