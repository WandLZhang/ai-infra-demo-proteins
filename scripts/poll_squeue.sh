#!/bin/bash
# poll_squeue.sh — Polls squeue, writes live state + events to GCS.
# Runs on the controller VM after predict.sh dispatches jobs.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/env.sh"

RUN_ID="${1:?run_id required}"
EVENTS_PATH="$SHARED_BUCKET/jobs/$RUN_ID/events.json"
EVENTS_FILE="/tmp/events-${RUN_ID}.json"
POLL_INTERVAL=3
SLURM_LOG="/var/log/slurm/slurmctld.log"
LAST_LOG_BYTES=0

echo "[]" > "$EVENTS_FILE"

add_event() {
  local MSG="$1"
  local TS
  TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  python3 -c "
import json, sys
with open('$EVENTS_FILE') as f:
    events = json.load(f)
events.append({'ts': '$TS', 'msg': sys.argv[1]})
with open('$EVENTS_FILE', 'w') as f:
    json.dump(events, f)
" "$MSG"
  gsutil -q cp "$EVENTS_FILE" "$EVENTS_PATH" 2>/dev/null || true
  echo "[poll] $TS $MSG"
}

slurm_to_lane() {
  case "$1" in
    PENDING)     echo "queued" ;;
    CONFIGURING) echo "allocating" ;;
    RUNNING)     echo "inferring" ;;
    COMPLETING)  echo "inferring" ;;
    COMPLETED)   echo "done" ;;
    FAILED)      echo "failed" ;;
    *)           echo "queued" ;;
  esac
}

update_blob() {
  local BID="$1" NEW_STATE="$2"
  local BLOB="$SHARED_BUCKET/jobs/$RUN_ID/$BID.json"

  local OLD
  OLD=$(gsutil cat "$BLOB" 2>/dev/null) || return
  local OLD_STATE
  OLD_STATE=$(echo "$OLD" | python3 -c "import sys,json; print(json.load(sys.stdin).get('state',''))" 2>/dev/null) || return

  # Don't overwrite terminal states
  [[ "$OLD_STATE" == "done" || "$OLD_STATE" == "failed" ]] && return
  [[ "$OLD_STATE" == "$NEW_STATE" ]] && return

  local STARTED_AT SILICON PRICE NOW ELAPSED_MS COST
  STARTED_AT=$(echo "$OLD" | python3 -c "import sys,json; print(json.load(sys.stdin).get('started_at',''))" 2>/dev/null) || return
  SILICON=$(echo "$BID" | cut -d- -f2)
  NOW=$(date +%s)
  local START_EPOCH
  START_EPOCH=$(date -d "$STARTED_AT" +%s 2>/dev/null || echo "$NOW")
  ELAPSED_MS=$(( (NOW - START_EPOCH) * 1000 ))
  [[ "$SILICON" == "tpu" ]] && PRICE="$TPU_PRICE_PER_SEC" || PRICE="$GPU_A100_PRICE_PER_SEC"
  COST=$(echo "$ELAPSED_MS * $PRICE / 1000" | bc -l 2>/dev/null || echo "0")

  cat <<EOF | gsutil -q cp - "$BLOB" 2>/dev/null
{
  "backend_id": "$BID",
  "run_id": "$RUN_ID",
  "state": "$NEW_STATE",
  "started_at": "$STARTED_AT",
  "completed_at": null,
  "elapsed_ms": $ELAPSED_MS,
  "cost_accumulated": $COST,
  "result": null,
  "error": null
}
EOF
}

scan_log() {
  # Try reading with sudo, skip silently if not available
  local CONTENT
  CONTENT=$(sudo tail -c +$((LAST_LOG_BYTES + 1)) "$SLURM_LOG" 2>/dev/null) || return
  [[ -z "$CONTENT" ]] && return

  LAST_LOG_BYTES=$(sudo wc -c < "$SLURM_LOG" 2>/dev/null || echo "$LAST_LOG_BYTES")

  echo "$CONTENT" | while IFS= read -r line; do
    if echo "$line" | grep -q "GCP Error.*capacity"; then
      local NODE REGION
      NODE=$(echo "$line" | grep -o 'node [^ ]*' | head -1 | awk '{print $2}')
      REGION=$(echo "$NODE" | sed 's/nihprotein-//' | sed 's/spot.*//' | sed 's/-[0-9]*$//')
      add_event "No Spot capacity: $REGION"
    elif echo "$line" | grep -q "sched.*Allocate.*$RUN_ID"; then
      local NODE PART
      NODE=$(echo "$line" | grep -o 'NodeList=[^ ]*' | head -1 | cut -d= -f2)
      PART=$(echo "$line" | grep -o 'Partition=[^ ]*' | head -1 | cut -d= -f2)
      add_event "Allocated $NODE ($PART)"
    elif echo "$line" | grep -q "requeue.*$RUN_ID"; then
      add_event "Job requeued → next zone"
    fi
  done
}

# Initialize log position to current end (only capture new events)
LAST_LOG_BYTES=$(sudo wc -c < "$SLURM_LOG" 2>/dev/null || echo "0")

while true; do
  SQUEUE=$(squeue --noheader --format="%j %T" 2>/dev/null | grep "$RUN_ID" || true)

  ANY_ACTIVE=false
  for BID in af2-tpu af2-gpu esmfold-tpu esmfold-gpu boltz2-tpu boltz2-gpu; do
    JOB_STATE=$(echo "$SQUEUE" | grep "^${BID}-${RUN_ID}" | awk '{print $2}')
    if [[ -n "$JOB_STATE" ]]; then
      ANY_ACTIVE=true
      update_blob "$BID" "$(slurm_to_lane "$JOB_STATE")"
    fi
  done

  scan_log

  if ! $ANY_ACTIVE; then
    add_event "All jobs exited squeue"
    break
  fi

  sleep "$POLL_INTERVAL"
done
