#!/bin/bash
# Confirmed working setup: ESMFold on A100 GPU (2026-05-20)
# VM image: common-cu129-ubuntu-2204-nvidia-580 from deeplearning-platform-release
#
# Usage:
#   bash setup_gpu_vm.sh <vm-name> <zone> <project>
#
# Creates a Spot A100 VM and installs torch + ESMFold.

set -euo pipefail

VM="${1:-protein-gpu-test}"
ZONE="${2:-us-central1-a}"
PROJECT="${3:-wz-nih-demo-burst}"

echo "=== Creating A100 GPU VM: $VM in $ZONE ==="
gcloud compute instances create "$VM" \
    --project="$PROJECT" \
    --zone="$ZONE" \
    --machine-type=a2-highgpu-1g \
    --provisioning-model=SPOT \
    --no-address \
    --subnet=default \
    --boot-disk-size=200GB \
    --boot-disk-type=pd-ssd \
    --image-family=common-cu129-ubuntu-2204-nvidia-580 \
    --image-project=deeplearning-platform-release \
    --maintenance-policy=TERMINATE \
    --accelerator=count=1,type=nvidia-tesla-a100 \
    --metadata="install-nvidia-driver=True"

echo "=== Waiting for SSH ==="
sleep 30

echo "=== Installing Python packages ==="
gcloud compute ssh "$VM" --zone="$ZONE" --project="$PROJECT" --tunnel-through-iap --command="
curl -sS https://bootstrap.pypa.io/get-pip.py | python3
python3 -m pip install torch --index-url https://download.pytorch.org/whl/cu129
python3 -m pip install transformers accelerate einops
echo 'Setup complete'
nvidia-smi --query-gpu=name --format=csv,noheader
python3 -c 'import torch; print(\"torch:\", torch.__version__, \"cuda:\", torch.cuda.is_available())'
"

echo "=== GPU VM ready ==="
