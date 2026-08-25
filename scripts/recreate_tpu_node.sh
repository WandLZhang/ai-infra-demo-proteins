#!/bin/bash
# recreate_tpu_node.sh — full recovery for either demo TPU node, from a dead chip back to a
# working warm server. Takes a role so there is one recovery path, not one per node.
#
#   bash scripts/recreate_tpu_node.sh boltz     # the dedicated Boltz-2 node  (:8091)
#   bash scripts/recreate_tpu_node.sh esmfold   # the ESMFold + Slurm compute node (:8090)
#
# WHEN TO USE: the warm server is down AND the TPU is dead at the hardware level — the server
# log says "Failed to get global TPU topology" / "No hardware is found". A host-maintenance
# reboot de-initializes the chips, and that is UNRECOVERABLE in-guest because:
#   - QR-backed TPUs cannot stop/start ("StopNode is not supported for queued resources"),
#     so there is no in-place re-provision; only delete + recreate re-initializes the chips.
#   - As of 2026-06, recreating with the generic `tpu-ubuntu2204-base` runtime yields a node
#     with NO TPU access daemon (VBARCONTROL_AGENT_DOCKER_URL="", fake_tensorflow only), on
#     which libtpu 0.0.21 can never init. **v2-alpha-tpuv6e** is the runtime that still ships
#     the vbar control agent + binds the chips to vfio-pci at boot — the path this libtpu needs.
#
# If the server is down but the TPU is FINE (topology inits, the server just crashed or lost
# its /tmp cache), do NOT recreate — the */5 health cron restores it far faster. Recreate is
# the heavy hammer for a dead chip only.
#
# ⚠️ Both QRs are best-effort, NOT reserved. Deleting frees the chips into a contended zone
# with no guarantee of getting them back. Check capacity before running this in anger.
#
# Usage: bash scripts/recreate_tpu_node.sh [boltz|esmfold]

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/env.sh" 2>/dev/null || true

ROLE="${1:-boltz}"
PROJECT="${BURST_PROJECT_ID:-wz-nih-demo-burst}"
SHARED_BUCKET="${SHARED_BUCKET:-gs://wz-nih-demo-shared}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/google_compute_engine}"
SSH_USER="${SSH_USER:-admin_williszhang_altostrat_com}"
RUNTIME="${TPU_RUNTIME:-v2-alpha-tpuv6e}"   # MUST ship the vbar access daemon — see header
ACCEL="${TPU_ACCEL:-v6e-4}"
IMAGE="${TPU_IMAGE:-us-east5-docker.pkg.dev/wz-nih-demo-burst/proteins/slurm-tpu:latest}"
SLURMUSER_UID="${SLURMUSER_UID:-1015145168}"
ts(){ date "+%Y-%m-%d %H:%M:%S %Z"; }

case "$ROLE" in
  boltz)
    QR="${BOLTZ_QR:-demo-tpu-flex-east5a}"
    NODE="${BOLTZ_TPU_VM:-nihprotein-tpuv6eeast5a-3}"
    ZONE="${BOLTZ_TPU_ZONE:-us-east5-a}"
    PORT=8091
    ;;
  esmfold)
    # The ESMFold node also serves as Slurm compute node east5a-0: all three TPU lanes
    # (esmfold/boltz2/af2) dispatch here and run serialized, so it needs slurmd + munge on
    # top of the warm server. SLURM_NODE is the name the controller knows, which is NOT the
    # TPU node id — the live node lives in us-east5-b but registers as the east5a-0 name.
    QR="${ESMFOLD_QR:-qr-be-e5b}"
    NODE="${ESMFOLD_TPU_VM:-nih-v6e-e5b}"
    ZONE="${ESMFOLD_TPU_ZONE:-us-east5-b}"
    SLURM_NODE="${TPU_ESMFOLD_NODE:-nihprotein-tpuv6eeast5a-0}"
    CTRL_IP="${SLURMCTLD_IP:-172.16.0.2}"      # slurmctld runs on biowulf-controller, ports 6820-6830
    CTRL_VM="${CONTROLLER_VM_NAME:-biowulf-controller}"
    CTRL_ZONE="${CONTROLLER_VM_ZONE:-us-east5-a}"
    CTRL_PROJECT="${CONTROLLER_PROJECT_ID:-wz-nih-demo-controller}"
    PORT=8090
    ;;
  *) echo "usage: $0 [boltz|esmfold]"; exit 2 ;;
esac

echo "$(ts) role=$ROLE  qr=$QR  node=$NODE  zone=$ZONE  port=$PORT"

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

SSH="ssh -i $SSH_KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=30 $SSH_USER@$EXT"
sleep 25  # allow SSH key propagation on the fresh node

