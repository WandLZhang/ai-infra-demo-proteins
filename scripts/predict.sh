#!/bin/bash
# predict.sh — sbatch entrypoint for the NIH Biowulf demo.
#
# Two-phase submission:
#   Phase 1: Submit all 6 to Spot partitions (spot-tpu, spot-gpu). Shows Spot attempt.
#   Phase 2: Fail over to guaranteed partitions (tpu, gpu): the GPU jobs as soon as GCP
#            refuses the Spot VM, the TPU jobs after SPOT_CAP seconds. If Spot succeeded, jobs stay.

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

# The previous run's event files. They're deleted in the background once the jobs are submitted,
# so the cleanup doesn't hold up the first job, and the frontend marks every name it listed before
# submitting as seen, so they never replay. The state blobs below overwrite the previous run's.
# Deliberately DO NOT touch the .pdb/.cif structure files — the frontend's ProteinViewer polls
# job/af2-tpu.pdb on a 30s loop and a hard wipe makes the viewer 404 until
# the new AF2 run finishes ~5 min later. The structure files naturally
# overwrite when each backend completes. If a backend fails this run, the
# previous run's structure stays — which matches the viewer's intent
# ("either the last run's output or the one just produced").
OLD_EVENTS=$(gcs_list "job/log/" 2>/dev/null || true)

# Reset Spot nodes
if command -v scontrol &>/dev/null; then
  scontrol update NodeName=nihprotein-tpuv6ewest1c-0 State=IDLE 2>/dev/null || true
  scontrol update NodeName=nihprotein-a100spoteast5-0 State=IDLE 2>/dev/null || true
fi

