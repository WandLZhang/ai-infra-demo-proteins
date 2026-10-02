#!/bin/bash
# watch_triggers.sh — Runs on the controller VM, polls GCS for trigger blobs,
# and executes predict.sh when one appears.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/env.sh"

LOCKFILE="/tmp/watch_triggers.lock"
exec 200>"$LOCKFILE"
flock -n 200 || { echo "Another watcher already holds the flock, exiting"; exit 0; }
echo $$ > "$LOCKFILE"

# One check costs about 0.1 s through the JSON API (gsutil took 1.5 s), so a 1 s interval puts a
# new trigger in front of predict.sh about half a second after the frontend writes it.
POLL_INTERVAL=1
TRIGGERS_PREFIX="triggers/"
PROCESSED_DIR="/tmp/processed_triggers"
mkdir -p "$PROCESSED_DIR"

echo "=== Trigger watcher started ==="
echo "Bucket: $SHARED_BUCKET"
echo "Polling every ${POLL_INTERVAL}s for $SHARED_BUCKET/${TRIGGERS_PREFIX}"
echo ""

while true; do
  TRIGGER_NAMES=$(gcs_list "$TRIGGERS_PREFIX" 2>/dev/null || true)

  for TRIGGER_NAME in $TRIGGER_NAMES; do
    [[ "$TRIGGER_NAME" == *.json ]] || continue
    TRIGGER_FILE=$(basename "$TRIGGER_NAME")

    if [ -f "$PROCESSED_DIR/$TRIGGER_FILE" ]; then
      continue
    fi

    echo "[$(date)] New trigger: $SHARED_BUCKET/$TRIGGER_NAME"
    TRIGGER_JSON=$(gcs_get "$TRIGGER_NAME" 2>/dev/null)
    echo "[$(date)] Trigger payload: $TRIGGER_JSON"
    PROTEIN_ID=$(echo "$TRIGGER_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['protein_id'])" 2>/dev/null)

    if [ -n "$PROTEIN_ID" ]; then
      echo "[$(date)] Running predict.sh: protein=$PROTEIN_ID"
      bash "$SCRIPT_DIR/predict.sh" "$PROTEIN_ID" 2>&1 | while read -r line; do
        echo "  $line"
      done
      echo "[$(date)] predict.sh complete"
    else
      echo "[$(date)] ERROR: Could not parse trigger: $TRIGGER_JSON"
    fi

    touch "$PROCESSED_DIR/$TRIGGER_FILE"
    gcs_delete "$TRIGGER_NAME" 2>/dev/null || true
  done

  sleep "$POLL_INTERVAL"
done
