#!/bin/bash
# predict.sh — sbatch entrypoint for the NIH Biowulf demo.
#
# Dispatches 6 parallel inference jobs (3 models × 2 silicons) across
# Slurm partitions in the burst project. Each job writes progress to
# GCS blobs that the frontend polls for live updates.
#
# Usage:
#   sbatch predict.sh [protein_id]
#   # or directly:
#   bash scripts/predict.sh brca1
#
# The script is idempotent: if a run is already in progress (checked via
# GCS), it prints the existing run_id instead of resubmitting.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/env.sh"

PROTEIN_ID="${1:-hemoglobin}"
RUN_ID="${RUN_ID_OVERRIDE:-$(date +%Y%m%d-%H%M%S)}"
JOBS_PREFIX="jobs/$RUN_ID"

# Protein sequences (same as frontend PROTEINS array)
declare -A SEQUENCES
SEQUENCES=(
  [brca1]="NAMEESVSREKPELTASTERVNKRMSLVLNQHSSRSEVFPEVSIFVDKRPESSRLSEAIRKQHVAMLISELPDHTSSLRQINEQLKVHQEETHLASCDPQRRSYLEFQQFNGIDSKVTKESLYFILAENLHDQYFDGRSLKLNKPFVCSKRVQCSCQKFKEATAVQGLHTQCFNQTPLRDDQDMVETDVWQLSNLECNTLQKLTSDIYQELAQTFGFLDVLWQCSKAGHQGLEKYLDTYLNHTFKQSQLEATLQGFKTDL"
  [p53]="SSSVPSQKTYQGSYGFRLGFLHSGTAKSVTCTYSPALNKMFCQLAKTCPVQLWVDSTPPPGTRVRAMAIYKQSQHMTEVVRRCPHERCTEGDGLAPPQHLIRVEGNLHAEYLDDKQTKFPQELPHRINKRPELKQIRKR"
  [hemoglobin]="MVLSPADKTNVKAAWGKVGAHAGEYGAEALERMFLSFPTTKTYFPHFDLSHGSAQVKGHGKKVADALTNAVAHVDDMPNALSALSDLHAHKLRVDPVNFKLLSHCLLVTLAAHLPAEFTPAVHASLDKFLASVSTVLTSKYR"
  [insulin]="LRELGQGSFGMVYEGNARDIIKGEAETRVAVKTVNESASLRERIEFLNEASVMKGFTCHHVVRLLGVVSKGQPTLVVMELMAHGDLKSYLRSLRPEAENNPGRPPPTLQEMIQMAAEIADGMAYLNAKKFVHRDLAARNCMVAH"
)

SEQUENCE="${SEQUENCES[$PROTEIN_ID]:-${SEQUENCES[hemoglobin]}}"

# All 6 backends
BACKENDS=("af2-tpu" "af2-gpu" "esmfold-tpu" "esmfold-gpu" "boltz2-tpu" "boltz2-gpu")

echo "=== predict.sh ==="
echo "Run ID:   $RUN_ID"
echo "Protein:  $PROTEIN_ID (${#SEQUENCE} aa)"
echo "Backends: ${BACKENDS[*]}"
echo "Bucket:   $SHARED_BUCKET/$JOBS_PREFIX/"
echo ""

# Clean slate: cancel any existing jobs from previous runs, reset downed nodes
if command -v scancel &>/dev/null; then
  scancel --user="$(whoami)" --quiet 2>/dev/null || true
  scontrol update NodeName=ALL State=IDLE 2>/dev/null || true
fi

# Write the run manifest (so frontend can discover this run)
cat <<EOF | gsutil -q cp - "$SHARED_BUCKET/$JOBS_PREFIX/manifest.json"
{
  "run_id": "$RUN_ID",
  "protein_id": "$PROTEIN_ID",
  "sequence_length": ${#SEQUENCE},
  "backends": ["${BACKENDS[0]}","${BACKENDS[1]}","${BACKENDS[2]}","${BACKENDS[3]}","${BACKENDS[4]}","${BACKENDS[5]}"],
  "submitted_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "status": "running"
}
EOF

# Dispatch each backend as a separate Slurm job
for BACKEND in "${BACKENDS[@]}"; do
  # Determine partition from backend name
  MODEL=$(echo "$BACKEND" | cut -d- -f1)
  SILICON=$(echo "$BACKEND" | cut -d- -f2)

  if [[ "$SILICON" == "tpu" ]]; then
    PARTITION="tpu"
  else
    PARTITION="gpu"
  fi

  # Write initial queued state to GCS
  cat <<EOF | gsutil -q cp - "$SHARED_BUCKET/$JOBS_PREFIX/$BACKEND.json"
{
  "backend_id": "$BACKEND",
  "run_id": "$RUN_ID",
  "protein_id": "$PROTEIN_ID",
  "state": "queued",
  "started_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "completed_at": null,
  "elapsed_ms": 0,
  "cost_accumulated": 0.0,
  "result": null,
  "error": null
}
EOF

  # Submit Slurm job
  JOB_CMD="bash $SCRIPT_DIR/run_backend.sh $BACKEND $RUN_ID $PROTEIN_ID"

  if command -v sbatch &>/dev/null; then
    SLURM_JOB_ID=$(sbatch --parsable \
      --partition="$PARTITION" \
      --job-name="${BACKEND}-${RUN_ID}" \
      --output="/tmp/slurm-${BACKEND}-${RUN_ID}.log" \
      --wrap="$JOB_CMD" 2>&1)
    echo "Submitted $BACKEND → partition=$PARTITION, job=$SLURM_JOB_ID"
  else
    # No Slurm available — run directly (for local testing)
    echo "Submitted $BACKEND → direct (no Slurm)"
    bash "$SCRIPT_DIR/run_backend.sh" "$BACKEND" "$RUN_ID" "$PROTEIN_ID" &
  fi
done

echo ""
echo "Run ID: $RUN_ID"
echo "Monitor: gsutil ls $SHARED_BUCKET/$JOBS_PREFIX/"
