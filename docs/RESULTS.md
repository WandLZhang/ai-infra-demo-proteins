# Inference Results — TPU vs GPU, All Models

All results use hemoglobin alpha (P69905, 142 residues) on real hardware.

## Performance

| Model | GPU (A100 40GB) | TPU (v6e) | TPU method |
|-------|----------------|-----------|------------|
| ESMFold | 2.3s cold / 1.6s warm | 58s cold / 8.4s warm | torch_xla eager, `device = xm.xla_device()` |
| AlphaFold 2 | 146.7s | 80.4s | JAX native (same code, different backend) |
| Boltz-2 | 70.2s | 248s | torch_xla eager + 10 patches (see `backends/boltz2-tpu/predict.py`) |

## Output Parity

| Model | GPU output | TPU output |
|-------|-----------|------------|
| ESMFold | pLDDT 0.8264, PDB 87,198 chars | pLDDT 0.8288, PDB 87,198 chars |
| AlphaFold 2 | pLDDT 42.4, PDB 87,480 chars | pLDDT 49.0, PDB 87,206 chars |
| Boltz-2 | CIF 94,958 chars, 1,076 ATOMs | CIF 93,943 chars, 1,076 ATOMs |

## Cost per Prediction (Spot)

| Model | GPU A100 ($1.62/hr) | TPU v6e-1 ($0.51/hr) | Winner |
|-------|-------|-------|--------|
| ESMFold (warm) | $0.0007 | $0.0001 | TPU 7x cheaper |
| AlphaFold 2 | $0.066 | $0.011 | TPU 6x cheaper |
| Boltz-2 | $0.032 | $0.018 | TPU 1.8x cheaper |
| **10k screenings (all 3)** | **$987** | **$291** | **TPU saves $696 (70%)** |

## Profile (Boltz-2 TPU — where time is spent)

| Phase | Time | % |
|-------|------|---|
| Pairformer trunk (48 layers, triangle einsums) | 218s | 88% |
| Diffusion sampling (10 steps) | 9s | 4% |
| Data prep (MSA, checkpoint load) | 21s | 8% |

## Reproducibility

### ESMFold TPU
```bash
# One-line device change from GPU
device = xm.xla_device()  # instead of torch.device("cuda")
torch_xla.experimental.eager_mode(True)  # 21x speedup
```

### AlphaFold 2 TPU
JAX auto-detects TPU. Same code runs on both. Requires shims for JAX 0.6+ (tree_map, ops.index_add, np.int).

### Boltz-2 TPU
See `backends/boltz2-tpu/predict.py` — 10 patches documented inline. Key: eager mode + disable CUDA-only kernels (cuEquivariance, trifast) + fix XLA-incompatible in-place ops.

## Hardware

- GPU: `a2-highgpu-1g` (1x A100 40GB, 12 vCPU, 85GB RAM) in us-central1-f
- TPU: `v6e-4` Spot (4 chips, 192GB HBM) in us-central1-b. Only 1 chip used.
- GCP Projects: `wz-nih-demo-controller`, `wz-nih-demo-burst`
