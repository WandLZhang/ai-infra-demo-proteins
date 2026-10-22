#!/bin/bash
# gpu-health.sh — Cron on GPU VM host (every 10 min).
# Reads /opt/env.sh if present for a SHARED_BUCKET override.
[ -r /opt/env.sh ] && source /opt/env.sh
SHARED_BUCKET="${SHARED_BUCKET:-gs://wz-nih-demo-shared}"
CONTAINER=slurmd

# Disk cleanup
DISK_PCT=$(df / --output=pcent | tail -1 | tr -d " %")
if [[ "$DISK_PCT" -gt 80 ]]; then
  echo "$(date) disk at ${DISK_PCT}%, cleaning..."
  docker exec $CONTAINER bash -c "rm -rf /tmp/result-* /tmp/*.pdb /root/.cache/pip 2>/dev/null" 2>/dev/null
  docker image prune -f 2>/dev/null
  journalctl --vacuum-size=10M 2>/dev/null
  echo "$(date) disk now at $(df / --output=pcent | tail -1 | tr -d " %")%"
fi

if ! docker ps --format "{{.Names}}" | grep -q "^${CONTAINER}$"; then
  exit 0
fi

# Fix slurmuser permissions (Slurm jobs run as non-root)
docker exec $CONTAINER bash -c "chmod -R 777 /tmp/.gsutil /tmp/.config /tmp/protein-demo /tmp/numba_cache 2>/dev/null; chmod 666 /tmp/*.log /tmp/*.fasta 2>/dev/null; mkdir -p /tmp/numba_cache; chmod 777 /tmp/numba_cache; chmod -R 777 /usr/local/lib/python3.10/dist-packages/boltz/data/feature/__pycache__ 2>/dev/null" 2>/dev/null

# A recreated container has no copy of the setup script, and the checks below run it. Fetch it the way
# tpu-server-health.sh fetches the prewarm script.
docker exec $CONTAINER bash -c "test -x /opt/scripts/gpu-node-setup.sh || { mkdir -p /opt/scripts && gsutil -q cp $SHARED_BUCKET/scripts/gpu-node-setup.sh /opt/scripts/gpu-node-setup.sh && chmod +x /opt/scripts/gpu-node-setup.sh; }" 2>/dev/null

# Triton (Boltz-2) finds libcuda through the libcuda.so link and the linker cache, which a recreated
# container lacks even when torch.cuda works.
if ! docker exec $CONTAINER test -e /usr/lib/x86_64-linux-gnu/libcuda.so 2>/dev/null; then
  echo "$(date) libcuda.so link missing, running setup..."
  docker exec $CONTAINER bash /opt/scripts/gpu-node-setup.sh
fi

# CUDA check
CUDA_OK=$(docker exec $CONTAINER python3 -c "import torch; print(torch.cuda.is_available())" 2>/dev/null)
if [[ "$CUDA_OK" != "True" ]]; then
  echo "$(date) CUDA broken, running setup..."
  docker exec $CONTAINER bash /opt/scripts/gpu-node-setup.sh
fi

# HF weights check
if ! docker exec $CONTAINER test -d /root/.cache/huggingface/hub/models--facebook--esmfold_v1 2>/dev/null; then
  echo "$(date) HF weights missing, running setup..."
  docker exec $CONTAINER bash /opt/scripts/gpu-node-setup.sh
fi
