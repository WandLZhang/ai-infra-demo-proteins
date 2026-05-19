#!/bin/bash
# Spray Spot TPU v6e-4 across all available zones in parallel.
# Takes whichever lands first, kills the rest.
# Same pattern as aero-sim's flex_spray_gpu.sh.

set -euo pipefail

PROJECT="${1:-wz-nih-demo-burst}"
VM_PREFIX="${2:-af2-gate}"
MACHINE_TYPE="ct6e-standard-4t"

# All zones with Spot TPU v6e capacity (from go/spot-dws-capacity May 2026)
ZONES=(
  us-west1-c        # 22,652 capacity
  us-east5-b        # 7,066
  europe-west4-a    # 4,609
  us-east5-a        # 4,356
  us-central1-b     # 3,800
  us-east1-d        # 2,690
  asia-northeast1-b # 1,067
)

echo "=== Spraying Spot TPU v6e across ${#ZONES[@]} zones ==="
echo "Project: $PROJECT | Machine: $MACHINE_TYPE"
echo ""

PIDS=()
WINNER=""

for zone in "${ZONES[@]}"; do
  name="${VM_PREFIX}-${zone//-/}"
  echo "[spray] Launching $name in $zone..."
  gcloud compute instances create "$name" \
    --machine-type="$MACHINE_TYPE" \
    --zone="$zone" \
    --project="$PROJECT" \
    --provisioning-model=SPOT \
    --no-address \
    --image-family=tpu-vm-base \
    --image-project=cloud-tpu-images \
    --quiet 2>&1 &
  PIDS+=($!)
done

echo ""
echo "[spray] ${#PIDS[@]} requests in flight. Waiting for first success..."

while true; do
  for i in "${!PIDS[@]}"; do
    pid="${PIDS[$i]}"
    zone="${ZONES[$i]}"
    name="${VM_PREFIX}-${zone//-/}"

    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid" 2>/dev/null
      rc=$?
      if [ $rc -eq 0 ]; then
        echo ""
        echo "=== WINNER: $name in $zone ==="
        WINNER="$zone"

        # Kill all other pending requests
        for j in "${!PIDS[@]}"; do
          if [ "$j" != "$i" ]; then
            kill "${PIDS[$j]}" 2>/dev/null || true
            loser_zone="${ZONES[$j]}"
            loser_name="${VM_PREFIX}-${loser_zone//-/}"
            gcloud compute instances delete "$loser_name" \
              --zone="$loser_zone" --project="$PROJECT" --quiet 2>/dev/null &
          fi
        done

        echo "VM: $name"
        echo "Zone: $zone"
        echo "Project: $PROJECT"
        echo ""
        echo "Next: SSH with"
        echo "  gcloud compute ssh $name --zone=$zone --project=$PROJECT --tunnel-through-iap"
        exit 0
      else
        echo "[spray] $zone failed (rc=$rc)"
        unset 'PIDS[$i]'
        unset 'ZONES[$i]'
      fi
    fi
  done

  # Check if all failed
  remaining=0
  for pid in "${PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      ((remaining++))
    fi
  done

  if [ $remaining -eq 0 ] && [ -z "$WINNER" ]; then
    echo ""
    echo "=== ALL ZONES EXHAUSTED ==="
    echo "No Spot TPU v6e capacity available right now."
    exit 1
  fi

  sleep 2
done
