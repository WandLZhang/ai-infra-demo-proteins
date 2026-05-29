#!/bin/bash
# gpu-node-setup.sh — Run inside GPU slurmd container after start.
# Fixes torch, ldconfig, permissions, and caches model weights.
# Called by gpu-health.sh cron on the host VM.

set -uo

echo "[gpu-setup] $(date) starting..."

# Fix torch version for driver 570 (CUDA 12.8) — only needed on west1
CUDA_VER=$(python3 -c "import torch; print(torch.version.cuda)" 2>/dev/null)
CUDA_OK=$(python3 -c "import torch; print(torch.cuda.is_available())" 2>/dev/null)

if [[ "$CUDA_OK" != "True" && "$CUDA_VER" != "12.4" ]]; then
  echo "[gpu-setup] CUDA not available (torch cuda=$CUDA_VER), installing torch 2.6.0+cu124..."
  pip install -q 'torch==2.6.0' --index-url https://download.pytorch.org/whl/cu124 2>&1 | tail -2
  apt-get update -qq && apt-get install -y -qq gcc 2>&1 | tail -1
fi

# Fix ldconfig for triton/boltz
ln -sf /usr/lib/x86_64-linux-gnu/libcuda.so.1 /usr/lib/x86_64-linux-gnu/libcuda.so 2>/dev/null
echo /usr/lib/x86_64-linux-gnu > /etc/ld.so.conf.d/nvidia.conf 2>/dev/null
ldconfig 2>/dev/null

# Pre-cache HF weights
if [[ ! -d /root/.cache/huggingface/hub/models--facebook--esmfold_v1 ]]; then
  echo "[gpu-setup] caching ESMFold weights..."
  python3 -c "from transformers import AutoTokenizer, EsmForProteinFolding; AutoTokenizer.from_pretrained('facebook/esmfold_v1'); EsmForProteinFolding.from_pretrained('facebook/esmfold_v1'); print('cached')" 2>&1 | tail -1
fi

# Fix permissions for slurmuser
chmod -R a+rwX /root/.cache/huggingface/ 2>/dev/null
chmod a+rx /root /root/.cache 2>/dev/null
mkdir -p /tmp/.config/trifast
chmod 777 /tmp/.config /tmp/.config/trifast 2>/dev/null

# Clean stale files from previous runs
rm -f /tmp/*.fasta /tmp/*.log 2>/dev/null

echo "[gpu-setup] $(date) done. CUDA=$(python3 -c 'import torch; print(torch.cuda.is_available())' 2>/dev/null)"
