"""State server — GCS proxy for the protein demo frontend.

All state lives in gs://BUCKET/job/ (flat, no run subfolders).
The frontend reads directly from GCS for events and backend blobs.
This server only handles submit (writes a trigger blob to GCS).

Endpoints:
  POST /api/submit  — start a new run (writes trigger, predict.sh fires)
  GET  /api/status  — poll all 6 backend states
  GET  /api/health  — liveness check
"""

import json
import os
from datetime import datetime, timezone

from flask import Flask, jsonify, request
from flask_cors import CORS
from google.cloud import storage

app = Flask(__name__)
CORS(app)

BUCKET_NAME = os.environ.get("STATE_BUCKET", "wz-nih-demo-shared")
JOB_PREFIX = "job/"

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


def _read_job_state():
    bucket = get_bucket()
    lanes = {}
    for bid in ALL_BACKENDS:
        blob = bucket.blob(f"{JOB_PREFIX}{bid}.json")
        if blob.exists():
            try:
                lanes[bid] = json.loads(blob.download_as_text())
            except json.JSONDecodeError:
                lanes[bid] = {"backend_id": bid, "state": "idle"}
        else:
            lanes[bid] = {"backend_id": bid, "state": "idle"}

    all_idle = all(lanes[b].get("state") == "idle" for b in ALL_BACKENDS)
    all_complete = not all_idle and all(
        lanes[b].get("state") in ("done", "failed")
        for b in ALL_BACKENDS
    )
    return lanes, all_complete, all_idle


@app.route("/api/submit", methods=["POST"])
def submit():
    data = request.json or {}
    protein_id = data.get("protein_id", "hemoglobin")

    lanes, all_complete, all_idle = _read_job_state()

    if not all_idle and not all_complete:
        return jsonify({"already_running": True})

    now = datetime.now(timezone.utc)
    bucket = get_bucket()
    trigger = {
        "protein_id": protein_id,
        "submitted_at": now.isoformat(),
    }
    trigger_name = now.strftime("%Y%m%d-%H%M%S")
    bucket.blob(f"triggers/{trigger_name}.json").upload_from_string(
        json.dumps(trigger), content_type="application/json"
    )

    return jsonify({"already_running": False})


@app.route("/api/status")
def status():
    lanes, all_complete, all_idle = _read_job_state()
    return jsonify({
        "lanes": lanes,
        "all_complete": all_complete,
    })


@app.route("/api/health")
def health():
    return jsonify({"status": "ok", "bucket": BUCKET_NAME})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    print(f"State server starting on port {port}")
    print(f"Bucket: {BUCKET_NAME}")
    app.run(host="0.0.0.0", port=port, debug=True)