if [ "$ROLE" = "boltz" ]; then
  echo "$(ts) [5/6] deploying warm server (boltz2_node_setup.sh) on $NODE"
  cat "$SCRIPT_DIR/boltz2_node_setup.sh" | $SSH 'sudo bash -s' 2>&1 | tail -6

  echo "$(ts) [6/6] publishing new BOLTZ_HOST=$IP to GCS (clients pick it up via env.sh)"
  printf '%s' "$IP" | gsutil -q cp - "$SHARED_BUCKET/config/boltz_host"
  echo "  config/boltz_host = $(gsutil -q cat "$SHARED_BUCKET/config/boltz_host")"

  # The trigger-watcher is long-running: it sourced env.sh once at start and pinned the OLD
  # BOLTZ_HOST, which it passes to every Slurm job. Refresh env.sh and restart it.
  echo "$(ts) refreshing env.sh + restarting trigger-watcher on ${CONTROLLER_VM_NAME:-biowulf-controller}"
  gcloud compute ssh "${CONTROLLER_VM_NAME:-biowulf-controller}" --project="${CONTROLLER_PROJECT_ID:-wz-nih-demo-controller}" \
    --zone="${CONTROLLER_VM_ZONE:-us-east5-a}" --tunnel-through-iap --command="
      sudo gsutil -q cp $SHARED_BUCKET/scripts/env.sh /opt/protein-demo/env.sh
      sudo systemctl restart trigger-watcher 2>/dev/null || true
    " 2>&1 | grep -viE "warning|tcp_upload|numpy|instructions" | tail -3

else
  # ── ESMFold node: warm server + full Slurm compute-node bring-up. ────────────────────
  # This block replaces what used to be a manual rebuild reconstructed from a transcript.
  # Order matters: munge before slurmd, HF weights before the server, and the /root
  # traversal chmod before launching as slurmuser (a fresh node resets /root to 0700, and
  # the server runs as slurmuser, so without o+x it cannot read the weight cache and dies).
  echo "$(ts) [5/6] bringing up ESMFold + slurmd on $NODE (registers as $SLURM_NODE)"
  gsutil -q cp "$SHARED_BUCKET/config/munge.key" /tmp/munge.key 2>/dev/null
  scp -i "$SSH_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
      /tmp/munge.key "$SSH_USER@$EXT:/tmp/munge.key" >/dev/null 2>&1

  $SSH "sudo bash -s" <<EOSSH 2>&1 | tail -25
set -uo pipefail
IMAGE=$IMAGE; SLURM_NODE=$SLURM_NODE; CTRL_IP=$CTRL_IP; UID_S=$SLURMUSER_UID
BUCKET=$SHARED_BUCKET

# Docker snapshots the host resolv.conf into new containers; make sure the host has DNS
# first or the container inherits a nameserver-less file and Boltz/HF downloads hang.
getent hosts storage.googleapis.com >/dev/null 2>&1 || {
  systemctl restart systemd-resolved 2>/dev/null; sleep 3
  getent hosts storage.googleapis.com >/dev/null 2>&1 || \
    printf "nameserver 169.254.169.254\nsearch google.internal\noptions timeout:2 attempts:2\n" > /etc/resolv.conf
}

docker-credential-gcr configure-docker --registries=us-east5-docker.pkg.dev >/dev/null 2>&1 || true
docker pull "\$IMAGE" 2>&1 | tail -1
docker rm -f slurmd >/dev/null 2>&1
docker run -d --name slurmd --privileged --net=host --restart=always \
  --ulimit memlock=-1:-1 --shm-size=16g --hostname="\$SLURM_NODE" "\$IMAGE" sleep infinity >/dev/null
sleep 5

# munge (shared HMAC secret) must be live before slurmd will register
docker cp /tmp/munge.key slurmd:/etc/munge/munge.key
docker exec slurmd bash -c 'chown munge:munge /etc/munge/munge.key; chmod 400 /etc/munge/munge.key;
  mkdir -p /run/munge /var/log/munge && chown munge:munge /run/munge /var/log/munge;
  (runuser -u munge -- /usr/sbin/munged 2>/dev/null || munged --force 2>/dev/null); sleep 2;
  munge -n 2>/dev/null | unmunge 2>/dev/null | grep -m1 STATUS || echo "munge FAILED"'

# configless slurmd against slurmctld
docker exec -d slurmd bash -c "exec slurmd -D --conf-server=\$CTRL_IP:6820 -N \$SLURM_NODE >> /var/log/slurmd.log 2>&1"
sleep 8
docker exec slurmd pgrep -a slurmd >/dev/null && echo "  slurmd registered as \$SLURM_NODE" || echo "  slurmd FAILED"

