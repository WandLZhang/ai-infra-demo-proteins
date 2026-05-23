#!/bin/bash
# poll_squeue.sh — Polls squeue, writes live state + events to GCS.
# Runs on the controller VM after predict.sh dispatches jobs.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/env.sh" 2>/dev/null || true

RUN_ID="${1:-}"
if [ -z "$RUN_ID" ]; then
  echo "Usage: poll_squeue.sh <run_id>"
  exit 1
fi
EVENTS_PATH="$SHARED_BUCKET/jobs/$RUN_ID/events.json"
EVENTS_FILE="/tmp/events-${RUN_ID}.json"
POLL_INTERVAL=3
SLURM_LOG="/var/log/slurm/slurmctld.log"
LAST_LOG_BYTES=0

echo "[]" > "$EVENTS_FILE"

declare -A CACHED_STATE

LOG_DIR="$SHARED_BUCKET/jobs/$RUN_ID/log"

add_event() {
  local MSG="$1"
  local TS
  TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local SEQ
  SEQ="$(date +%s%N)"
  echo "{\"ts\":\"$TS\",\"msg\":\"$MSG\"}" | gsutil -q cp - "$LOG_DIR/${SEQ}-slurmctld.json" 2>/dev/null || true
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

  local OLD_STATE="${CACHED_STATE[$BID]:-}"
  [[ "$OLD_STATE" == "done" || "$OLD_STATE" == "failed" ]] && return
  [[ "$OLD_STATE" == "$NEW_STATE" ]] && return

  CACHED_STATE[$BID]="$NEW_STATE"
  local BLOB="$SHARED_BUCKET/jobs/$RUN_ID/$BID.json"
  local NOW SILICON PRICE ELAPSED_MS COST STARTED_AT
  NOW=$(date +%s)
  STARTED_AT=$(date -u -d @$((NOW - 10)) +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)

  # Read started_at from existing blob only on first state change
  if [ -z "$OLD_STATE" ]; then
    STARTED_AT=$(gsutil cat "$BLOB" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('started_at',''))" 2>/dev/null) || true
  fi

  local START_EPOCH
  START_EPOCH=$(date -d "$STARTED_AT" +%s 2>/dev/null || echo "$NOW")
  ELAPSED_MS=$(( (NOW - START_EPOCH) * 1000 ))
  SILICON=$(echo "$BID" | cut -d- -f2)
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
  local CONTENT
  CONTENT=$(tail -c +$((LAST_LOG_BYTES + 1)) "$SLURM_LOG" 2>/dev/null) || return 0
  [ -z "$CONTENT" ] && return 0

  LAST_LOG_BYTES=$(wc -c < "$SLURM_LOG" 2>/dev/null || echo "$LAST_LOG_BYTES")

  while IFS= read -r line; do
    if echo "$line" | grep -q "GCP Error.*capacity"; then
      local NODE REGION
      NODE=$(echo "$line" | grep -o 'node [^ ]*' | head -1 | awk '{print $2}') || true
      REGION=$(echo "$NODE" | sed 's/nihprotein-//' | sed 's/-[0-9]*$//') || true
      add_event "resume: no Spot capacity in $REGION → requeue"
    elif echo "$line" | grep -q "sched.*Allocate"; then
      local NODE PART
      NODE=$(echo "$line" | grep -o 'NodeList=[^ ]*' | head -1 | cut -d= -f2) || true
      PART=$(echo "$line" | grep -o 'Partition=[^ ]*' | head -1 | cut -d= -f2) || true
      add_event "sched: allocate → $NODE ($PART)"
    elif echo "$line" | grep -q "requeue job"; then
      local JOBID
      JOBID=$(echo "$line" | grep -o 'JobId=[0-9]*' | head -1) || true
      add_event "requeue $JOBID → trying next zone"
    elif echo "$line" | grep -q "now responding"; then
      local NODE
      NODE=$(echo "$line" | grep -o 'Node [^ ]*' | head -1 | awk '{print $2}') || true
      add_event "slurmd: $NODE registered"
    fi
  done <<< "$CONTENT"
}

# Initialize log position to current end (only capture new events)
LAST_LOG_BYTES=$(sudo wc -c < "$SLURM_LOG" 2>/dev/null || echo "0")

while true; do
  SQUEUE=$(squeue --noheader --format="%j %T" 2>/dev/null | grep "$RUN_ID" || true)

  ANY_ACTIVE=false
  for BID in af2-tpu af2-gpu esmfold-tpu esmfold-gpu boltz2-tpu boltz2-gpu; do
    JOB_STATE=$(echo "$SQUEUE" | grep "^${BID}-${RUN_ID}" | head -1 | awk '{print $2}')
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
