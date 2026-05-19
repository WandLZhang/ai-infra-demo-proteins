# Known Issues — ai-infra-demo-proteins

## 1. slurm-gcp bulkInsert doesn't support TPU machine types

**Status:** Blocking TPU nodesets on Slurm Cluster Toolkit
**Error:** `Bulk Insert is not supported for queued requests with TPU machine type 'ct6e-standard-4t'. Use the Instances API or Managed Instance Groups (MIGs) instead.`

slurm-gcp v6's `ResumeProgram` uses the Compute Engine `bulkInsert` API for all VM provisioning. TPU machine types (ct6e-*) require the regular `instances.create` API or MIGs.

**Workarounds:**
- Patch `/slurm/scripts/resume.py` to detect `ct6e-*` machine types and use `instances.create` instead of `bulkInsert`
- Use GKE Autopilot for TPU backends (Autopilot handles TPU natively via nodeSelector)
- File feature request with slurm-gcp team (SchedMD) to support TPU via Instances API

**Additional TPU template requirements discovered:**
- Disk type: `hyperdisk-balanced` (pd-standard and pd-ssd both rejected by ct6e)
- SMT/Threading: `threadsPerCore: 2` required (setting 1 rejected by ct6e)

## 2. GPU quota = 0 in burst project

**Status:** Blocking GPU nodesets
**Error:** `Quota 'NVIDIA_A100_80GB_GPUS' exceeded. Limit: 0.0 in region us-central1.`

New GCP projects start with 0 GPU quota. Need to request A100 quota increase.

**Workaround:** Use GPU backends from the existing aero-sim project (`wz-ai-infra-demo-2026-05`) which has working H100 quota.
