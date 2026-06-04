#!/bin/bash
# deploy_tpu_host_scripts.sh — Push the TPU VM host-side scripts to /opt/
# on each TPU VM, plus upload the container-side prewarm script to GCS.
#
# Scripts and where they live:
#   /opt/tpu-server-health.sh        — cron */5 min on east5a-0 (host)
#   /opt/tpu-keep-warm.sh            — cron */20 min on east5a-0 (host)
#   gs://.../scripts/prewarm_all_proteins.sh — fetched from GCS by the cron
#                                       jobs into the slurmd container at /tmp/
#
# Why GCS for prewarm: the prewarm script runs INSIDE the slurmd container
# (it needs network access to ESMFold + Boltz-2 servers and lives alongside
# Python). The cron jobs on the host fetch it via gsutil cp at runtime.
#
# After deploy, manually triggers tpu-server-health.sh once on east5a-0 so
# the frontend badge reflects current state immediately rather than waiting
# for the next cron tick.
#
# Prerequisites:
#   - gcloud authenticated with TPU + storage access in BURST_PROJECT_ID
#
# Usage:
#   bash scripts/deploy_tpu_host_scripts.sh

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/env.sh"

# Only the ESMFold TPU VM currently has the cron jobs (it drives the badge).
# The Boltz-2 TPU VM doesn't need these scripts.
TPU_VM="${TPU_VM:-nihprotein-tpuv6eeast5a-0}"
TPU_ZONE="${TPU_ZONE:-us-east5-a}"

echo "=== Uploading prewarm script to GCS ==="
gsutil -q cp "$SCRIPT_DIR/prewarm_all_proteins.sh" "$SHARED_BUCKET/scripts/prewarm_all_proteins.sh"
echo "  ok: $SHARED_BUCKET/scripts/prewarm_all_proteins.sh"

echo ""
echo "=== Pushing host scripts to $TPU_VM:/opt/ ==="
gcloud compute tpus tpu-vm scp \
  "$SCRIPT_DIR/tpu-server-health.sh" \
  "$SCRIPT_DIR/tpu-keep-warm.sh" \
  "$TPU_VM:/tmp/" \
  --zone="$TPU_ZONE" --project="$BURST_PROJECT_ID" 2>&1 | grep -v "To increase"

gcloud compute tpus tpu-vm ssh "$TPU_VM" --zone="$TPU_ZONE" --project="$BURST_PROJECT_ID" --command='
  sudo mv /tmp/tpu-server-health.sh /opt/tpu-server-health.sh
  sudo mv /tmp/tpu-keep-warm.sh     /opt/tpu-keep-warm.sh
  sudo chmod +x /opt/tpu-server-health.sh /opt/tpu-keep-warm.sh
  echo "  installed: /opt/tpu-server-health.sh ($(stat -c %s /opt/tpu-server-health.sh) bytes)"
  echo "  installed: /opt/tpu-keep-warm.sh    ($(stat -c %s /opt/tpu-keep-warm.sh) bytes)"
' 2>&1 | grep -v "To increase"

echo ""
echo "=== Triggering tpu-server-health.sh once so badge updates immediately ==="
gcloud compute tpus tpu-vm ssh "$TPU_VM" --zone="$TPU_ZONE" --project="$BURST_PROJECT_ID" --command='
  sudo /opt/tpu-server-health.sh
  echo ""
  echo "Current tpu-status.json:"
  gsutil cat '"$SHARED_BUCKET"'/tpu-status.json
' 2>&1 | grep -v "To increase"

echo ""
echo "=== Done ==="
echo "Cron continues: */5 health, */8 keep-warm (interval-tuned later if needed)."
