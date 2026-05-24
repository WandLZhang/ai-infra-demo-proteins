#!/bin/bash
# poll_squeue.sh — Polls squeue, writes live state + events to GCS.
# All state goes to gs://BUCKET/job/ (flat folder).
# Runs as a systemd service on the controller.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/env.sh" 2>/dev/null || true

POLL_INTERVAL=3
SLURM_LOG="/var/log/slurm/slurmctld.log"
LAST_LOG_BYTES=0
JOB_DIR="$SHARED_BUCKET/job"
LOG_DIR="$JOB_DIR/log"

declare -A CACHED_STATE

node_to_region() {
  local NODE="$1"
  case "$NODE" in
    *central1*|*centra*) echo "us-central1" ;;
    *south1*)   echo "us-south1" ;;
    *east5*)    echo "us-east5" ;;
    *east4*)    echo "us-east4" ;;
    *east7*)    echo "us-east7" ;;
    *east1*)    echo "us-east1" ;;
    *west8*)    echo "us-west8" ;;
    *west4*)    echo "us-west4" ;;
    *west3*)    echo "us-west3" ;;
    *west2*)    echo "us-west2" ;;
    *west1*)    echo "us-west1" ;;
    *)          echo "unknown" ;;
  esac
}

add_event() {
  local TYPE="$1"
  local MSG="$2"
  local EXTRA="${3:-}"
  local TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local SEQ=$(date +%s%N)
  local JSON="{\"ts\":\"$TS\",\"type\":\"$TYPE\",\"msg\":\"$MSG\""
  if [[ -n "$EXTRA" ]]; then
    JSON="$JSON,$EXTRA"
  fi
  JSON="$JSON}"
  echo "$JSON" | gsutil -q cp - "$LOG_DIR/${SEQ}-slurmctld.json" 2>/dev/null || true
  echo "[poll] $TS $MSG"
}

scan_log() {
  local CONTENT
  CONTENT=$(tail -c +$((LAST_LOG_BYTES + 1)) "$SLURM_LOG" 2>/dev/null) || return 0
  [ -z "$CONTENT" ] && return 0

  LAST_LOG_BYTES=$(wc -c < "$SLURM_LOG" 2>/dev/null || echo "$LAST_LOG_BYTES")

  while IFS= read -r line; do
    if echo "$line" | grep -q "GCP Error.*capacity"; then
      local NODE NODESET REGION
      NODE=$(echo "$line" | grep -o 'node [^ ]*' | head -1 | awk '{print $2}') || true
      NODESET=$(echo "$NODE" | sed 's/nihprotein-//' | sed 's/-[0-9]*$//') || true
      REGION=$(node_to_region "$NODE")
      add_event "spot_fail" "no Spot capacity in $NODESET — requeuing" \
        "\"vm\":null,\"nodeset\":\"$NODESET\",\"region\":\"$REGION\""
    elif echo "$line" | grep -q "sched.*Allocate"; then
      local NODE PART REGION
      NODE=$(echo "$line" | grep -o 'NodeList=[^ ]*' | head -1 | cut -d= -f2) || true
      PART=$(echo "$line" | grep -o 'Partition=[^ ]*' | head -1 | cut -d= -f2) || true
      REGION=$(node_to_region "$NODE")
      add_event "sched_allocate" "sched: allocate $NODE ($PART)" \
        "\"vm\":\"$NODE\",\"region\":\"$REGION\",\"partition\":\"$PART\""
    elif echo "$line" | grep -q "requeue job"; then
      local JOBID
      JOBID=$(echo "$line" | grep -o 'JobId=[0-9]*' | head -1) || true
      add_event "requeue" "requeue $JOBID — trying next zone" \
        "\"job_id\":\"$JOBID\""
    fi
  done <<< "$CONTENT"
}

# Initialize log position to current end (only capture new events)
LAST_LOG_BYTES=$(sudo wc -c < "$SLURM_LOG" 2>/dev/null || echo "0")

echo "[poll_squeue] watching slurmctld.log from byte $LAST_LOG_BYTES"

while true; do
  # Check if any protein-demo jobs are active
  SQUEUE=$(squeue --noheader --format="%j %T" 2>/dev/null | grep -E "^(af2|esmfold|boltz2)-" || true)

  scan_log

  if [ -z "$SQUEUE" ]; then
    # No active jobs — check if a manifest exists (run was started)
    if gsutil -q stat "$JOB_DIR/manifest.json" 2>/dev/null; then
      add_event "complete" "All jobs exited squeue"
    fi
    sleep 10
  else
    sleep "$POLL_INTERVAL"
  fi
done
