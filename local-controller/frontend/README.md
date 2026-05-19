# aero-sim-fork — TPU + GPU mirror

Goal: run [GPS-Demos/aero-sim](https://github.com/GPS-Demos/aero-sim) on a B200 GPU cluster *with byte-identical Python source* to the TPU build, so the demo's $/calc comparison is honest.

## Why this works

The aero-sim solver was migrated from NumPy to JAX in March 2026 ([JAX migration plan](https://github.com/GPS-Demos/aero-sim/blob/main/docs/superpowers/plans/2026-03-23-jax-migration.md)). The compute-device detection already handles GPU:

```python
# backend/main.py
def _get_compute_device() -> str:
    devices = jax.devices()
    if any(d.platform == "tpu" for d in devices):
        return f"jax-tpu ({len(...)} chips)"
    if any(d.platform == "gpu" for d in devices):
        return "jax-gpu"
    return "jax-cpu"
```

XLA compiles the same JAX program against both backends. No kernel rewrite, no Pallas, no Triton.

## What's different on GPU

Only three things change between TPU and GPU:

| | TPU build | GPU build |
|---|---|---|
| Base image | `python:3.12-slim` + `pip install jax[tpu]` | `ghcr.io/nvidia/jax:base` (pre-tuned cuDNN/NCCL/CUDA for B200, established by [maxtext_gpu_dependencies.Dockerfile](https://github.com/AI-Hypercomputer/maxtext/blob/main/src/dependencies/dockerfiles/maxtext_gpu_dependencies.Dockerfile)) |
| `JAX_PLATFORMS` | `tpu,cpu` | `cuda,cpu` |
| GKE nodeSelector | `cloud.google.com/gke-tpu-accelerator: tpu-v5-lite-podslice` (2x2) | `cloud.google.com/gke-accelerator: nvidia-b200` (machine type `a4-highgpu-8g`) |
| Toleration | `google.com/tpu` | `nvidia.com/gpu` |
| `resources.limits` | `google.com/tpu: 4` | `nvidia.com/gpu: 8` |
| XLA cache GCS path | `gs://aero-sim-jax-cache/xla` | `gs://aero-sim-jax-cache-cuda/xla` (separate — XLA-TPU and XLA-CUDA HLOs differ) |
| Extra GPU env | n/a | `XLA_FLAGS="--xla_gpu_enable_latency_hiding_scheduler=true --xla_gpu_enable_triton_gemm=false"` (Triton GEMM off — stock cuBLAS faster for our N=500-1500 dense solves; revisit if `benchmark_solve_NxN_ms` says otherwise) |
| xpk device-type | `v5litepod-4` | `b200-8` |

Everything in `backend/solver/`, `backend/main.py`, `backend/ws_particles.py`, etc. is **identical to upstream**. Treat this fork as an overlay: source code lives in the upstream repo, only the Dockerfile + manifest pair lives here.

## The one place TPU and GPU may diverge

`backend/solver/particles.py::trace_streamlines` deliberately escapes JAX into NumPy for dynamic-shape masking (`np.where(np.asarray(active))[0]`). That host↔device round-trip behaves differently on B200 PCIe vs v5e ICI. Bench it specifically — that's where TPU `solves/$` advantage on this workload is decided.

## Layout

```
aero-sim-fork/
├── backend/
│   ├── Dockerfile.tpu     # = upstream backend/Dockerfile, byte-identical
│   └── Dockerfile.gpu     # mirror with jax[cuda12], JAX_PLATFORMS=cuda,cpu
└── k8s/
    ├── backend-tpu.yaml   # = upstream k8s/backend.yaml, byte-identical
    └── backend-gpu.yaml   # mirror with B200 nodeSelector, GPU resources, separate XLA cache
```

## Build + ship

```bash
# Clone upstream (Python source — single source of truth)
git clone https://github.com/GPS-Demos/aero-sim.git upstream

# TPU image
docker build -f backend/Dockerfile.tpu -t us-central1-docker.pkg.dev/PROJECT/aerosim/backend-tpu:latest upstream/backend
docker push us-central1-docker.pkg.dev/PROJECT/aerosim/backend-tpu:latest

# GPU image (same source tree, different jaxlib + env)
docker build -f backend/Dockerfile.gpu -t us-east1-docker.pkg.dev/PROJECT/aerosim/backend-gpu:latest upstream/backend
docker push us-east1-docker.pkg.dev/PROJECT/aerosim/backend-gpu:latest

# Deploy
kubectl --context=ll-demo-tpu-1 apply -f k8s/backend-tpu.yaml
kubectl --context=ll-demo-gpu-1 apply -f k8s/backend-gpu.yaml
```
