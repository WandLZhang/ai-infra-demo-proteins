#!/bin/bash
# run_backend.sh — per-backend Slurm job that runs inference and writes GCS state.
#
# Called by predict.sh (via sbatch --wrap or directly).
# All state goes to gs://BUCKET/job/ (flat folder, no run ID).
#
# Usage: bash run_backend.sh <backend_id> <protein_id>

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/env.sh" 2>/dev/null || source /tmp/protein-demo/env.sh 2>/dev/null || true

BACKEND_ID="${1:?backend_id required}"
PROTEIN_ID="${2:?protein_id required}"

JOB_DIR="$SHARED_BUCKET/job"
BLOB_PATH="$JOB_DIR/$BACKEND_ID.json"
MODEL=$(echo "$BACKEND_ID" | cut -d- -f1)
SILICON=$(echo "$BACKEND_ID" | cut -d- -f2)

# Protein sequences
declare -A SEQUENCES
SEQUENCES=(
  [brca1]="NAMEESVSREKPELTASTERVNKRMSLVLNQHSSRSEVFPEVSIFVDKRPESSRLSEAIRKQHVAMLISELPDHTSSLRQINEQLKVHQEETHLASCDPQRRSYLEFQQFNGIDSKVTKESLYFILAENLHDQYFDGRSLKLNKPFVCSKRVQCSCQKFKEATAVQGLHTQCFNQTPLRDDQDMVETDVWQLSNLECNTLQKLTSDIYQELAQTFGFLDVLWQCSKAGHQGLEKYLDTYLNHTFKQSQLEATLQGFKTDL"
  [p53]="SSSVPSQKTYQGSYGFRLGFLHSGTAKSVTCTYSPALNKMFCQLAKTCPVQLWVDSTPPPGTRVRAMAIYKQSQHMTEVVRRCPHERCTEGDGLAPPQHLIRVEGNLHAEYLDDKQTKFPQELPHRINKRPELKQIRKR"
  [hemoglobin]="MVLSPADKTNVKAAWGKVGAHAGEYGAEALERMFLSFPTTKTYFPHFDLSHGSAQVKGHGKKVADALTNAVAHVDDMPNALSALSDLHAHKLRVDPVNFKLLSHCLLVTLAAHLPAEFTPAVHASLDKFLASVSTVLTSKYR"
  [insulin]="LRELGQGSFGMVYEGNARDIIKGEAETRVAVKTVNESASLRERIEFLNEASVMKGFTCHHVVRLLGVVSKGQPTLVVMELMAHGDLKSYLRSLRPEAENNPGRPPPTLQEMIQMAAEIADGMAYLNAKKFVHRDLAARNCMVAH"
)
SEQUENCE="${SEQUENCES[$PROTEIN_ID]:-${SEQUENCES[hemoglobin]}}"

# Pricing
if [[ "$SILICON" == "tpu" ]]; then
  PRICE_PER_SEC="$TPU_PRICE_PER_SEC"
else
  PRICE_PER_SEC="$GPU_A100_PRICE_PER_SEC"
fi

LOG_DIR="$JOB_DIR/log"
START_TIME=$(date +%s)

# Get VM identity — SLURMD_NODENAME is the Slurm node name (matches sched_allocate events).
# For TPU VMs, the GCE instance name (from metadata) is the TPU worker name (t1v-n-...),
# NOT the Slurm node name. SLURMD_NODENAME gives us the right name for both TPU and GPU.
VM_NAME="${SLURMD_NODENAME:-$(curl -sf --connect-timeout 2 --max-time 5 -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/name 2>/dev/null || hostname)}"
FULL_ZONE=$(curl -sf --connect-timeout 2 --max-time 5 -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/zone 2>/dev/null | awk -F/ '{print $NF}' || echo "unknown")
GCE_PROJECT=$(curl -sf --connect-timeout 2 --max-time 5 -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/project/project-id 2>/dev/null || echo "$BURST_PROJECT_ID")
REGION=$(echo "$FULL_ZONE" | sed 's/-[a-z]$//')

log_event() {
  local TYPE="$1"
  local MSG="$2"
  local EXTRA="${3:-}"
  local TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local SEQ=$(date +%s%N)
  local JSON="{\"ts\":\"$TS\",\"type\":\"$TYPE\",\"backend\":\"$BACKEND_ID\",\"vm\":\"$VM_NAME\",\"zone\":\"$FULL_ZONE\",\"region\":\"$REGION\",\"partition\":\"$SILICON\",\"project\":\"$GCE_PROJECT\",\"msg\":\"$MSG\""
  if [[ -n "$EXTRA" ]]; then
    JSON="$JSON,$EXTRA"
  fi
  JSON="$JSON}"
  echo "$JSON" | gsutil -q cp - "$LOG_DIR/${SEQ}-${BACKEND_ID}.json" 2>/dev/null || true
  echo "[$BACKEND_ID] $MSG"
}

