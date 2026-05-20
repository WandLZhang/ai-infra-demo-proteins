#!/bin/bash
# TPU VM setup via the TPU API (not Instance API).
# The TPU API handles image access and runtime initialization.
#
# Key findings (2026-05-20):
# - Instance API (gcloud compute instances create --machine-type=ct6e-*) CAN create
#   the VM but the TPU image from cloud-tpu-images project is blocked by org policy.
#   Even with org policy reset, compute.images.useReadOnly fails.
# - TPU API (gcloud compute tpus tpu-vm create) handles image access internally.
# - torch_xla requires ACCELERATOR_TYPE in tpu-env metadata (set by TPU API).
# - torch_xla version must match torch version exactly (e.g., 2.9.0 + 2.9.0).
# - The TPU API image (v2-alpha-tpuv6e) includes JAX and libtpu pre-installed.
#
# Usage:
#   bash setup_tpu_vm.sh <vm-name> <zone> <project>

set -euo pipefail

VM="${1:-protein-tpu-test}"
ZONE="${2:-us-central1-b}"
PROJECT="${3:-wz-nih-demo-burst}"

echo "=== Creating Spot TPU v6e VM: $VM in $ZONE ==="
gcloud compute tpus tpu-vm create "$VM" \
    --zone="$ZONE" \
    --accelerator-type=v6e-4 \
    --version=v2-alpha-tpuv6e \
    --project="$PROJECT" \
    --spot

echo "=== Waiting for SSH ==="
sleep 30

echo "=== Installing torch_xla + ESMFold ==="
gcloud compute tpus tpu-vm ssh "$VM" --zone="$ZONE" --project="$PROJECT" --command="
pip install torch==2.9.0 torchvision==0.22.0 --index-url https://download.pytorch.org/whl/cpu
pip install torch_xla==2.9.0 -f https://storage.googleapis.com/libtpu-releases/index.html
pip install transformers accelerate einops
echo 'Setup complete'
python3 -c 'import jax; print(\"JAX:\", jax.__version__, \"devices:\", jax.devices())'
PJRT_DEVICE=TPU python3 -c 'import torch_xla; print(\"torch_xla:\", torch_xla.__version__)'
"

echo "=== TPU VM ready ==="
