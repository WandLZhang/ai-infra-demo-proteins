"""State server — GCS polling proxy for the protein demo frontend.

Reads job state from GCS blobs written by run_backend.sh.
Optionally triggers new runs via sbatch (or direct shell).

Endpoints:
  POST /api/submit          — start a new run (6 backends)
  GET  /api/status/<run_id> — poll all 6 backend states for a run
  GET  /api/latest          — find the most recent run_id
  GET  /api/runs            — list all runs

Requires: pip install flask flask-cors google-cloud-storage
Run: python local-controller/server.py
"""

import json
import os
import subprocess
import time
from datetime import datetime, timezone

from flask import Flask, jsonify, request
from flask_cors import CORS
from google.cloud import storage

app = Flask(__name__)
CORS(app)

BUCKET_NAME = os.environ.get("STATE_BUCKET", "wz-nih-demo-shared")
JOBS_PREFIX = "jobs/"
PREDICT_SCRIPT = os.path.join(os.path.dirname(__file__), "..", "scripts", "predict.sh")

ALL_BACKENDS = [
    "af2-tpu", "af2-gpu",
    "esmfold-tpu", "esmfold-gpu",
    "boltz2-tpu", "boltz2-gpu",
]

_client = None

def get_client():
    global _client
    if _client is None:
        _client = storage.Client()
    return _client


def get_bucket():
    return get_client().bucket(BUCKET_NAME)


@app.route("/api/submit", methods=["POST"])
def submit():
    """Start a new prediction run. Returns {run_id}."""
    data = request.json or {}
    protein_id = data.get("protein_id", "hemoglobin")

    # If a run exists and isn't finished, show it — don't resubmit
    latest = _find_latest_run()
    if latest and not latest.get("all_complete"):
        return jsonify({
            "run_id": latest["run_id"],
            "already_running": True,
        })

    # If the previous run IS finished, clean it out before starting fresh
    if latest and latest.get("all_complete"):
        _delete_run(latest["run_id"])

    # Trigger predict.sh
    result = subprocess.run(
        ["bash", PREDICT_SCRIPT, protein_id],
        capture_output=True, text=True, timeout=30,
    )

    lines = result.stdout.strip().split("\n")
    run_id = None
    dispatch_lines = []
    for line in lines:
        if line.startswith("Run ID:"):
            run_id = line.split(":", 1)[1].strip()
        elif line.startswith("Submitted "):
            dispatch_lines.append(line)

    if not run_id:
        return jsonify({"error": "Failed to start run", "stdout": result.stdout, "stderr": result.stderr}), 500

    return jsonify({
        "run_id": run_id,
        "already_running": False,
        "dispatch_lines": dispatch_lines,
    })


@app.route("/api/status/<run_id>")
def status(run_id):
    """Poll all backend states for a run. Returns {run_id, lanes, all_complete}."""
    bucket = get_bucket()
    prefix = f"{JOBS_PREFIX}{run_id}/"

    lanes = {}
    for backend_id in ALL_BACKENDS:
        blob = bucket.blob(f"{prefix}{backend_id}.json")
        if blob.exists():
            content = json.loads(blob.download_as_text())
            lanes[backend_id] = content
        else:
            lanes[backend_id] = {
                "backend_id": backend_id,
                "run_id": run_id,
                "state": "idle",
            }

    all_complete = all(
        lanes[b].get("state") in ("done", "failed")
        for b in ALL_BACKENDS
    )

    # Read manifest for metadata
    manifest_blob = bucket.blob(f"{prefix}manifest.json")
    manifest = {}
    if manifest_blob.exists():
        manifest = json.loads(manifest_blob.download_as_text())

    # If all complete, update manifest status
    if all_complete and manifest.get("status") == "running":
        manifest["status"] = "complete"
        manifest["completed_at"] = datetime.now(timezone.utc).isoformat()
        manifest_blob.upload_from_string(json.dumps(manifest, indent=2))

    return jsonify({
        "run_id": run_id,
        "lanes": lanes,
        "all_complete": all_complete,
        "manifest": manifest,
    })


@app.route("/api/latest")
def latest():
    """Find the most recent run. Returns {run_id, lanes, all_complete} or {run_id: null}."""
    result = _find_latest_run()
    if result is None:
        return jsonify({"run_id": None})
    return jsonify(result)


@app.route("/api/runs")
def runs():
    """List all runs with their manifest metadata."""
    bucket = get_bucket()
    blobs = bucket.list_blobs(prefix=JOBS_PREFIX, delimiter="/")

    # list_blobs with delimiter returns prefixes for "directories"
    run_ids = []
    for page in blobs.pages:
        for prefix in page.prefixes:
            run_id = prefix.replace(JOBS_PREFIX, "").rstrip("/")
            if run_id:
                run_ids.append(run_id)

    # Sort by run_id (which is a timestamp, so lexicographic = chronological)
    run_ids.sort(reverse=True)

    result = []
    for run_id in run_ids[:20]:
        manifest_blob = bucket.blob(f"{JOBS_PREFIX}{run_id}/manifest.json")
        manifest = {}
        if manifest_blob.exists():
            manifest = json.loads(manifest_blob.download_as_text())
        result.append({"run_id": run_id, **manifest})

    return jsonify({"runs": result})


@app.route("/api/health")
def health():
    return jsonify({"status": "ok", "bucket": BUCKET_NAME})


def _delete_run(run_id: str):
    """Remove all blobs for a completed run."""
    bucket = get_bucket()
    blobs = list(bucket.list_blobs(prefix=f"{JOBS_PREFIX}{run_id}/"))
    for blob in blobs:
        blob.delete()


def _find_latest_run():
    """Find the most recent run_id and return its status."""
    bucket = get_bucket()
    blobs = bucket.list_blobs(prefix=JOBS_PREFIX, delimiter="/")

    run_ids = []
    for page in blobs.pages:
        for prefix in page.prefixes:
            run_id = prefix.replace(JOBS_PREFIX, "").rstrip("/")
            if run_id:
                run_ids.append(run_id)

    if not run_ids:
        return None

    run_ids.sort(reverse=True)
    latest_id = run_ids[0]

    # Build lane states
    lanes = {}
    prefix = f"{JOBS_PREFIX}{latest_id}/"
    for backend_id in ALL_BACKENDS:
        blob = bucket.blob(f"{prefix}{backend_id}.json")
        if blob.exists():
            lanes[backend_id] = json.loads(blob.download_as_text())
        else:
            lanes[backend_id] = {"backend_id": backend_id, "state": "idle"}

    all_complete = all(
        lanes[b].get("state") in ("done", "failed")
        for b in ALL_BACKENDS
    )

    return {
        "run_id": latest_id,
        "lanes": lanes,
        "all_complete": all_complete,
    }


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    print(f"State server starting on port {port}")
    print(f"Bucket: {BUCKET_NAME}")
    print(f"Predict script: {PREDICT_SCRIPT}")
    app.run(host="0.0.0.0", port=port, debug=True)
