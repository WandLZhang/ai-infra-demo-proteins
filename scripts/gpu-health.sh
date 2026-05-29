#!/bin/bash
# gpu-health.sh — Cron on GPU VM host. Checks slurmd container health,
# runs setup if CUDA is broken or weights missing.
# Install: */10 * * * * /opt/gpu-health.sh >> /tmp/gpu-health.log 2>&1

CONTAINER=slurmd

# Is container running?
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  echo "$(date) container not running"
  exit 0
fi

# Is CUDA working?
CUDA_OK=$(docker exec $CONTAINER python3 -c "import torch; print(torch.cuda.is_available())" 2>/dev/null)
if [[ "$CUDA_OK" != "True" ]]; then
  echo "$(date) CUDA broken, running setup..."
  docker exec $CONTAINER bash /opt/scripts/gpu-node-setup.sh
fi

# Are HF weights cached?
if ! docker exec $CONTAINER test -d /root/.cache/huggingface/hub/models--facebook--esmfold_v1 2>/dev/null; then
  echo "$(date) HF weights missing, running setup..."
  docker exec $CONTAINER bash /opt/scripts/gpu-node-setup.sh
fi
