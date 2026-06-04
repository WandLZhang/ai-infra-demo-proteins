#!/bin/bash
# run_backend.sh — per-backend Slurm job that runs inference and writes GCS state.
#
# Called by predict.sh (via sbatch --wrap or directly).
# All state goes to gs://BUCKET/job/ (flat folder, no run ID).
#
# Usage: bash run_backend.sh <backend_id> <protein_id>

set -uo
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
  [ace2]="STIEEQAKTFLDKFNHEAEDLFYQSSLASWNYNTNITEENVQNMNNAGDKWSAFLKEQSTLAQMYPLQEIQNLTVKLQLQALQQNGSSVLSEDKSKRLNTILNTMSTIYSTGKVCNPDNPQECLLLEPGLNEIMANSLDYNERLWAWESWRSEVGKQLRPLYEEYVVLKNEMARANHYEDYGDYWRGDYEVNGVDGYDYSRGQLIEDVEHTFEEIKPLYEHLHAYVRAKLMNAYPSYISPIGCLPAHLLGDMWGRFWTNLYSLTVPFGQKPNIDVTDAMVDQAWDAQRIFKEAEKFFVSVGLPNMTQGFWENSMLTDPGNVQKAVCHPTAWDLGKGDFRILMCTKVTMDDFLTAHHEMGHIQYDMAYAAQPFLLRNGANEGFHEAVGEIMSLSAATPKHLKSIGLLSPDFQEDNETEINFLLKQALTIVGTLPFTYMLEKWRWMVFKGEIPKDQWMKKWWEMKREIVGVVEPVPHDETYCDPASLFHVSNDYSFIRYYTRTLYQFQFQEALCQAAKHEGPLHKCDISNSTEAGQKLFNMLRLGKSEPWTLALENVVGAKNMNVRPLLNYFEPLFTWLKDQNKNSFVGWSTDWSPYAD"
  [hemoglobin]="MVLSPADKTNVKAAWGKVGAHAGEYGAEALERMFLSFPTTKTYFPHFDLSHGSAQVKGHGKKVADALTNAVAHVDDMPNALSALSDLHAHKLRVDPVNFKLLSHCLLVTLAAHLPAEFTPAVHASLDKFLASVSTVLTSKYR"
  [insulin]="LRELGQGSFGMVYEGNARDIIKGEAETRVAVKTVNESASLRERIEFLNEASVMKGFTCHHVVRLLGVVSKGQPTLVVMELMAHGDLKSYLRSLRPEAENNPGRPPPTLQEMIQMAAEIADGMAYLNAKKFVHRDLAARNCMVAH"
  [cftr]="FSLLGTPVLKDINFKIERGQLLAVAGSTGAGKTSLLMVIMGELEPSEGKIKHSGRISFCSQFSWIMPGTIKENIIFGVSYDEYRYRSVIKACQLEEDISKFAEKDNIVLGEGGITLSGGQRARISLARAVYKDADLYLLDSPFGYLDVLTEKEIFESCVCKLMANKTRILVTSKMEHLKKADKILILHEGSSYFYGTFSELQNLQPDFSSKLMGCDSFDQFSAERRNSILTETLHRFSLEGDAPVSWTETK"
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

# Point HuggingFace + Boltz caches to root's pre-warmed cache (HOME=/tmp in sbatch)
export HF_HOME=/root/.cache/huggingface
export BOLTZ_CACHE=/tmp/.boltz

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

# Write FASTA file for this job (remove stale root-owned files first)
FASTA_PATH="/tmp/${BACKEND_ID}.fasta"
rm -f "$FASTA_PATH" "/tmp/${BACKEND_ID}.log" 2>/dev/null || true
echo ">A|protein" > "$FASTA_PATH"
echo "$SEQUENCE" >> "$FASTA_PATH"

# AF2-TPU runs on a SEPARATE TPU VM (east5b) — no VFIO conflict with model server.
# ESMFold-TPU and Boltz2-TPU run on east5a where the model server stays warm.

# ── Phase 1: Allocating ─────────────────────────────────────────────
log_event "allocate" "allocating on $VM_NAME ($SILICON)"
update_state "allocating"

