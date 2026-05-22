# Known Issues

## 1. slurm-gcp bulkInsert doesn't support TPU machine types

slurm-gcp v6's `ResumeProgram` uses `bulkInsert` which rejects `ct6e-*`. TPU provisioning needs `instances.create` API or MIGs. Additionally ct6e requires `hyperdisk-balanced` disks and `threadsPerCore=2`.

## 2. Boltz-2 on TPU requires 10 patches

Boltz-2's codebase has CUDA-specific dependencies (cuEquivariance, trifast/Triton) and XLA-incompatible patterns (in-place tensor mutation, dynamic autocast). All 10 patches are documented inline in `backends/boltz2-tpu/predict.py`. Upstream issue: [jwohlwend/boltz#485](https://github.com/jwohlwend/boltz/issues/485).

## 3. Boltz-2 TPU speed gap

Boltz-2 runs 3.5x slower on TPU vs GPU (248s vs 70s) because the pairformer's triangle einsums use naive PyTorch instead of CUDA's fused cuEquivariance kernels. Profile shows 88% of time in the 48-layer pairformer trunk. Fix: Pallas TPU kernels via [tokamax](https://github.com/openxla/tokamax) (same path AlphaFold 3 uses).

## 4. Boltz-2 confidence module skipped on TPU

`torch.bmm` shape inference fails on XLA when `multiplicity > 0`. Confidence scores (pLDDT, pTM) are NOT produced in TPU output. Structure coordinates are unaffected. Fix: pre-reshape tensors to static batch dims before bmm.

## 5. Spot TPU preemption frequency

TPU v6e Spot in us-central1-b was preempted every 2-4 hours during testing. Long inference runs (>30 min) need DWS Flex Start or on-demand. Boltz-2 hemoglobin (248s) fits within the window; larger proteins may not.

## 6. AF2 GPU — Spot preemption during testing

A100 GPU VMs were preempted 3 times before a successful run. AF2 GPU inference (146.7s cold) requires the full session to complete without interruption.

## 7. AlphaFold 2 — synthetic MSA

GPU and TPU AF2 runs use synthetic MSA (random gaps, no real evolutionary data). pLDDT scores (42-49) are lower than production AF2 with real MSA databases. Structure topology is correct but confidence is underestimated.
