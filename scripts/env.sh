#!/bin/bash
# Shared config for ai-infra-demo-proteins deploy scripts.
# Source from other scripts: `source "$(dirname "$0")/env.sh"`
#
# Two-project architecture:
#   - CONTROLLER: where the local Slurm head node lives (on-prem analog)
#   - BURST:      where the cloud compute (TPU + GPU) provisions on demand
# Cross-project IAM: controller-sa@CONTROLLER granted compute.admin
#   + storage.objectAdmin in BURST.
#
# Override these for your own deployment — the values below match the
# reference deployment described in README.md.

# ------------------------------------------------------------------
# Project A: controller (on-prem analog)
# ------------------------------------------------------------------
export CONTROLLER_PROJECT_ID="${CONTROLLER_PROJECT_ID:-wz-nih-demo-controller}"
export CONTROLLER_VM_NAME="${CONTROLLER_VM_NAME:-biowulf-controller}"
export CONTROLLER_VM_ZONE="${CONTROLLER_VM_ZONE:-us-east5-a}"
export CONTROLLER_SA="controller-sa@${CONTROLLER_PROJECT_ID}.iam.gserviceaccount.com"

# ------------------------------------------------------------------
# Project B: burst (cloud compute)
# ------------------------------------------------------------------
export BURST_PROJECT_ID="${BURST_PROJECT_ID:-wz-nih-demo-burst}"
export BURST_PROJECT_NUMBER="${BURST_PROJECT_NUMBER:-212183265679}"

# Shared GCS bucket for model weights, MSAs, results (in burst project)
export SHARED_BUCKET="${SHARED_BUCKET:-gs://wz-nih-demo-shared}"

# Boltz-2 warm server lives on east5a-3 (dedicated v6e for full HBM headroom).
# ESMFold warm server lives on east5a-0 (same VM that runs Slurm jobs → localhost).
export BOLTZ_HOST="${BOLTZ_HOST:-10.202.0.23}"
export BOLTZ_PORT="${BOLTZ_PORT:-8091}"

# Artifact Registry — backend containers
export AR_REPO="${AR_REPO:-proteins}"
export AR_REGION="${AR_REGION:-us-east5}"

# ------------------------------------------------------------------
# Per-second pricing for cost ticker (Cloud Billing Catalog API SKUs)
# ------------------------------------------------------------------
# TPU v6e Trillium 4-chip: 4 × $0.50/chip-hr / 3600 = $0.000556/sec
# H100-mega 8-GPU:         8 × $4.4239/chip-hr / 3600 = $0.009831/sec
# A100 40GB 1-GPU:         1 × $3.67/chip-hr / 3600   = $0.001019/sec
export TPU_PRICE_PER_SEC="0.000556"
export GPU_H100_PRICE_PER_SEC="0.009831"
export GPU_A100_PRICE_PER_SEC="0.001019"
