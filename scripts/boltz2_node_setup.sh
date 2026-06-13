#!/bin/bash
# boltz2_node_setup.sh — full node-side setup for the Boltz-2 TPU warm server.
#
# Runs ON the TPU VM host (via sudo). Idempotent. Brings the dedicated Boltz-2 v6e
# from a freshly-provisioned (or rebooted) state to a working warm server on :8091:
#
#   1. modprobe vfio-pci + bind the 4 TPU chips to vfio-pci (a fresh node has them
#      unbound; nothing on the VM auto-binds them).
#   2. Start vbarcontrolagent the Google-blessed way (its systemd unit) — libtpu
#      reaches it on :8353 (--bypass_vbar_control_service=0).
#   3. Create the boltz2-server container. NOTE: deliberately NO munge/slurm bind
#      mounts — they were vestigial for a `sleep infinity` + HTTP-server container,
#      and the munge file->file mount from ephemeral /tmp was the original exit-127
#      outage cause. Dropping them removes that whole failure mode.
#   4. Deploy the server code from GCS and (re)launch it as slurmuser.
#
# Used by manual deploy AND by recreate_boltz2_tpu.sh after a QR recreate.
#
# CRITICAL: the node MUST be provisioned with runtime-version=v2-alpha-tpuv6e. As of
# 2026-06, the generic tpu-ubuntu2204-base image ships NO TPU access daemon
# (VBARCONTROL_AGENT_DOCKER_URL="", only a fake_tensorflow placeholder), so libtpu
# reports "No hardware is found" / "Failed to get global TPU topology" and the warm
# server can never start. v2-alpha-tpuv6e ships the vbar control agent + binds the
# chips to vfio-pci at boot, which is the access path this libtpu (0.0.21) needs.
# See recreate_boltz2_tpu.sh and the README troubleshooting section.
#
# Config comes from /opt/env.sh if present, else the defaults below (which match
# scripts/env.sh). Run: sudo bash boltz2_node_setup.sh

set -uo pipefail
[ -r /opt/env.sh ] && source /opt/env.sh
SHARED_BUCKET="${SHARED_BUCKET:-gs://wz-nih-demo-shared}"
IMAGE="${BOLTZ_IMAGE:-us-east5-docker.pkg.dev/wz-nih-demo-burst/proteins/slurm-tpu:latest}"
SLURMUSER_UID="${SLURMUSER_UID:-1015145168}"
PORT="${BOLTZ_PORT:-8091}"
CONTAINER="${BOLTZ_CONTAINER:-boltz2-server}"
HOSTN="$(curl -s -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/name 2>/dev/null || hostname)"
ts(){ date "+%Y-%m-%d %H:%M:%S %Z"; }

echo "$(ts) boltz2_node_setup on $HOSTN (image=$IMAGE port=$PORT)"

# ── 0. Authenticate docker to GCR + Artifact Registry (image pulls need this) ──
docker-credential-gcr configure-docker --registries=gcr.io,us-east5-docker.pkg.dev >/dev/null 2>&1 \
  || gcloud auth configure-docker us-east5-docker.pkg.dev --quiet >/dev/null 2>&1 || true

# ── 1. Bind the 4 TPU chips to vfio-pci ──────────────────────────────────────
modprobe vfio-pci 2>/dev/null || true
for dev in $(lspci -Dn 2>/dev/null | grep -i '1ae0:006f' | awk '{print $1}'); do
  cur=$(basename "$(readlink /sys/bus/pci/devices/$dev/driver 2>/dev/null)" 2>/dev/null)
  if [ "$cur" != "vfio-pci" ]; then
    [ -e "/sys/bus/pci/devices/$dev/driver" ] && echo "$dev" > "/sys/bus/pci/devices/$dev/driver/unbind" 2>/dev/null
    echo vfio-pci > "/sys/bus/pci/devices/$dev/driver_override" 2>/dev/null
    echo "$dev" > /sys/bus/pci/drivers/vfio-pci/bind 2>/dev/null
  fi
done
sleep 2
echo "$(ts) /dev/vfio: $(ls /dev/vfio 2>/dev/null | tr '\n' ' ')"