# ── Phase 2: Loading model ───────────────────────────────────────────
log_event "loading" "loading model weights"
update_state "loading"

# ESMFold/Boltz2-TPU depend on a warm model server — wait up to 120s for it.
# ESMFold server runs on this VM (localhost:8090).
# Boltz-2 server runs on the dedicated east5a-3 v6e at $BOLTZ_HOST:$BOLTZ_PORT.
if [[ "$SILICON" == "tpu" && "$BACKEND_ID" != "af2-tpu" ]]; then
  SERVER_HOST="localhost"
  SERVER_PORT=8090
  if [[ "$MODEL" == "boltz2" ]]; then
    SERVER_HOST="${BOLTZ_HOST:-10.202.0.23}"
    SERVER_PORT="${BOLTZ_PORT:-8091}"
  fi
  HEALTH_URL="http://${SERVER_HOST}:${SERVER_PORT}/"
  for i in $(seq 1 120); do
    curl -sf -m 3 "$HEALTH_URL" > /dev/null 2>&1 && break
    sleep 1
  done
  if ! curl -sf -m 3 "$HEALTH_URL" > /dev/null 2>&1; then
    log_event "error" "model server not ready after 120s at $HEALTH_URL"
    update_state "failed" "model server not ready at $HEALTH_URL"
    exit 1
  fi
  echo "[${BACKEND_ID}] model server ready at $HEALTH_URL"
fi

# ── Phase 3: Inferring ───────────────────────────────────────────────
log_event "inferring" "inferring $PROTEIN_ID (${#SEQUENCE}aa)" "\"protein_id\":\"$PROTEIN_ID\",\"seq_len\":${#SEQUENCE}"
update_state "inferring"

# Run the actual predict script based on backend type
RESULT_DIR="/tmp/result-${BACKEND_ID}"
rm -rf "$RESULT_DIR" 2>/dev/null || true
mkdir -p "$RESULT_DIR"
# Warm model servers run as slurmuser (uid 1015145168) and need to write
# the PDB/CIF into this dir on behalf of root-launched predict.py jobs.
chmod 777 "$RESULT_DIR"

# Tell the keep-warm cron that the TPU is in use, so it doesn't compete.
# Cleared in the Phase 4 cleanup below.
if [[ "$SILICON" == "tpu" ]]; then
  touch /tmp/tpu-busy 2>/dev/null || true
fi

# Prefer GCS-fetched override (lets us hot-patch without rebuilding the container).
# Falls back to baked-in /opt/backends/ copy, then the repo-relative path.
PREDICT_SCRIPT="/tmp/protein-demo/backends/$BACKEND_ID/predict.py"
if [[ ! -s "$PREDICT_SCRIPT" ]]; then
  PREDICT_SCRIPT="/opt/backends/$BACKEND_ID/predict.py"
fi
if [[ ! -f "$PREDICT_SCRIPT" ]]; then
  PREDICT_SCRIPT="$SCRIPT_DIR/../backends/$BACKEND_ID/predict.py"
fi
echo "[${BACKEND_ID}] using predict.py: $PREDICT_SCRIPT"