# Write the manifest and the initial queued state for all backends, in parallel
WRITE_PIDS=()
cat <<EOF | gcs_put "job/manifest.json" &
{
  "protein_id": "$PROTEIN_ID",
  "sequence_length": ${#SEQUENCE},
  "backends": ["af2-tpu","esmfold-tpu","boltz2-tpu","af2-gpu","esmfold-gpu","boltz2-gpu"],
  "submitted_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "status": "running"
}
EOF
WRITE_PIDS+=($!)
for BACKEND in "${BACKENDS[@]}"; do
  cat <<EOF | gcs_put "job/$BACKEND.json" &
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
  WRITE_PIDS+=($!)
done
wait "${WRITE_PIDS[@]}"

# The batch script for one backend. It fetches run_backend.sh, env.sh and the backend's predict.py
# from the bucket, so a GCS hot-patch takes effect without rebuilding the container. The three
# fetches run in parallel through the JSON API; two gsutil copies here took about 3 s of every job.
job_script() {
  local BACKEND="$1"
  cat <<EOF
#!/bin/bash
export HOME=/tmp NUMBA_CACHE_DIR=/tmp/numba_cache
mkdir -p /tmp/numba_cache 2>/dev/null; ulimit -l unlimited 2>/dev/null
chmod 777 /tmp/tpu_logs /tmp/*.log /tmp/*.fasta 2>/dev/null
chmod -R 777 /tmp/.gsutil /tmp/.config /tmp/protein-demo /tmp/result-* /tmp/numba_cache /tmp/af2-features /var/cache/alphafold-params 2>/dev/null
rm -rf /tmp/protein-demo 2>/dev/null; mkdir -p /tmp/protein-demo/backends/$BACKEND
TOKEN=\$(curl -sf --max-time 5 -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token | python3 -c 'import json, sys; print(json.load(sys.stdin)["access_token"])')
fetch() { curl -sf --max-time 20 --retry 3 -H "Authorization: Bearer \$TOKEN" -o "\$2" "https://storage.googleapis.com/storage/v1/b/$SHARED_BUCKET_NAME/o/\$1?alt=media"; }
fetch scripts%2Frun_backend.sh /tmp/protein-demo/run_backend.sh &
fetch scripts%2Fenv.sh /tmp/protein-demo/env.sh &
fetch backends%2F$BACKEND%2Fpredict.py /tmp/protein-demo/backends/$BACKEND/predict.py &
wait
chmod +x /tmp/protein-demo/run_backend.sh 2>/dev/null
bash /tmp/protein-demo/run_backend.sh $BACKEND $PROTEIN_ID
EOF
}

# write_event TYPE MSG [JSON_FIELDS] [NAME_SUFFIX] — one event file in job/log/, uploaded in the
# background. The frontend sorts event files by name, and the name starts with the creation time.
EVENT_PIDS=()
write_event() {
  local TS SEQ MSG JSON
  TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  SEQ="$(date +%s%N)"
  MSG="${2//\\/\\\\}"
  MSG="${MSG//\"/\\\"}"
  JSON="{\"ts\":\"$TS\",\"type\":\"$1\"${3:+,$3},\"msg\":\"$MSG\"}"
  echo "  event: $JSON"
  echo "$JSON" | gcs_put "job/log/${SEQ}-${4:-predict}.json" 2>/dev/null &
  EVENT_PIDS+=($!)
}

# ── Phase 1: Submit all to Spot partitions ──
declare -A SPOT_JOBS
echo "Phase 1: trying Spot..."
for BACKEND in "${BACKENDS[@]}"; do
  SILICON=$(echo "$BACKEND" | cut -d- -f2)
  if [[ "$SILICON" == "tpu" ]]; then PARTITION="spot-tpu"; else PARTITION="spot-gpu"; fi

  SLURM_JOB_ID=$(sbatch --parsable \
    --partition="$PARTITION" \
    --job-name="${BACKEND}" \
    --output="/dev/null" \
    --error="/dev/null" \
    <<< "$(job_script "$BACKEND")" 2>&1)
  SPOT_JOBS[$BACKEND]="$SLURM_JOB_ID"
  echo "  Spot: $BACKEND → $PARTITION (job $SLURM_JOB_ID)"
  write_event dispatch "sbatch $BACKEND → $PARTITION (job $SLURM_JOB_ID)" \
    "\"backend\":\"$BACKEND\",\"partition\":\"$PARTITION\",\"job_id\":\"$SLURM_JOB_ID\"" dispatch
done

# The previous run's event files go now, in the background. disown keeps the waits below off it,
# and its output goes nowhere, so the trigger watcher's pipe closes when this script exits.
if [[ -n "$OLD_EVENTS" ]]; then
  sed "s|^|gs://$SHARED_BUCKET_NAME/|" <<< "$OLD_EVENTS" | gsutil -q -m rm -I >/dev/null 2>&1 &
  disown
fi

# ── Phase 2: Fail over to guaranteed partitions as Spot answers ──
# GPU: as soon as Slurm marks the Spot node DOWN, which is GCP refusing the VM, about 5 s in.
# TPU: after SPOT_CAP seconds. GCP refuses the Spot TPU about 11 s in, but slurm-gcp's TPU resume
# crashes on that error instead of marking the node DOWN, so Slurm only finds out at its 60 s
# ResumeTimeout. No Spot node has come up since May 2026, so the cap gives up nothing. The GPU
# jobs also go at the cap if GCP hasn't answered by then.
SPOT_CAP=10
SPOT_GPU_NODE="nihprotein-a100spoteast5-0"
SPOT_TPU_NODE="nihprotein-tpuv6ewest1c-0"

# Base state of a Slurm node (IDLE, ALLOCATED, DOWN...), without flags like +CLOUD.
node_state() {
  local STATE
  STATE=$(scontrol show node "$1" 2>/dev/null | grep -oP 'State=\K\S+')
  echo "${STATE%%+*}"
}

# Slurm's reason for a node's state, without the trailing [user@time] stamp.
node_reason() {
  local REASON
  REASON=$(scontrol show node "$1" 2>/dev/null | grep -oP '^\s*Reason=\K.*')
  echo "${REASON% \[*}"
}

# Serialize ALL TPU jobs: ESMFold → Boltz2 → AF2 (single TPU, one at a time)
PREV_TPU_JOB=""

# fail_over SILICON NODESET REGION MSG — one spot_fail line, then every job of that silicon that
# isn't running on Spot gets cancelled and resubmitted to its guaranteed partition.
fail_over() {
  local SILICON="$1"
  write_event spot_fail "$4" "\"vm\":null,\"nodeset\":\"$2\",\"region\":\"$3\"" spot
  for BACKEND in "${BACKENDS[@]}"; do
    [[ "$(echo "$BACKEND" | cut -d- -f2)" == "$SILICON" ]] || continue
    JOB_ID="${SPOT_JOBS[$BACKEND]}"
    JOB_STATE=$(scontrol show job "$JOB_ID" 2>/dev/null | grep -oP 'JobState=\K\S+')

    if [[ "$JOB_STATE" == "COMPLETED" || "$JOB_STATE" == "RUNNING" ]]; then
      echo "  $BACKEND: Spot succeeded (state=$JOB_STATE)"
      continue
    fi

    # Spot failed — cancel and resubmit to guaranteed
    echo "  $BACKEND: Spot failed (state=$JOB_STATE) → resubmitting to guaranteed"
    scancel "$JOB_ID" 2>/dev/null || true

    if [[ "$SILICON" == "tpu" ]]; then PARTITION="tpu"; else PARTITION="gpu"; fi

    NODE_FLAG=""
    EXTRA_FLAGS=""
    if [[ "$SILICON" == "tpu" ]]; then
      NODE_FLAG="--nodelist=nihprotein-tpuv6eeast5a-0"
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
      <<< "$(job_script "$BACKEND")" 2>&1)
    if [[ "$SILICON" == "tpu" ]]; then
      PREV_TPU_JOB="$NEW_JOB_ID"
    fi
    echo "  $BACKEND → $PARTITION (job $NEW_JOB_ID)${NODE_FLAG:+ [$NODE_FLAG]}${EXTRA_FLAGS:+ [$EXTRA_FLAGS]}"
    write_event dispatch "resubmit $BACKEND → $PARTITION (job $NEW_JOB_ID)" \
      "\"backend\":\"$BACKEND\",\"partition\":\"$PARTITION\",\"job_id\":\"$NEW_JOB_ID\"" dispatch
  done
}

echo "Phase 2: failing over as Spot answers (cap ${SPOT_CAP}s)..."
GPU_DONE=0; TPU_DONE=0; GPU_MARKED=0; TPU_MARKED=0
PHASE2_START=$SECONDS
while (( GPU_DONE == 0 || TPU_DONE == 0 )); do
  sleep 1
  WAITED=$(( SECONDS - PHASE2_START ))

  # Map markers for the Spot nodes, once Slurm has given each one a job.
  if (( GPU_MARKED == 0 )) && [[ -n "$(squeue -h -w "$SPOT_GPU_NODE" -o %i 2>/dev/null)" ]]; then
    write_event sched_allocate "sched: allocate $SPOT_GPU_NODE (spot-gpu)" \
      "\"vm\":\"$SPOT_GPU_NODE\",\"region\":\"us-east5\",\"partition\":\"spot-gpu\"" spot
    GPU_MARKED=1
  fi
  if (( TPU_MARKED == 0 )) && [[ -n "$(squeue -h -w "$SPOT_TPU_NODE" -o %i 2>/dev/null)" ]]; then
    write_event sched_allocate "sched: allocate $SPOT_TPU_NODE (spot-tpu)" \
      "\"vm\":\"$SPOT_TPU_NODE\",\"region\":\"us-west1\",\"partition\":\"spot-tpu\"" spot
    TPU_MARKED=1
  fi

  if (( GPU_DONE == 0 )); then
    if [[ "$(node_state "$SPOT_GPU_NODE")" == "DOWN" ]]; then
      fail_over gpu a100spoteast5 us-east5 "spot-gpu us-east5-b: $(node_reason "$SPOT_GPU_NODE") → resubmitting to gpu"
      GPU_DONE=1
    elif (( WAITED >= SPOT_CAP )); then
      fail_over gpu a100spoteast5 us-east5 "spot-gpu us-east5-b: no Spot VM after ${SPOT_CAP} s → resubmitting to gpu"
      GPU_DONE=1
    fi
  fi
  if (( TPU_DONE == 0 && WAITED >= SPOT_CAP )); then
    fail_over tpu tpuv6ewest1c us-west1 "spot-tpu us-west1-c: no Spot TPU after ${SPOT_CAP} s → resubmitting to tpu"
    TPU_DONE=1
  fi
done
wait "${EVENT_PIDS[@]}"

echo ""
echo "Monitor: gsutil ls $JOB_DIR/"
