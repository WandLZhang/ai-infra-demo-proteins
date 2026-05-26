"""AF2-on-TPU predict step.

Loads pre-computed features.pkl from GCS, runs the JAX/Haiku model
forward pass on TPU, returns a structure as PDB string.

This skips the slow MSA pipeline (handled offline, features cached in GCS)
and skips the AMBER relax stage (which is CPU/OpenMM). What we care about
is the model.RunModel.predict() call — that's where TPU vs GPU compare.
"""

from __future__ import annotations

import os
import pickle
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

os.environ["JAX_PLATFORMS"] = "cpu"
import jax
import numpy as np

# AlphaFold imports (require alphafold v2.3.2 to be on PYTHONPATH)
from alphafold.common import protein
from alphafold.model import config, data, model

from google.cloud import storage


# ------------------------------------------------------------------
# Config
# ------------------------------------------------------------------
# AlphaFold ships 5 model_1..model_5 weights (monomer) and model_1..5_multimer
# variants. For the gate test we use model_1 (the canonical monomer model).
_MODEL_NAME = "model_1"

# Where the AlphaFold params live in our shared GCS bucket. We pre-stage
# alphafold/params/params_model_1.npz once at deployment time.
_PARAMS_BUCKET = os.environ.get("SHARED_BUCKET", "wz-nih-demo-shared")
_PARAMS_BLOB = "alphafold-params/params_model_1.npz"

# Local cache so we only download params once per pod lifetime
_LOCAL_PARAMS_DIR = Path("/var/cache/alphafold-params")


# ------------------------------------------------------------------
# Lazy-loaded model state (one per pod)
# ------------------------------------------------------------------
@dataclass
class ModelState:
    model_runner: model.RunModel
    model_params: Any
    devices: list[Any]


_state: ModelState | None = None


def _download_params() -> Path:
    """Download AlphaFold model_1 params from GCS once per pod."""
    _LOCAL_PARAMS_DIR.mkdir(parents=True, exist_ok=True)
    local_path = _LOCAL_PARAMS_DIR / "params_model_1.npz"
    if local_path.exists() and local_path.stat().st_size > 0:
        return local_path

    client = storage.Client()
    bucket = client.bucket(_PARAMS_BUCKET)
    blob = bucket.blob(_PARAMS_BLOB)
    print(f"[af2-tpu] downloading gs://{_PARAMS_BUCKET}/{_PARAMS_BLOB} -> {local_path}")
    blob.download_to_filename(str(local_path))
    return local_path


def load_model() -> ModelState:
    """Load AF2 weights + build the JAX runner. Idempotent."""
    global _state
    if _state is not None:
        return _state

    devices = jax.devices()
    print(f"[af2-tpu] JAX devices: {[d.device_kind for d in devices]}")

    params_path = _download_params()
    model_params = data.get_model_haiku_params(model_name=_MODEL_NAME, data_dir=str(params_path.parent.parent))

    model_config = config.model_config(_MODEL_NAME)
    # Single recycle for gate test (faster). Production uses 3.
    model_config.model.num_recycle = 1
    model_runner = model.RunModel(model_config, model_params)

    _state = ModelState(model_runner=model_runner, model_params=model_params, devices=devices)
    return _state


def predict_structure(features_pkl_path: str) -> dict[str, Any]:
    """Run AF2 predict step on pre-computed features.

    Args:
        features_pkl_path: local path to features.pkl (pre-computed MSA + templates)

    Returns:
        dict with 'pdb', 'plddt_mean', 'solve_time_ms', 'device_kind'
    """
    state = load_model()

    with open(features_pkl_path, "rb") as fh:
        feature_dict = pickle.load(fh)

    print(f"[af2-tpu] processing features (seq len: {feature_dict['aatype'].shape[0]})")

    # Run prediction — this is the JAX/Haiku forward pass we care about
    t0 = time.perf_counter()
    processed = state.model_runner.process_features(feature_dict, random_seed=0)
    prediction = state.model_runner.predict(processed, random_seed=0)
    elapsed_ms = (time.perf_counter() - t0) * 1000.0

    # Build PDB output
    try:
        unrelaxed_protein = protein.from_prediction(
            features=processed, result=prediction,
            b_factors=np.repeat(prediction["plddt"][:, None], 37, axis=-1),
            remove_leading_feature_dim=False,
        )
    except TypeError:
        unrelaxed_protein = protein.from_prediction(
            features=processed, result=prediction,
            b_factors=np.repeat(prediction["plddt"][:, None], 37, axis=-1),
        )
    pdb_str = protein.to_pdb(unrelaxed_protein)

    return {
        "pdb": pdb_str,
        "plddt_mean": float(prediction["plddt"].mean()),
        "plddt_min": float(prediction["plddt"].min()),
        "plddt_max": float(prediction["plddt"].max()),
        "solve_time_ms": elapsed_ms,
        "device_kind": state.devices[0].device_kind,
        "num_devices": len(state.devices),
        "seq_len": int(feature_dict["aatype"].shape[0]),
    }


def _download_features(protein_id: str) -> str:
    """Download pre-computed features.pkl from GCS for the given protein."""
    local_dir = Path(f"/tmp/af2-features/{protein_id}")
    local_dir.mkdir(parents=True, exist_ok=True)
    local_path = local_dir / "features.pkl"
    if local_path.exists() and local_path.stat().st_size > 0:
        return str(local_path)

    blob_path = f"alphafold-features/features_{protein_id}.pkl"
    client = storage.Client()
    bucket = client.bucket(_PARAMS_BUCKET)
    blob = bucket.blob(blob_path)
    print(f"[af2-tpu] downloading gs://{_PARAMS_BUCKET}/{blob_path} -> {local_path}")
    blob.download_to_filename(str(local_path))
    return str(local_path)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="AlphaFold2 TPU inference")
    parser.add_argument("fasta", help="Input FASTA file")
    parser.add_argument("--out-dir", default="/tmp/af2_tpu_out")
    parser.add_argument("--protein-id", default=None, help="Protein ID for features lookup")
    args = parser.parse_args()

    if args.protein_id:
        protein_id = args.protein_id
    else:
        with open(args.fasta) as f:
            header = f.readline().strip()
        protein_id = header.lstrip(">").split("|")[0].strip().lower()

    features_path = _download_features(protein_id)
    os.makedirs(args.out_dir, exist_ok=True)
    result = predict_structure(features_path)

    pdb_path = os.path.join(args.out_dir, "prediction.pdb")
    with open(pdb_path, "w") as f:
        f.write(result["pdb"])

    print(f"\nAlphaFold2 TPU: {result['solve_time_ms']:.0f}ms")
    print(f"pLDDT: {result['plddt_mean']:.1f}")
    print(f"PDB: {pdb_path}")
    print(f"Device: {result['device_kind']}")