# ── 2. Start vbarcontrolagent — libtpu reaches it on :8353 (--bypass_vbar_control_service=0).
#       Newer base images ship an EMPTY VBARCONTROL_AGENT_DOCKER_URL in tpu-env, so the stock
#       systemd unit does `docker pull ""` and fails. Fall back to the known-good image. ──
if ! docker ps --format '{{.Names}}' | grep -q '^vbarcontrolagent$'; then
  echo "$(ts) starting vbarcontrolagent"
  # Kill the stock unit first: with an empty VBARCONTROL_AGENT_DOCKER_URL it crash-loops
  # (`docker pull ""`) and its ExecStopPost `docker rm -f vbarcontrolagent` repeatedly DELETES
  # the container we run below. Disable it so our container survives.
  systemctl stop vbarcontrolagent.service 2>/dev/null || true
  systemctl disable vbarcontrolagent.service 2>/dev/null || true
  systemctl reset-failed vbarcontrolagent.service 2>/dev/null || true
  VBAR_IMAGE="${VBAR_IMAGE:-$(grep -h '^VBARCONTROL_AGENT_DOCKER_URL' /home/tpu-runtime/tpu-env 2>/dev/null | cut -d'"' -f2)}"
  [ -z "$VBAR_IMAGE" ] && VBAR_IMAGE="gcr.io/cloud-tpu-v2-images/vbar_control_agent:cloud_tpu.vbarcontrolagent_20250823_RC00"
  docker rm -f vbarcontrolagent >/dev/null 2>&1 || true
  docker pull "$VBAR_IMAGE" 2>&1 | tail -1
  docker run -d --name vbarcontrolagent --privileged --pid=host --net=host --restart=always \
    --memory=512m --cpus=1.0 \
    -v /var/run/docker.sock:/var/run/docker.sock -v /tmp:/tmp -v /var/log/:/var/log/ \
    "$VBAR_IMAGE" \
    vbar_control_agent_files/bin/vbar_control_agent --logtostderr --gid= --uid= --chroot= --census_enabled=false
  sleep 8
fi
echo "$(ts) vbarcontrolagent: $(docker ps --format '{{.Names}} {{.Status}}' | grep vbar || echo DOWN)"

# ── 3. Create the boltz2-server container (no munge/slurm mounts) ─────────────
if ! docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  echo "$(ts) creating $CONTAINER container"
  docker pull "$IMAGE" 2>&1 | tail -1
  docker run -d --name "$CONTAINER" --privileged --net=host --restart=always \
    --ulimit memlock=-1:-1 --shm-size=4g --hostname="$HOSTN" \
    "$IMAGE" sleep infinity
  sleep 5
fi
docker start "$CONTAINER" >/dev/null 2>&1 || true

# ── 4. Deploy server code + weight cache from GCS ────────────────────────────
#       The server load_from_checkpoint()s /tmp/.boltz/boltz2_conf.ckpt at startup, so the
#       cache MUST be present before launch. /tmp is ephemeral (wiped on container restart /
#       host reboot), so this restores it idempotently every run.
docker exec "$CONTAINER" bash -c "
  mkdir -p /opt/backends/boltz2-tpu /tmp/numba_cache /tmp/.boltz && chmod 777 /tmp/numba_cache /tmp/.boltz
  gsutil -q cp $SHARED_BUCKET/backends/tpu-boltz2-server.py /opt/backends/tpu-boltz2-server.py
  gsutil -q cp $SHARED_BUCKET/backends/boltz2-tpu/predict.py /opt/backends/boltz2-tpu/predict.py
  if [ ! -f /tmp/.boltz/boltz2_conf.ckpt ]; then
    echo 'restoring boltz weight cache from GCS...'
    gsutil -q cp $SHARED_BUCKET/boltz-cache/boltz2_conf.ckpt /tmp/.boltz/
    gsutil -q cp $SHARED_BUCKET/boltz-cache/boltz2_aff.ckpt  /tmp/.boltz/
    gsutil -q cp $SHARED_BUCKET/boltz-cache/mols.tar /tmp/.boltz/ && ( cd /tmp/.boltz && tar xf mols.tar && rm -f mols.tar )
  fi
" 2>&1 | sed 's/^/  /'

# ── 5. (Re)launch the warm server as slurmuser ───────────────────────────────
docker exec "$CONTAINER" bash -c 'pkill -9 python3 2>/dev/null; pkill -9 -f libtpu 2>/dev/null; rm -f /tmp/libtpu_lockfile; sleep 3'
docker exec -d -u "$SLURMUSER_UID" "$CONTAINER" bash -c \
  'cd /opt/backends && HOME=/tmp PJRT_DEVICE=TPU HF_HOME=/root/.cache/huggingface BOLTZ_CACHE=/tmp/.boltz NUMBA_CACHE_DIR=/tmp/numba_cache python3 -u tpu-boltz2-server.py > /tmp/tpu-boltz2-server.log 2>&1'

# ── 6. Wait for the listener (TPU topology init + weight load) ───────────────
for i in $(seq 1 60); do
  curl -sf -m 5 "http://localhost:$PORT/" >/dev/null 2>&1 && { echo "$(ts) boltz2 server UP on :$PORT after ~$((i*6))s"; exit 0; }
  sleep 6
done
echo "$(ts) boltz2 server NOT up after ~360s — server log tail:"
docker exec "$CONTAINER" tail -30 /tmp/tpu-boltz2-server.log 2>/dev/null
exit 1