if [[ -f "$PREDICT_SCRIPT" ]]; then
  set +e
  EXTRA_ARGS=""
  if [[ "$MODEL" == "af2" ]]; then
    EXTRA_ARGS="--protein-id $PROTEIN_ID"
  fi
  # AF2-TPU uses isolated JAX venv (avoids torch_xla libtpu conflict)
  # Must kill model server first to release VFIO, restart after
  if [[ "$BACKEND_ID" == "af2-tpu" ]]; then
    log_event "vfio_release" "killing model server for JAX VFIO access"
    echo '{"status":"loading"}' | gsutil -q cp - "$SHARED_BUCKET/tpu-status.json" 2>/dev/null || true
    # Kill all variants of the warm ESMFold server. The pidfile may be empty
    # (docker exec -d's $! doesn't propagate), so don't rely on it alone.
    kill -9 $(cat /tmp/tpu-model-server.pid 2>/dev/null) 2>/dev/null || true
    sleep 1
    pkill -9 -f "tpu-esmfold-server" 2>/dev/null || true
    pkill -9 -f "tpu-model-server" 2>/dev/null || true
    pkill -9 -f "tpu-boltz2-server" 2>/dev/null || true
    pkill -9 -f "libtpu" 2>/dev/null || true
    rm -f /tmp/libtpu_lockfile 2>/dev/null
    sleep 8
    PYTHON_BIN="/tmp/jax-venv/bin/python3"
    if [[ ! -f "$PYTHON_BIN" ]]; then PYTHON_BIN="python3"; fi
    $PYTHON_BIN "$PREDICT_SCRIPT" "$FASTA_PATH" --out-dir "$RESULT_DIR" $EXTRA_ARGS 2>&1 | tee "/tmp/${BACKEND_ID}.log"
    EXIT_CODE=$?
  elif [[ "$SILICON" == "tpu" ]]; then
    # Boltz-2 client talks to the warm server on east5a-3; ESMFold client talks to localhost
    export BOLTZ_HOST="${BOLTZ_HOST:-10.202.0.23}"
    export BOLTZ_PORT="${BOLTZ_PORT:-8091}"
    PJRT_DEVICE=TPU BOLTZ_HOST="$BOLTZ_HOST" BOLTZ_PORT="$BOLTZ_PORT" \
      python3 "$PREDICT_SCRIPT" "$FASTA_PATH" --out-dir "$RESULT_DIR" $EXTRA_ARGS 2>&1 | tee "/tmp/${BACKEND_ID}.log"
    EXIT_CODE=$?
  else
    python3 "$PREDICT_SCRIPT" "$FASTA_PATH" --out-dir "$RESULT_DIR" $EXTRA_ARGS 2>&1 | tee "/tmp/${BACKEND_ID}.log"
    EXIT_CODE=$?
  fi
  set -e

  # Check for output files even if exit code is non-zero (Boltz writer may crash after producing CIF)
  OUTPUT_FILE=$(find "$RESULT_DIR" -name "*.pdb" -o -name "*.cif" 2>/dev/null | head -1)
  if [[ $EXIT_CODE -ne 0 && -z "$OUTPUT_FILE" ]]; then
    update_state "failed" "predict.py exited with code $EXIT_CODE"
    exit 1
  fi
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

# Release TPU VFIO handles and lockfile so the next job can access the device
if [[ "$SILICON" == "tpu" ]]; then
  pkill -f "python3.*predict.py" 2>/dev/null || true
  rm -f /tmp/libtpu_lockfile /tmp/tpu-busy 2>/dev/null || true
  # After AF2-TPU, restart ESMFold server (kill released VFIO; new server takes it)
  # Start as slurmuser, eager mode (no 30 min cold compile).
  # Also kick off all-6-protein prewarm so badge auto-flips back to "ready".
  if [[ "$BACKEND_ID" == "af2-tpu" ]]; then
    log_event "server_restart" "restarting ESMFold server + prewarming all 6 proteins"
    echo '{"status":"loading"}' | gsutil -q cp - "$SHARED_BUCKET/tpu-status.json" 2>/dev/null || true
    rm -f /tmp/libtpu_lockfile /tmp/tpu-model-server.pid /tmp/tpu-prewarm-done 2>/dev/null
    sleep 2
    setsid runuser -u slurmuser -- bash -c 'cd /opt/backends && HOME=/tmp PJRT_DEVICE=TPU HF_HOME=/root/.cache/huggingface BOLTZ_CACHE=/tmp/.boltz NUMBA_CACHE_DIR=/tmp/numba_cache python3 -u tpu-esmfold-server.py > /tmp/tpu-model-server.log 2>&1 & echo $! > /tmp/tpu-model-server.pid' &
    disown
    # Fire prewarm-all once server is up; it writes status=ready at end
    setsid bash -c "for i in \$(seq 1 120); do curl -sf -m 3 http://localhost:8090/ > /dev/null 2>&1 && break; sleep 1; done; gsutil -q cp $SHARED_BUCKET/scripts/prewarm_all_proteins.sh /tmp/prewarm_all_proteins.sh && bash /tmp/prewarm_all_proteins.sh > /tmp/tpu-prewarm.log 2>&1" &
    disown
    echo "[af2-tpu] ESMFold restart + prewarm started in background"
  fi
fi
