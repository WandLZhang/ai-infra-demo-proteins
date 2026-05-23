#!/bin/bash
# watch_triggers.sh — Runs on the controller VM, polls GCS for trigger blobs,
# and executes predict.sh when one appears.
#
# Usage: bash scripts/watch_triggers.sh
# (Run via nohup or systemd on the controller VM)

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/env.sh"

POLL_INTERVAL=2
TRIGGERS_PREFIX="triggers/"
PROCESSED_DIR="/tmp/processed_triggers"
mkdir -p "$PROCESSED_DIR"

echo "=== Trigger watcher started ==="
echo "Bucket: $SHARED_BUCKET"
echo "Polling every ${POLL_INTERVAL}s for $SHARED_BUCKET/${TRIGGERS_PREFIX}"
echo ""

while true; do
  TRIGGER_FILES=$(gsutil ls "$SHARED_BUCKET/${TRIGGERS_PREFIX}*.json" 2>/dev/null || true)

  for TRIGGER_PATH in $TRIGGER_FILES; do
    TRIGGER_FILE=$(basename "$TRIGGER_PATH")

    if [ -f "$PROCESSED_DIR/$TRIGGER_FILE" ]; then
      continue
    fi

    echo "[$(date)] New trigger: $TRIGGER_PATH"
    TRIGGER_JSON=$(gsutil cat "$TRIGGER_PATH" 2>/dev/null)
    RUN_ID=$(echo "$TRIGGER_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['run_id'])" 2>/dev/null)
    PROTEIN_ID=$(echo "$TRIGGER_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['protein_id'])" 2>/dev/null)

    if [ -n "$RUN_ID" ] && [ -n "$PROTEIN_ID" ]; then
      echo "[$(date)] Running predict.sh: run_id=$RUN_ID protein=$PROTEIN_ID"
      RUN_ID_OVERRIDE="$RUN_ID" bash "$SCRIPT_DIR/predict.sh" "$PROTEIN_ID" 2>&1 | while read -r line; do
        echo "  $line"
      done
      echo "[$(date)] predict.sh complete for $RUN_ID"

      # Start squeue poller in background to stream live state to GCS
      echo "[$(date)] Starting squeue poller for $RUN_ID"
      bash "$SCRIPT_DIR/poll_squeue.sh" "$RUN_ID" >> /tmp/poll_squeue.log 2>&1 &
    else
      echo "[$(date)] ERROR: Could not parse trigger: $TRIGGER_JSON"
    fi

    touch "$PROCESSED_DIR/$TRIGGER_FILE"
    gsutil -q rm "$TRIGGER_PATH" 2>/dev/null || true
  done

  sleep "$POLL_INTERVAL"
done
