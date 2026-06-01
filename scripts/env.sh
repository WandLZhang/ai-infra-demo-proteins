#!/bin/bash
# Shared config for ai-infra-demo-proteins deploy scripts.
# Source from other scripts: `source "$(dirname "$0")/env.sh"`
#
# Two-project architecture (mirrors NIH STRIDES boundary):
#   - CONTROLLER: where the local Slurm head node lives (on-prem analog)
#   - BURST:      where the GKE clusters with DWS Flex run (STRIDES analog)
# Cross-project IAM: controller-sa@CONTROLLER granted container.developer
#   + storage.objectAdmin in BURST.

# ------------------------------------------------------------------
# Project A: controller (on-prem analog)
# ------------------------------------------------------------------
export CONTROLLER_PROJECT_ID="wz-nih-demo-controller"
export CONTROLLER_PROJECT_NUMBER="281348638866"
export CONTROLLER_VM_NAME="slurmctld-onprem"
export CONTROLLER_VM_ZONE="us-central1-b"
export CONTROLLER_SA="controller-sa@${CONTROLLER_PROJECT_ID}.iam.gserviceaccount.com"

# ------------------------------------------------------------------
# Project B: burst (STRIDES analog)
# ------------------------------------------------------------------
export BURST_PROJECT_ID="wz-nih-demo-burst"
export BURST_PROJECT_NUMBER="212183265679"

# Two GKE clusters in burst project — one per accelerator family
export BURST_TPU_CLUSTER="nih-burst-tpu-east5"
export BURST_TPU_REGION="us-east5"
export BURST_GPU_CLUSTER="nih-burst-gpu-central1"
export BURST_GPU_REGION="us-central1"

# Shared GCS bucket for model weights, MSAs, results (in burst project)
export SHARED_BUCKET="gs://wz-nih-demo-shared"

# Boltz-2 warm server lives on east5a-3 (dedicated v6e for full HBM headroom).
# ESMFold warm server lives on east5a-0 (same VM that runs Slurm jobs → localhost).
export BOLTZ_HOST="10.202.0.23"
export BOLTZ_PORT="8091"

# Artifact Registry — backend containers
export AR_REPO="proteins"
export AR_REGION="us-east5"

# ------------------------------------------------------------------
# Five backends
# ------------------------------------------------------------------
# Image refs — match the k8s manifests one-to-one
export AF2_TPU_IMAGE="${AR_REGION}-docker.pkg.dev/${BURST_PROJECT_ID}/${AR_REPO}/af2-tpu:latest"
export AF2_GPU_IMAGE="${AR_REGION}-docker.pkg.dev/${BURST_PROJECT_ID}/${AR_REPO}/af2-gpu:latest"
export ESMFOLD_TPU_IMAGE="${AR_REGION}-docker.pkg.dev/${BURST_PROJECT_ID}/${AR_REPO}/esmfold-tpu:latest"
export ESMFOLD_GPU_IMAGE="${AR_REGION}-docker.pkg.dev/${BURST_PROJECT_ID}/${AR_REPO}/esmfold-gpu:latest"
export BOLTZ2_GPU_IMAGE="${AR_REGION}-docker.pkg.dev/${BURST_PROJECT_ID}/${AR_REPO}/boltz2-gpu:latest"

# Slurm partition names (one per backend)
export PARTITIONS=("af2-tpu" "af2-gpu" "esmfold-tpu" "esmfold-gpu" "boltz2-gpu")

# ------------------------------------------------------------------
# Per-second pricing for cost ticker (Cloud Billing Catalog API SKUs)
# ------------------------------------------------------------------
# TPU v6e Trillium 4-chip Flex: 4 × $0.50/chip-hr / 3600 = $0.000556/sec
# H100-mega 8-GPU Flex: 8 × $4.4239/chip-hr / 3600 = $0.009831/sec
# A100 40GB 1-GPU Flex: 1 × $3.67/chip-hr / 3600   = $0.001019/sec
export TPU_PRICE_PER_SEC="0.000556"
export GPU_H100_PRICE_PER_SEC="0.009831"
export GPU_A100_PRICE_PER_SEC="0.001019"

# ------------------------------------------------------------------
# Reuse signals (existing aero-sim TPU pod we'll use for AF2-TPU gate test)
# ------------------------------------------------------------------
# Aero-sim's TPU v6e cluster — the fastest path to validating AF2-on-TPU
# without waiting for our own burst-project cluster to spin up.
export AEROSIM_TPU_CLUSTER="aerosim-tpu-east5"
export AEROSIM_TPU_REGION="us-east5"
export AEROSIM_PROJECT_ID="wz-ai-infra-demo-2026-05"
