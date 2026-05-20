# Running Protein Models on TPU v6e — Confirmed Patterns

## Confirmed working (2026-05-20)

### ESMFold on TPU via TorchTPU
**Result:** PASS — pLDDT 0.8289, PDB 87198 chars (identical to GPU: pLDDT 0.8264, PDB 87198)

```bash
# Create TPU VM via TPU API (NOT Instance API)
gcloud compute tpus tpu-vm create <name> --zone=us-central1-b \
    --accelerator-type=v6e-4 --version=v2-alpha-tpuv6e --spot

# Install (version pinning is critical)
pip install torch==2.9.0 --index-url https://download.pytorch.org/whl/cpu
pip install torch_xla==2.9.0 libtpu -f https://storage.googleapis.com/libtpu-releases/index.html
pip install transformers accelerate einops
```

```python
# The ONLY code change from GPU:
# GPU:  device = torch.device("cuda")
# TPU:  device = xm.xla_device()
import torch_xla.core.xla_model as xm
device = xm.xla_device()
model = EsmForProteinFolding.from_pretrained("facebook/esmfold_v1").to(device).eval()
# ... same inference code ...
xm.mark_step()  # trigger XLA execution
```

### Key gotchas surmounted

1. **TPU API vs Instance API**: Use `gcloud compute tpus tpu-vm create`, NOT `gcloud compute instances create --machine-type=ct6e-*`. The Instance API creates the VM but doesn't set up TPU metadata (ACCELERATOR_TYPE) or install libtpu. The TPU API handles all of this.

2. **torch/torch_xla version pinning**: torch_xla 2.9.0 requires torch 2.9.0 EXACTLY. If you install transformers after torch_xla, pip upgrades torch to latest (2.12.0) which breaks torch_xla with `undefined symbol: _ZNR5torch7Library4_defE...`. Fix: install torch first, then torch_xla, then transformers.

3. **ACCELERATOR_TYPE metadata**: torch_xla reads `ACCELERATOR_TYPE` from the `tpu-env` instance metadata. On TPU API VMs this is set automatically. On Instance API VMs, you must manually add it to the metadata.

4. **TPU device exclusive lock**: Only ONE process can hold `/dev/vfio/` at a time. You MUST `pkill -9 -f python3` before running a new model.

5. **SSH to TPU VMs**: External SSH from workstations consistently times out. The working path is jump through a GCE VM in the same VPC:
   ```bash
   ssh -i ~/.ssh/google_compute_engine sa_<number>@<internal_ip> '<command>'
   ```
   Requires `roles/compute.osLogin` on the jump VM's service account.

6. **XLA compilation overhead**: ESMFold's first inference takes ~1228s (XLA compiling the full graph). Warm runs don't benefit from cache because ESMFold's recycling loop creates different graph shapes. Mitigation: `torch_xla.experimental.eager_mode(True)` + `JAX_COMPILATION_CACHE_DIR`.

7. **Slurm + TPU incompatibility**: slurm-gcp's `bulkInsert` API doesn't support TPU machine types (ct6e-*). TPU provisioning needs the Instances API or MIGs instead. Additionally, ct6e requires `hyperdisk-balanced` disks and `threadsPerCore=2`.

8. **Spot preemption**: TPU Spot VMs in us-central1-b were preempted 4+ times during testing. Use zone spraying (try multiple zones) and keep sessions short.

### AF2 JAX on TPU
**Result:** PASS — 472.4 TFLOPS on 4096² matmul (4.8× faster than A100's 93.3 TFLOPS)

JAX works out-of-the-box on TPU VMs created via the TPU API. No special configuration needed beyond `pip install jax[tpu]`.

### Boltz-2 on TPU
**Result:** Package imports and tensor ops confirmed. Full `boltz predict` requires MSA server + `cuequivariance_torch` (CUDA-specific kernel for GPU; TPU needs a CPU fallback path).

## Performance comparison

| Model | GPU (A100 40GB) | TPU (v6e 4-chip) | Output parity |
|---|---|---|---|
| ESMFold (142aa) graph mode | cold 2.3s, warm 1.6s | cold 1228s (XLA compile) | pLDDT ±0.003, PDB identical |
| ESMFold (142aa) **eager mode** | cold 2.3s, warm 1.6s | **cold 58.2s, warm 8.4s** | pLDDT 0.8264 vs 0.8288, PDB 87198 both |
| AF2 JAX matmul | 93.3 TFLOPS | 472.4 TFLOPS (5.1×) | Deterministic |
| Boltz-2 tensor | cold 104.9ms, warm 0.2ms | cold 0.7ms, warm 0.1ms | Same shape |