update_state() {
  local STATE="$1"
  local EXTRA="${2:-}"
  local NOW=$(date +%s)
  local ELAPSED_MS=$(( (NOW - START_TIME) * 1000 ))
  local COST=$(printf "%.4f" "$(echo "$ELAPSED_MS * $PRICE_PER_SEC / 1000" | bc -l 2>/dev/null || echo "0")")

  local COMPLETED="null"
  local RESULT="null"
  local ERROR="null"

  if [[ "$STATE" == "done" || "$STATE" == "failed" ]]; then
    COMPLETED="\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""
  fi
  if [[ -n "$EXTRA" ]]; then
    if [[ "$STATE" == "done" ]]; then
      RESULT="$EXTRA"
    elif [[ "$STATE" == "failed" ]]; then
      ERROR="\"$EXTRA\""
    fi
  fi

  cat <<EOF | gsutil -q cp - "$BLOB_PATH"
{
  "backend_id": "$BACKEND_ID",
  "protein_id": "$PROTEIN_ID",
  "state": "$STATE",
  "started_at": "$(date -u -d @$START_TIME +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)",
  "completed_at": $COMPLETED,
  "elapsed_ms": $ELAPSED_MS,
  "cost_accumulated": $COST,
  "result": $RESULT,
  "error": $ERROR
}
EOF
  echo "[${BACKEND_ID}] state → $STATE (${ELAPSED_MS}ms, \$$COST)"
}

# Write FASTA file for this job
FASTA_PATH="/tmp/${BACKEND_ID}.fasta"
echo ">A|protein" > "$FASTA_PATH"
echo "$SEQUENCE" >> "$FASTA_PATH"

# ── Phase 1: Allocating ─────────────────────────────────────────────
log_event "allocate" "allocating on $VM_NAME ($SILICON)"
update_state "allocating"

# ── Phase 2: Loading model ───────────────────────────────────────────
log_event "loading" "loading model weights"
update_state "loading"
sleep 1

# ── Phase 3: Inferring ───────────────────────────────────────────────
log_event "inferring" "inferring $PROTEIN_ID (${#SEQUENCE}aa)" "\"protein_id\":\"$PROTEIN_ID\",\"seq_len\":${#SEQUENCE}"
update_state "inferring"

# Run the actual predict script based on backend type
RESULT_DIR="/tmp/result-${BACKEND_ID}"
mkdir -p "$RESULT_DIR"

PREDICT_SCRIPT="$SCRIPT_DIR/../backends/$BACKEND_ID/predict.py"

if [[ -f "$PREDICT_SCRIPT" ]]; then
  set +e
  if [[ "$SILICON" == "tpu" ]]; then
    PJRT_DEVICE=TPU python3 "$PREDICT_SCRIPT" "$FASTA_PATH" --out-dir "$RESULT_DIR" 2>&1 | tee "/tmp/${BACKEND_ID}.log"
    EXIT_CODE=$?
  else
    python3 "$PREDICT_SCRIPT" "$FASTA_PATH" --out-dir "$RESULT_DIR" 2>&1 | tee "/tmp/${BACKEND_ID}.log"
    EXIT_CODE=$?
  fi
  set -e

  if [[ $EXIT_CODE -ne 0 ]]; then
    update_state "failed" "predict.py exited with code $EXIT_CODE"
    exit 1
  fi

  OUTPUT_FILE=$(find "$RESULT_DIR" -name "*.pdb" -o -name "*.cif" 2>/dev/null | head -1)
  if [[ -z "$OUTPUT_FILE" ]]; then
    update_state "failed" "No PDB/CIF output produced"
    exit 1
  fi

  OUTPUT_CHARS=$(wc -c < "$OUTPUT_FILE")
  OUTPUT_EXT="${OUTPUT_FILE##*.}"
  GCS_OUTPUT_PATH="$JOB_DIR/${BACKEND_ID}.${OUTPUT_EXT}"
  gsutil -q cp "$OUTPUT_FILE" "$GCS_OUTPUT_PATH"
else
  echo "[${BACKEND_ID}] predict.py not staged yet, writing state progression"
  sleep 3
  GCS_OUTPUT_PATH=""
  OUTPUT_CHARS=0
fi

# ── Phase 4: Done ────────────────────────────────────────────────────
NOW=$(date +%s)
ELAPSED_MS=$(( (NOW - START_TIME) * 1000 ))
COST=$(printf "%.10f" "$(echo "$ELAPSED_MS * $PRICE_PER_SEC / 1000" | bc -l 2>/dev/null || echo "0")")
RESULT_JSON="{\"output_gcs_path\":\"$GCS_OUTPUT_PATH\",\"output_chars\":$OUTPUT_CHARS,\"solve_time_ms\":$ELAPSED_MS,\"model\":\"$MODEL\",\"silicon\":\"$SILICON\",\"seq_len\":${#SEQUENCE}}"

update_state "done" "$RESULT_JSON"
log_event "done" "done — ${ELAPSED_MS}ms \$$COST" "\"elapsed_ms\":$ELAPSED_MS,\"cost\":$COST"