# ESMFold weights are NOT baked into the image. Download as root, then open /root traversal
# so the slurmuser-owned server can read the cache.
docker exec slurmd bash -c 'export HF_HOME=/root/.cache/huggingface;
  (huggingface-cli download facebook/esmfold_v1 || hf download facebook/esmfold_v1) >/dev/null 2>&1;
  chmod o+x /root /root/.cache 2>/dev/null; chmod -R a+rX /root/.cache/huggingface 2>/dev/null;
  du -sh /root/.cache/huggingface/hub 2>/dev/null | sed "s/^/  weights: /"'

# af2-tpu needs an isolated JAX venv: the system libtpu serves torch_xla and PJRT-mismatches
# jax 0.4.38, so AF2 gets its own venv with a compatible libtpu.
docker exec slurmd bash -c 'python3 -m venv --system-site-packages /tmp/jax-venv >/dev/null 2>&1 &&
  /tmp/jax-venv/bin/pip install --no-cache-dir "jax[tpu]==0.4.38" \
    -f https://storage.googleapis.com/jax-releases/libtpu_releases.html >/dev/null 2>&1 &&
  chmod -R a+rX /tmp/jax-venv &&
  /tmp/jax-venv/bin/python3 -c "import jax;print(\"  jax-venv:\",jax.__version__)"'

# warm server
docker exec slurmd bash -c "mkdir -p /opt/backends /tmp/numba_cache && chmod 777 /tmp/numba_cache;
  gsutil -q cp \$BUCKET/backends/tpu-esmfold-server.py /opt/backends/tpu-esmfold-server.py"
docker exec slurmd bash -c 'pkill -9 -f tpu-esmfold-server 2>/dev/null; rm -f /tmp/libtpu_lockfile; sleep 2'
docker exec -d -u "\$UID_S" slurmd bash -c 'cd /opt/backends && HOME=/tmp PJRT_DEVICE=TPU \
  HF_HOME=/root/.cache/huggingface HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  NUMBA_CACHE_DIR=/tmp/numba_cache python3 -u tpu-esmfold-server.py > /tmp/tpu-model-server.log 2>&1'
for i in \$(seq 1 60); do curl -sf -m5 http://localhost:8090/ >/dev/null 2>&1 && { echo "  esmfold :8090 UP after ~\$((i*6))s"; break; }; sleep 6; done
EOSSH

  echo "$(ts) [6/6] repointing keepalive + Slurm NodeAddr to $IP on $CTRL_VM"
  # keepalive.sh re-marks the node IDLE every 30s and pins NodeAddr; it hardcodes the address,
  # so a recreated node with a new IP must be written in or Slurm keeps dispatching into the void.
  gcloud compute ssh "$CTRL_VM" --project="$CTRL_PROJECT" --zone="$CTRL_ZONE" --tunnel-through-iap --command="
    sudo sed -i -E 's/NodeAddr=[0-9.]+/NodeAddr=$IP/g' /opt/protein-demo/keepalive.sh
    sudo scontrol update NodeName=$SLURM_NODE NodeAddr=$IP State=RESUME 2>/dev/null || \
      sudo scontrol update NodeName=$SLURM_NODE NodeAddr=$IP 2>/dev/null
    # restart keepalive without matching this ssh command line (pkill -f would kill the session)
    for p in \$(ps -eo pid,args | grep '[k]eepalive\.sh' | awk '{print \$1}'); do sudo kill \$p 2>/dev/null; done
    sudo bash -c 'setsid nohup /opt/protein-demo/keepalive.sh </dev/null >/tmp/keepalive.log 2>&1 &'
    sleep 5
    echo \"  NodeAddr=\$(sudo scontrol show node $SLURM_NODE | grep -o 'NodeAddr=[0-9.]*')\"
    echo \"  sinfo: \$(sinfo -N -n $SLURM_NODE -h -o '%t %E')\"
  " 2>&1 | grep -viE "warning|tcp_upload|numpy|instructions" | tail -4
fi

echo "$(ts) verify :$PORT"
if $SSH "curl -sf -m5 http://localhost:$PORT/ >/dev/null" 2>/dev/null; then
  echo "$(ts) ✅ $ROLE server UP at $IP:$PORT"
  [ "$ROLE" = "esmfold" ] && echo "$(ts) next: bash scripts/deploy_tpu_host_scripts.sh   (installs crons + logrotate caps)"
else
  LOG=$([ "$ROLE" = "boltz" ] && echo "docker exec boltz2-server tail /tmp/tpu-boltz2-server.log" || echo "docker exec slurmd tail /tmp/tpu-model-server.log")
  echo "$(ts) ⚠️  server not answering yet — check '$LOG' on $NODE"
  exit 1
fi
