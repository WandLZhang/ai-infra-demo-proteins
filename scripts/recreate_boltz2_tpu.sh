#!/bin/bash
# recreate_boltz2_tpu.sh — full recovery for the dedicated Boltz-2 TPU node (east5a-3).
#
# WHEN TO USE: the warm server is down and the node's TPU is dead at the hardware level,
# i.e. the server log shows "Failed to get global TPU topology" / "No hardware is found".
# That happens after a host-maintenance reboot (which de-initializes the chips) — and it is
# UNRECOVERABLE in-guest because:
#   - QR-backed TPUs cannot stop/start ("StopNode is not supported for queued resources"),
#     so there is no in-place re-provision; only delete + recreate re-initializes the chips.
#   - As of 2026-06, recreating with the generic `tpu-ubuntu2204-base` runtime yields a node
#     with NO TPU access daemon (VBARCONTROL_AGENT_DOCKER_URL="", fake_tensorflow only), on
#     which libtpu 0.0.21 can never init. **v2-alpha-tpuv6e** is the runtime that still ships
#     the vbar control agent + binds the chips to vfio-pci at boot — the path this libtpu needs.
#
# If the server is down but the TPU is FINE (topology inits, server just crashed / lost its
# /tmp weight cache), do NOT recreate — `boltz2_node_setup.sh` (or the */5 health cron that
# runs it) restores it far faster. Recreate is the heavy hammer for a dead chip only.
#
# This script: delete QR -> recreate (v2-alpha-tpuv6e) -> wait ACTIVE -> deploy warm server
# + weight cache -> publish the new internal IP to GCS (clients read it via env.sh) -> verify.
#
# Usage:  bash scripts/recreate_boltz2_tpu.sh

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/env.sh" 2>/dev/null || true

QR="${BOLTZ_QR:-demo-tpu-flex-east5a}"
NODE="${BOLTZ_TPU_VM:-nihprotein-tpuv6eeast5a-3}"
ZONE="${BOLTZ_TPU_ZONE:-us-east5-a}"
RUNTIME="${BOLTZ_RUNTIME:-v2-alpha-tpuv6e}"     # MUST ship the vbar access daemon — see header
ACCEL="${BOLTZ_ACCEL:-v6e-4}"
PROJECT="${BURST_PROJECT_ID:-wz-nih-demo-burst}"
SHARED_BUCKET="${SHARED_BUCKET:-gs://wz-nih-demo-shared}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/google_compute_engine}"
SSH_USER="${SSH_USER:-admin_williszhang_altostrat_com}"
ts(){ date "+%Y-%m-%d %H:%M:%S %Z"; }

echo "$(ts) [1/6] deleting QR $QR (frees the dead chips)"
gcloud compute tpus queued-resources delete "$QR" --zone="$ZONE" --project="$PROJECT" --force --quiet 2>&1 | tail -2

echo "$(ts) [2/6] creating QR $QR  accel=$ACCEL runtime=$RUNTIME"
gcloud compute tpus queued-resources create "$QR" \
  --node-id="$NODE" --zone="$ZONE" --project="$PROJECT" \
  --accelerator-type="$ACCEL" --runtime-version="$RUNTIME" --network=default 2>&1 | tail -3

echo "$(ts) [3/6] waiting for ACTIVE"
for i in $(seq 1 40); do
  st=$(gcloud compute tpus queued-resources describe "$QR" --zone="$ZONE" --project="$PROJECT" --format="value(state.state)" 2>&1)
  echo "  $(ts) $st"
  [ "$st" = "ACTIVE" ] && break
  echo "$st" | grep -qiE "fail|denied" && { echo "$(ts) QR provisioning FAILED — capacity? aborting"; exit 1; }
  sleep 30
done

echo "$(ts) [4/6] reading new IPs"
IP=$(gcloud compute tpus tpu-vm describe "$NODE" --zone="$ZONE" --project="$PROJECT" --format="value(networkEndpoints[0].ipAddress)" 2>&1)
EXT=$(gcloud compute tpus tpu-vm describe "$NODE" --zone="$ZONE" --project="$PROJECT" --format="value(networkEndpoints[0].accessConfig.externalIp)" 2>&1)
echo "  internal=$IP external=$EXT"
[ -z "$IP" ] && { echo "$(ts) no IP yet — aborting"; exit 1; }

echo "$(ts) [5/6] deploying warm server (boltz2_node_setup.sh) on $NODE"
sleep 25  # allow SSH key propagation on the fresh node
cat "$SCRIPT_DIR/boltz2_node_setup.sh" | ssh -i "$SSH_KEY" \
  -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=30 \
  "$SSH_USER@$EXT" 'sudo bash -s' 2>&1 | tail -6

echo "$(ts) [6/6] publishing new BOLTZ_HOST=$IP to GCS (clients pick it up via env.sh)"
printf '%s' "$IP" | gsutil -q cp - "$SHARED_BUCKET/config/boltz_host"
echo "  config/boltz_host = $(gsutil -q cat "$SHARED_BUCKET/config/boltz_host")"

echo "$(ts) verify :8091"
if ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
     "$SSH_USER@$EXT" "curl -sf -m5 http://localhost:8091/ >/dev/null" 2>/dev/null; then
  echo "$(ts) ✅ Boltz-2 server UP at $IP:8091"
else
  echo "$(ts) ⚠️  server not answering yet — check 'docker exec boltz2-server tail /tmp/tpu-boltz2-server.log' on $NODE"
  exit 1
fi
