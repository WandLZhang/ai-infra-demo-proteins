#!/bin/bash
# predict.sh — sbatch entrypoint for the NIH Biowulf demo.
#
# Dispatches 6 parallel inference jobs (3 models × 2 silicons) across
# Slurm partitions in the burst project. Each job writes progress to
# GCS blobs that the frontend polls for live updates.
#
# All state goes to gs://BUCKET/job/ (flat — no run ID subfolders).
# Frontend polls this single folder. On new submit, old blobs are cleared first.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/env.sh"

PROTEIN_ID="${1:-hemoglobin}"
JOB_DIR="$SHARED_BUCKET/job"

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
echo "Protein:  $PROTEIN_ID (${#SEQUENCE} aa)"
echo "Backends: ${BACKENDS[*]}"
echo "Bucket:   $JOB_DIR/"
echo ""

# Clear previous run (explicit prefix, not glob)
gsutil -q -m rm -r "$JOB_DIR" 2>/dev/null || true

# Reset Spot nodes so Slurm tries them each run (shows failover in demo)
if command -v scontrol &>/dev/null; then
  for NODE in nihprotein-tpuv6eeast5a-1 nihprotein-tpuv6ecentral1-1 \
              nihprotein-a100spotcentra-1 nihprotein-a100west1-1; do
    scontrol update NodeName=$NODE State=IDLE 2>/dev/null || true
  done
fi

# Write manifest
cat <<EOF | gsutil -q cp - "$JOB_DIR/manifest.json"
{
  "protein_id": "$PROTEIN_ID",
  "sequence_length": ${#SEQUENCE},
  "backends": ["${BACKENDS[0]}","${BACKENDS[1]}","${BACKENDS[2]}","${BACKENDS[3]}","${BACKENDS[4]}","${BACKENDS[5]}"],
  "submitted_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "status": "running"
}
EOF

# Dispatch each backend as a separate Slurm job
for BACKEND in "${BACKENDS[@]}"; do
  MODEL=$(echo "$BACKEND" | cut -d- -f1)
  SILICON=$(echo "$BACKEND" | cut -d- -f2)
  if [[ "$SILICON" == "tpu" ]]; then
    PARTITION="tpu"
  else
    PARTITION="gpu"
  fi

  # Write initial queued state
  cat <<EOF | gsutil -q cp - "$JOB_DIR/$BACKEND.json"
{
  "backend_id": "$BACKEND",
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

  JOB_CMD="export HOME=/tmp; rm -rf /tmp/protein-demo 2>/dev/null; mkdir -p /tmp/protein-demo; gsutil -q cp gs://wz-nih-demo-shared/scripts/run_backend.sh gs://wz-nih-demo-shared/scripts/env.sh /tmp/protein-demo/ 2>/dev/null; chmod +x /tmp/protein-demo/run_backend.sh 2>/dev/null; bash /tmp/protein-demo/run_backend.sh $BACKEND $PROTEIN_ID"

  if command -v sbatch &>/dev/null; then
    SLURM_JOB_ID=$(sbatch --parsable \
      --partition="$PARTITION" \
      --job-name="${BACKEND}" \
      --output="/dev/null" \
      --error="/dev/null" \
      --wrap="$JOB_CMD" 2>&1)
    echo "Submitted $BACKEND → partition=$PARTITION, job=$SLURM_JOB_ID"
    TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    SEQ="$(date +%s%N)"
    echo "{\"ts\":\"$TS\",\"type\":\"dispatch\",\"backend\":\"$BACKEND\",\"partition\":\"$PARTITION\",\"job_id\":\"$SLURM_JOB_ID\",\"msg\":\"sbatch $BACKEND → $PARTITION (job $SLURM_JOB_ID)\"}" | gsutil -q cp - "$JOB_DIR/log/${SEQ}-dispatch.json" 2>/dev/null || true
  else
    echo "Submitted $BACKEND → direct (no Slurm)"
    bash "$SCRIPT_DIR/run_backend.sh" "$BACKEND" "$PROTEIN_ID" &
  fi
done

echo ""
echo "Monitor: gsutil ls $JOB_DIR/"
