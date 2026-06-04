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

BACKENDS=("esmfold-tpu" "boltz2-tpu" "af2-tpu" "af2-gpu" "esmfold-gpu" "boltz2-gpu")

echo "=== predict.sh ==="
echo "Protein:  $PROTEIN_ID (${#SEQUENCE} aa)"
echo "Backends: ${BACKENDS[*]}"
echo ""

# Clear previous run's state blobs + log stream. Deliberately DO NOT touch
# the .pdb/.cif structure files — the frontend's ProteinViewer polls
# job/af2-tpu.pdb on a 30s loop and a hard wipe makes the viewer 404 until
# the new AF2 run finishes ~5 min later. The structure files naturally
# overwrite when each backend completes. If a backend fails this run, the
# previous run's structure stays — which matches the viewer's intent
# ("either the last run's output or the one just produced").
gsutil -q -m rm "$JOB_DIR/*.json" 2>/dev/null || true
gsutil -q -m rm -r "$JOB_DIR/log" 2>/dev/null || true

# Reset Spot nodes — names from cloud.conf for the spot-tpu and spot-gpu partitions
if command -v scontrol &>/dev/null; then
  scontrol update NodeName="${SPOT_TPU_NODE:-nihprotein-tpuv6ewest1c-0}" State=IDLE 2>/dev/null || true
  scontrol update NodeName="${SPOT_GPU_NODE:-nihprotein-a100spoteast5-0}" State=IDLE 2>/dev/null || true
fi

# Write manifest
cat <<EOF | gsutil -q cp - "$JOB_DIR/manifest.json"
{
  "protein_id": "$PROTEIN_ID",
  "sequence_length": ${#SEQUENCE},
  "backends": ["af2-tpu","esmfold-tpu","boltz2-tpu","af2-gpu","esmfold-gpu","boltz2-gpu"],
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
  echo "export HOME=/tmp NUMBA_CACHE_DIR=/tmp/numba_cache; mkdir -p /tmp/numba_cache 2>/dev/null; ulimit -l unlimited 2>/dev/null; chmod 777 /tmp/tpu_logs /tmp/*.log /tmp/*.fasta 2>/dev/null; chmod -R 777 /tmp/.gsutil /tmp/.config /tmp/protein-demo /tmp/result-* /tmp/numba_cache /tmp/af2-features /var/cache/alphafold-params 2>/dev/null; rm -rf /tmp/protein-demo 2>/dev/null; mkdir -p /tmp/protein-demo/backends/$BACKEND; gsutil -q cp $SHARED_BUCKET/scripts/run_backend.sh $SHARED_BUCKET/scripts/env.sh /tmp/protein-demo/ 2>/dev/null; gsutil -q cp $SHARED_BUCKET/backends/$BACKEND/predict.py /tmp/protein-demo/backends/$BACKEND/predict.py 2>/dev/null || true; chmod +x /tmp/protein-demo/run_backend.sh 2>/dev/null; bash /tmp/protein-demo/run_backend.sh $BACKEND $PROTEIN_ID"
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

# Serialize ALL TPU jobs: ESMFold → Boltz2 → AF2 (single TPU, one at a time)
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
  NODE_FLAG=""
  EXTRA_FLAGS=""
  if [[ "$SILICON" == "tpu" ]]; then
    NODE_FLAG="--nodelist=${TPU_ESMFOLD_NODE:-nihprotein-tpuv6eeast5a-0}"
    EXTRA_FLAGS="--exclusive"
    if [[ -n "$PREV_TPU_JOB" ]]; then
      EXTRA_FLAGS="--exclusive --dependency=afterany:$PREV_TPU_JOB"
      echo "  $BACKEND: chained after job $PREV_TPU_JOB"
    fi
  fi
  NEW_JOB_ID=$(sbatch --parsable \
    --partition="$PARTITION" \
    $NODE_FLAG \
    $EXTRA_FLAGS \
    --job-name="${BACKEND}" \
    --output="/dev/null" \
    --error="/dev/null" \
    --wrap="$JOB_CMD" 2>&1)
  if [[ "$SILICON" == "tpu" ]]; then
    PREV_TPU_JOB="$NEW_JOB_ID"
  fi
  echo "  $BACKEND → $PARTITION (job $NEW_JOB_ID)${NODE_FLAG:+ [$NODE_FLAG]}${EXTRA_FLAGS:+ [$EXTRA_FLAGS]}"

  TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  SEQ="$(date +%s%N)"
  echo "{\"ts\":\"$TS\",\"type\":\"dispatch\",\"backend\":\"$BACKEND\",\"partition\":\"$PARTITION\",\"job_id\":\"$NEW_JOB_ID\",\"msg\":\"resubmit $BACKEND → $PARTITION (job $NEW_JOB_ID)\"}" | gsutil -q cp - "$JOB_DIR/log/${SEQ}-dispatch.json" 2>/dev/null || true &
done
wait

echo ""
echo "Monitor: gsutil ls $JOB_DIR/"
