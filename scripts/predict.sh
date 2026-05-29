#!/bin/bash
# predict.sh — sbatch entrypoint for the NIH Biowulf demo.
#
# Two-phase submission:
#   Phase 1: Submit all 6 to Spot partitions (spot-tpu, spot-gpu). Shows Spot attempt.
#   Phase 2: After timeout, any still-pending jobs get cancelled and resubmitted
#            to guaranteed partitions (tpu, gpu). If Spot succeeded, jobs stay.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/env.sh"

# Guard: skip if jobs are already running (prevents double-submission from frontend)
if command -v squeue &>/dev/null; then
  RUNNING=$(squeue --noheader --partition=tpu,gpu,spot-tpu,spot-gpu 2>/dev/null | wc -l)
  if [[ "$RUNNING" -gt 0 ]]; then
    echo "predict.sh: $RUNNING jobs already in queue — skipping"
    exit 0
  fi
fi

PROTEIN_ID="${1:-hemoglobin}"
JOB_DIR="$SHARED_BUCKET/job"

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

BACKENDS=("af2-tpu" "esmfold-tpu" "boltz2-tpu" "af2-gpu" "esmfold-gpu" "boltz2-gpu")

echo "=== predict.sh ==="
echo "Protein:  $PROTEIN_ID (${#SEQUENCE} aa)"
echo "Backends: ${BACKENDS[*]}"
echo ""

# Clear previous run
gsutil -q -m rm -r "$JOB_DIR" 2>/dev/null || true

# Reset Spot nodes
if command -v scontrol &>/dev/null; then
  scontrol update NodeName=nihprotein-tpuv6ewest1c-0 State=IDLE 2>/dev/null || true
  scontrol update NodeName=nihprotein-a100spoteast5-0 State=IDLE 2>/dev/null || true
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

# Write initial queued state for all backends
for BACKEND in "${BACKENDS[@]}"; do
  cat <<EOF | gsutil -q cp - "$JOB_DIR/$BACKEND.json" &
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
done
wait

build_wrap() {
  local BACKEND="$1"
  echo "export HOME=/tmp; ulimit -l unlimited 2>/dev/null; mkdir -p /tmp/tpu_logs 2>/dev/null; chmod 777 /tmp/tpu_logs 2>/dev/null; rm -rf /tmp/protein-demo 2>/dev/null; mkdir -p /tmp/protein-demo; gsutil -q cp gs://wz-nih-demo-shared/scripts/run_backend.sh gs://wz-nih-demo-shared/scripts/env.sh /tmp/protein-demo/ 2>/dev/null; chmod +x /tmp/protein-demo/run_backend.sh 2>/dev/null; bash /tmp/protein-demo/run_backend.sh $BACKEND $PROTEIN_ID"
}

# ── Phase 1: Submit all to Spot partitions ──
declare -A SPOT_JOBS
echo "Phase 1: trying Spot..."
for BACKEND in "${BACKENDS[@]}"; do
  SILICON=$(echo "$BACKEND" | cut -d- -f2)
  if [[ "$SILICON" == "tpu" ]]; then PARTITION="spot-tpu"; else PARTITION="spot-gpu"; fi

  JOB_CMD=$(build_wrap "$BACKEND")
  SLURM_JOB_ID=$(sbatch --parsable \
    --partition="$PARTITION" \
    --job-name="${BACKEND}" \
    --output="/dev/null" \
    --error="/dev/null" \
    --wrap="$JOB_CMD" 2>&1)
  SPOT_JOBS[$BACKEND]="$SLURM_JOB_ID"
  echo "  Spot: $BACKEND → $PARTITION (job $SLURM_JOB_ID)"

  TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  SEQ="$(date +%s%N)"
  echo "{\"ts\":\"$TS\",\"type\":\"dispatch\",\"backend\":\"$BACKEND\",\"partition\":\"$PARTITION\",\"job_id\":\"$SLURM_JOB_ID\",\"msg\":\"sbatch $BACKEND → $PARTITION (job $SLURM_JOB_ID)\"}" | gsutil -q cp - "$JOB_DIR/log/${SEQ}-dispatch.json" 2>/dev/null || true &
done
wait

# ── Wait for Spot to resolve (succeed or timeout) ──
SPOT_WAIT=65
echo "Waiting ${SPOT_WAIT}s for Spot..."
sleep "$SPOT_WAIT"

# ── Phase 2: Check results, resubmit failures to guaranteed ──
echo "Phase 2: checking Spot results..."
PREV_TPU_JOB=""
for BACKEND in "${BACKENDS[@]}"; do
  JOB_ID="${SPOT_JOBS[$BACKEND]}"
  JOB_STATE=$(scontrol show job "$JOB_ID" 2>/dev/null | grep -oP 'JobState=\K\S+')

  if [[ "$JOB_STATE" == "COMPLETED" || "$JOB_STATE" == "RUNNING" ]]; then
    echo "  $BACKEND: Spot succeeded (state=$JOB_STATE)"
    continue
  fi

  # Spot failed — cancel and resubmit to guaranteed
  echo "  $BACKEND: Spot failed (state=$JOB_STATE) → resubmitting to guaranteed"
  scancel "$JOB_ID" 2>/dev/null || true

  SILICON=$(echo "$BACKEND" | cut -d- -f2)
  if [[ "$SILICON" == "tpu" ]]; then PARTITION="tpu"; else PARTITION="gpu"; fi

  JOB_CMD=$(build_wrap "$BACKEND")
  DEP_FLAG=""
  if [[ "$SILICON" == "tpu" && -n "$PREV_TPU_JOB" ]]; then
    DEP_FLAG="--dependency=afterany:$PREV_TPU_JOB"
  fi
  NEW_JOB_ID=$(sbatch --parsable \
    --partition="$PARTITION" \
    $DEP_FLAG \
    --job-name="${BACKEND}" \
    --output="/dev/null" \
    --error="/dev/null" \
    --wrap="$JOB_CMD" 2>&1)
  if [[ "$SILICON" == "tpu" ]]; then PREV_TPU_JOB="$NEW_JOB_ID"; fi
  echo "  $BACKEND → $PARTITION (job $NEW_JOB_ID)${DEP_FLAG:+ [dep:$PREV_TPU_JOB]}"

  TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  SEQ="$(date +%s%N)"
  echo "{\"ts\":\"$TS\",\"type\":\"dispatch\",\"backend\":\"$BACKEND\",\"partition\":\"$PARTITION\",\"job_id\":\"$NEW_JOB_ID\",\"msg\":\"resubmit $BACKEND → $PARTITION (job $NEW_JOB_ID)\"}" | gsutil -q cp - "$JOB_DIR/log/${SEQ}-dispatch.json" 2>/dev/null || true &
done
wait

echo ""
echo "Monitor: gsutil ls $JOB_DIR/"
