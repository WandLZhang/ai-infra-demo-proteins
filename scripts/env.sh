#!/bin/bash
# Shared config for ai-infra-demo-proteins deploy scripts.
# Source from other scripts: `source "$(dirname "$0")/env.sh"`
#
# Two-project architecture:
#   - CONTROLLER: where the local Slurm head node lives (on-prem analog)
#   - BURST:      where the cloud compute (TPU + GPU) provisions on demand
# Cross-project IAM: controller-sa@CONTROLLER granted compute.admin
#   + storage.objectAdmin in BURST.
#
# Override these for your own deployment — the values below match the
# reference deployment described in README.md.

# ------------------------------------------------------------------
# Project A: controller (on-prem analog)
# ------------------------------------------------------------------
export CONTROLLER_PROJECT_ID="${CONTROLLER_PROJECT_ID:-wz-nih-demo-controller}"
export CONTROLLER_VM_NAME="${CONTROLLER_VM_NAME:-biowulf-controller}"
export CONTROLLER_VM_ZONE="${CONTROLLER_VM_ZONE:-us-east5-a}"
export CONTROLLER_SA="controller-sa@${CONTROLLER_PROJECT_ID}.iam.gserviceaccount.com"

# ------------------------------------------------------------------
# Project B: burst (cloud compute)
# ------------------------------------------------------------------
export BURST_PROJECT_ID="${BURST_PROJECT_ID:-wz-nih-demo-burst}"
export BURST_PROJECT_NUMBER="${BURST_PROJECT_NUMBER:-212183265679}"

# Shared GCS bucket for model weights, MSAs, results (in burst project)
export SHARED_BUCKET="${SHARED_BUCKET:-gs://wz-nih-demo-shared}"

# Boltz-2 warm server lives on east5a-3 (dedicated v6e for full HBM headroom).
# ESMFold warm server lives on east5a-0 (same VM that runs Slurm jobs → localhost).
# Override-able: set BOLTZ_HOST yourself (colleagues in another project should), else it
# resolves from $SHARED_BUCKET/config/boltz_host (the live value recreate_tpu_node.sh
# publishes when the QR — and thus the node IP — is recreated), else a last-known fallback.
# NOTE: long-running processes that source this (the trigger-watcher) pin BOLTZ_HOST in their
# environment, so after the IP changes they must be restarted to pick it up —
# recreate_tpu_node.sh does that automatically.
export BOLTZ_HOST="${BOLTZ_HOST:-$(gsutil -q cat ${SHARED_BUCKET:-gs://wz-nih-demo-shared}/config/boltz_host 2>/dev/null || echo 10.202.0.30)}"
export BOLTZ_PORT="${BOLTZ_PORT:-8091}"

# Artifact Registry — backend containers
export AR_REPO="${AR_REPO:-proteins}"
export AR_REGION="${AR_REGION:-us-east5}"

# ------------------------------------------------------------------
# Per-second pricing for cost ticker (Cloud Billing Catalog API SKUs)
# ------------------------------------------------------------------
# TPU v6e Trillium 4-chip: 4 × $0.50/chip-hr / 3600 = $0.000556/sec
# H100-mega 8-GPU:         8 × $4.4239/chip-hr / 3600 = $0.009831/sec
# A100 40GB 1-GPU:         1 × $3.67/chip-hr / 3600   = $0.001019/sec
export TPU_PRICE_PER_SEC="0.000556"
export GPU_H100_PRICE_PER_SEC="0.009831"
export GPU_A100_PRICE_PER_SEC="0.001019"

# ------------------------------------------------------------------
# Cloud Storage through the JSON API with curl
# ------------------------------------------------------------------
# A gsutil call spends 1.2-1.7 s starting Python and authenticating; the same request through curl
# takes about 0.1 s. Every status write in a demo run goes through these, so a run's first terminal
# line lands seconds sooner. They authenticate as the VM's service account, as gsutil does.
# Object names here use only [A-Za-z0-9._/-], so '/' is the only character that needs encoding.
export SHARED_BUCKET_NAME="${SHARED_BUCKET#gs://}"

gcs_token() {
  curl -sf --max-time 5 -H "Metadata-Flavor: Google" \
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token" \
    | python3 -c 'import json, sys; print(json.load(sys.stdin)["access_token"])'
}

# gcs_put OBJECT [CONTENT_TYPE] — upload stdin to the shared bucket.
gcs_put() {
  curl -sf -o /dev/null --max-time 20 --retry 3 -X POST --data-binary @- \
    -H "Authorization: Bearer $(gcs_token)" -H "Content-Type: ${2:-application/json}" \
    "https://storage.googleapis.com/upload/storage/v1/b/$SHARED_BUCKET_NAME/o?uploadType=media&name=${1//\//%2F}"
}

# gcs_get OBJECT — print an object from the shared bucket.
gcs_get() {
  curl -sf --max-time 20 --retry 3 -H "Authorization: Bearer $(gcs_token)" \
    "https://storage.googleapis.com/storage/v1/b/$SHARED_BUCKET_NAME/o/${1//\//%2F}?alt=media"
}

# gcs_delete OBJECT
gcs_delete() {
  curl -sf -o /dev/null --max-time 20 --retry 3 -X DELETE -H "Authorization: Bearer $(gcs_token)" \
    "https://storage.googleapis.com/storage/v1/b/$SHARED_BUCKET_NAME/o/${1//\//%2F}"
}

# gcs_list PREFIX — print the names of the objects under PREFIX, one per line, across all pages.
gcs_list() {
  python3 - "$SHARED_BUCKET_NAME" "$1" "$(gcs_token)" <<'PY'
import json, sys, urllib.parse, urllib.request
bucket, prefix, token = sys.argv[1:4]
page = ""
while True:
    query = {"prefix": prefix, "fields": "items(name),nextPageToken"}
    if page:
        query["pageToken"] = page
    req = urllib.request.Request(
        f"https://storage.googleapis.com/storage/v1/b/{bucket}/o?{urllib.parse.urlencode(query)}",
        headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        listing = json.load(resp)
    for item in listing.get("items", []):
        print(item["name"])
    page = listing.get("nextPageToken")
    if not page:
        break
PY
}
