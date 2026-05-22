# Running Protein Models on TPU v6e — Validated Patterns

## Quick start

```bash
# Create TPU VM (Spot — cheapest, but may be preempted)
gcloud compute tpus tpu-vm create protein-tpu \
    --zone=us-central1-b \
    --accelerator-type=v6e-4 \
    --version=v2-alpha-tpuv6e \
    --spot \
    --metadata=enable-oslogin=TRUE \
    --project=wz-nih-demo-burst

# Install torch + torch_xla for TPU
pip install torch==2.9.0 torch_xla[tpu]==2.9.0 \
    -f https://storage.googleapis.com/libtpu-releases/index.html
```

## ESMFold on TPU (one-line port)

**Result:** pLDDT 0.8288, PDB 87,198 chars — identical to GPU. 8.4s warm.

```python
import torch_xla
torch_xla.experimental.eager_mode(True)  # 21x speedup (1228s → 58s)
import torch_xla.core.xla_model as xm

device = xm.xla_device()  # THE one-line change from torch.device("cuda")
model = EsmForProteinFolding.from_pretrained("facebook/esmfold_v1").to(device).eval()
# ... same inference code as GPU ...
```

## AlphaFold 2 on TPU (JAX native)

**Result:** pLDDT 49.0, PDB 87,206 chars. 80.4s (1.8x faster than GPU's 146.7s).

JAX auto-detects TPU. Same code runs on both GPU and TPU. Requires compat shims for JAX 0.6+:
- `jax.tree_map` → `jax.tree.map`
- `jax.ops.index_add` → `x.at[idx].add(y)`
- `np.int` → `int` (numpy 2.x)
- `collections.Iterable` → `collections.abc.Iterable` (Python 3.10+)
- `hk.vmap` needs `split_rng=False` default

## Boltz-2 on TPU (10 patches)

**Result:** CIF 93,943 chars, 1,076 ATOMs — within 1% of GPU. 248s with eager mode.

See `backends/boltz2-tpu/predict.py` for the complete, documented script. Summary of patches:

| # | Patch | Why |
|---|-------|-----|
| 1 | `torch_xla.experimental.eager_mode(True)` | 240x speedup over graph mode |
| 2 | `torch.load(weights_only=False)` | PyTorch 2.9 changed default to True |
| 3 | Lightning `_XLA_AVAILABLE` override | RequirementCache evaluates before torch_xla loads |
| 4 | `bf16-mixed` → `bf16-true` | XLA only supports pure bf16, not mixed |
| 5 | `autocast("cuda")` → `nullcontext()` | No NVIDIA driver on TPU |
| 6 | `trifast_is_usable = False` | Triton triangle attention needs CUDA |
| 7 | `F[:,-1,-1] = det(R)` → `cat + diag_embed` | XLA prohibits in-place tensor mutation |
| 8 | SVD rank-check `if False` | XLA tensor sync fails on conditional |
| 9 | `raise {"exception":True}` → `raise e` | Boltz upstream bug masks real errors |
| 10 | `confidence_prediction = False` | bmm shape inference bug on XLA |

### Where the time goes (profile of 248s run)

| Phase | Time | % |
|-------|------|---|
| Pairformer trunk (48 layers, triangle einsums) | 218s | 88% |
| Diffusion sampling (10 steps) | 9s | 4% |
| Data prep (MSA server, checkpoint load) | 21s | 8% |

### Path to GPU speed parity

1. **Pallas kernels** for triangle multiplication via [tokamax](https://github.com/openxla/tokamax) (AlphaFold 3 uses this)
2. **`torch_xla.experimental.custom_kernel.flash_attention`** for pair attention
3. **`torch.compile(backend="openxla")`** for op fusion (blocked by Boltz dynamic shapes)

## Key gotchas

1. **TPU API, not Instance API**: `gcloud compute tpus tpu-vm create`, NOT `gcloud compute instances create --machine-type=ct6e-*`. Instance API doesn't set up TPU runtime.

2. **Version pinning**: torch_xla 2.9.0 requires torch 2.9.0 exactly. Install torch first, then torch_xla, then other packages (pip may upgrade torch otherwise).

3. **TPU device exclusive lock**: Only one process can hold `/dev/vfio/` at a time. Kill previous processes before starting a new run.

4. **Spot preemption**: TPU Spot in us-central1-b was preempted 5+ times during testing (every 2-4 hours). For long runs, use DWS Flex Start (7-day guaranteed capacity) or on-demand.

5. **SSH via IAP**: Direct SSH times out. Use `gcloud alpha compute tpus tpu-vm ssh --tunnel-through-iap`.

6. **Boltz version**: Pin `boltz==2.0.3`. Newer versions have checkpoint hparam mismatches with the HuggingFace checkpoint.
