# NIH Biowulf Protein Structure Prediction Demo

Live demo for the NIH Biowulf HPC briefing (June 4, 2026). Pressing Enter dispatches 6 real protein inference jobs (3 models × 2 silicons) via Slurm from an on-prem controller to cloud compute nodes.

## Quick Start (5 commands)

```bash
# 1. Start IAP tunnel to the controller
gcloud compute start-iap-tunnel biowulf-controller 8080 \
  --local-host-port=localhost:8080 \
  --zone=us-east5-a --project=wz-nih-demo-controller

# 2. Start frontend
cd local-controller/frontend && npm run dev

# 3. Open browser, press Enter
```

## What Happens When You Press Enter

1. Frontend → `POST /api/submit` → server.py writes trigger to GCS
2. trigger-watcher.service detects trigger → runs predict.sh
3. predict.sh Phase 1: submits all 6 to Spot partitions (65s timeout)
4. Spot nodes fail (no capacity) → predict.sh Phase 2: resubmits to guaranteed
5. Slurm dispatches to pre-warmed VMs (TPU v6e + A100 GPU)
6. Each job: downloads run_backend.sh from GCS → writes structured events → runs predict.py → uploads PDB/CIF
7. Frontend polls GCS events → drip queue renders terminal + side ladder + map markers in lockstep

Total time: ~12 minutes (TPU jobs sequential, GPU jobs sequential, real ML inference)

## Architecture

```
Frontend (React)                         Controller (biowulf-controller)
  │ POST /api/submit                       │ trigger-watcher → predict.sh
  ▼                                        │ → sbatch × 6
GCS trigger blob                           ▼
  gs://wz-nih-demo-shared/triggers/    Slurm scheduler
                                           │ weight ladder: Spot (w=1) → Guaranteed (w=10)
                                           ▼
                                    ┌──────────────────────────────────────────┐
                                    │  Compute Nodes (wz-nih-demo-burst)       │
                                    │                                          │
                                    │  us-east5-a:  TPU v6e (slurm-tpu image) │
                                    │  us-central1: A100 GPU (slurm-gpu image)│
                                    │  us-west1:    A100 GPU (slurm-gpu image)│
                                    │                                          │
                                    │  Each runs predict.py inside fat Docker  │
                                    │  container with all ML deps baked in     │
                                    └──────────────────┬───────────────────────┘
                                                       │ writes to
                                                       ▼
                                    GCS: gs://wz-nih-demo-shared/job/
                                      {backend}.json     (state blob)
                                      {backend}.pdb/cif  (structure output)
                                      log/*.json         (structured events)
```

## Models & Silicon

| Backend | Model | Silicon | Container | Inference Time |
|---------|-------|---------|-----------|---------------|
| af2-tpu | AlphaFold 2 | TPU v6e | slurm-tpu | ~94s |
| af2-gpu | AlphaFold 2 | A100 GPU | slurm-gpu | ~170s |
| esmfold-tpu | ESMFold | TPU v6e | slurm-tpu | ~250s |
| esmfold-gpu | ESMFold | A100 GPU | slurm-gpu | ~170s |
| boltz2-tpu | Boltz-2 | TPU v6e | slurm-tpu | ~350s |
| boltz2-gpu | Boltz-2 | A100 GPU | slurm-gpu | ~90s |

## Container Images

Two fat Docker images with all ML deps, built on top of `slurm-compute:latest`:

**slurm-tpu** (`us-east5-docker.pkg.dev/wz-nih-demo-burst/proteins/slurm-tpu:latest`)
- torch 2.9 + torch_xla 2.9, JAX 0.4.38, AlphaFold 2.3, boltz 2.0.3, transformers
- Needs: `--privileged --ulimit memlock=-1:-1`, tpu-runtime stopped

**slurm-gpu** (`us-east5-docker.pkg.dev/wz-nih-demo-burst/proteins/slurm-gpu:latest`)
- torch cu124, JAX cuda12 0.4.38, AlphaFold 2.3, boltz, transformers, trifast, cuequivariance-torch
- Needs: `--privileged`, NVIDIA libs mounted from host, `ldconfig` after start

### Rebuild containers

```bash
cp containers/tpu/Dockerfile Dockerfile
gcloud builds submit --tag=us-east5-docker.pkg.dev/wz-nih-demo-burst/proteins/slurm-tpu:latest \
  --project=wz-nih-demo-burst --region=us-east5 --timeout=3600 .

cp containers/gpu/Dockerfile Dockerfile
gcloud builds submit --tag=us-east5-docker.pkg.dev/wz-nih-demo-burst/proteins/slurm-gpu:latest \
  --project=wz-nih-demo-burst --region=us-east5 --timeout=3600 .
rm Dockerfile
```

## Deploy Containers to VMs

### TPU VM (us-east5-a)

```bash
gcloud compute tpus tpu-vm ssh nihprotein-tpuv6eeast5a-0 --zone=us-east5-a --project=wz-nih-demo-burst --command='
sudo docker update --restart=no tpu-runtime 2>/dev/null; sudo docker stop tpu-runtime 2>/dev/null
sudo docker rm -f slurmd 2>/dev/null; sudo docker system prune -af 2>/dev/null
sudo docker pull us-east5-docker.pkg.dev/wz-nih-demo-burst/proteins/slurm-tpu:latest
sudo docker run -d --name slurmd --privileged --net=host --restart=always --ulimit memlock=-1:-1 \
  us-east5-docker.pkg.dev/wz-nih-demo-burst/proteins/slurm-tpu:latest
sleep 10
sudo docker exec slurmd bash -c "slurmd --conf-server=172.16.0.2:6820 -N nihprotein-tpuv6eeast5a-0 &"
'
```

### GPU VM (us-central1-f)

```bash
gcloud compute ssh nihprotein-a100spotcentra-0 --zone=us-central1-f --project=wz-nih-demo-burst --tunnel-through-iap --command='
sudo docker rm -f slurmd 2>/dev/null; sudo docker system prune -af 2>/dev/null
sudo docker pull us-east5-docker.pkg.dev/wz-nih-demo-burst/proteins/slurm-gpu:latest
NVIDIA_LIB=$(find /usr/lib -name "libnvidia-ml.so.595*" 2>/dev/null | head -1)
CUDA_LIB=$(find /usr/lib -name "libcuda.so.595*" 2>/dev/null | head -1)
sudo docker run -d --name slurmd --privileged --net=host --restart=always --ulimit memlock=-1:-1 \
  ${NVIDIA_LIB:+-v $NVIDIA_LIB:/usr/lib/x86_64-linux-gnu/libnvidia-ml.so.1} \
  ${CUDA_LIB:+-v $CUDA_LIB:/usr/lib/x86_64-linux-gnu/libcuda.so.1} \
  us-east5-docker.pkg.dev/wz-nih-demo-burst/proteins/slurm-gpu:latest
sleep 10; sudo docker exec slurmd ldconfig
sudo docker exec slurmd bash -c "slurmd --conf-server=172.16.0.2:6820 -N nihprotein-a100spotcentra-0 &"
'
```

## Deploy Scripts

```bash
# Upload to GCS (compute nodes download at job start)
gsutil cp scripts/run_backend.sh scripts/predict.sh scripts/env.sh \
  scripts/poll_squeue.sh scripts/watch_triggers.sh gs://wz-nih-demo-shared/scripts/

# Deploy to controller
gcloud compute scp scripts/*.sh local-controller/server.py \
  biowulf-controller:/opt/protein-demo/ \
  --zone=us-east5-a --project=wz-nih-demo-controller

# Restart services
gcloud compute ssh biowulf-controller --zone=us-east5-a --project=wz-nih-demo-controller --command="
  sudo systemctl restart trigger-watcher poll-squeue
  pkill -f 'python server.py' || true; sleep 2
  cd /opt/protein-demo && nohup /opt/protein-demo/venv/bin/python server.py > /tmp/server.log 2>&1 &
"
```

## GCS Layout

```
gs://wz-nih-demo-shared/
  job/                          # Current run (flat, no subfolders)
    manifest.json               # Run metadata
    {backend}.json              # Backend state blob (queued→allocating→loading→inferring→done)
    {backend}.pdb or .cif       # Structure output
    log/                        # Structured event stream
      {nanosecond_ts}-{source}.json

  scripts/                      # Downloaded by sbatch jobs at start
    run_backend.sh, env.sh, predict.sh

  alphafold-features/           # Pre-computed AF2 features per protein
    features_{protein}.pkl

  af2_params/params/            # AlphaFold model weights
    params_model_1.npz
```

## Structured Event Schema

Every event drives terminal + side ladder + map markers from ONE stream:

| type | Side Ladder | Map Marker | Source |
|------|------------|------------|--------|
| dispatch | → queued | — | predict.sh |
| sched_allocate | → allocating | region → yellow | poll_squeue.sh |
| allocate | → allocating | region → green, VM link | run_backend.sh |
| loading | → loading | — | run_backend.sh |
| inferring | → inferring | — | run_backend.sh |
| done | → done + cost | VM → done | run_backend.sh |
| spot_fail | — | region → red | poll_squeue.sh |

## Slurm Config

`/etc/slurm/cloud.conf` on biowulf-controller. 4 partitions:

- `spot-tpu`: 1 Spot TPU node (tried first, usually fails → red on map)
- `spot-gpu`: 1 Spot GPU node (tried first, usually fails)
- `tpu`: Guaranteed TPU nodes (east5-a w=10, central1 w=11)
- `gpu`: Guaranteed GPU nodes (central1 w=10, west1 w=11)

predict.sh Phase 1 submits to spot-*, waits 65s, Phase 2 resubmits failures to guaranteed.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Jobs fail ExitCode=1 | Check `/tmp/{backend}.log` inside the container: `docker exec slurmd tail -20 /tmp/af2-tpu.log` |
| TPU "VFIO busy" | Stop tpu-runtime: `docker update --restart=no tpu-runtime; docker stop tpu-runtime` |
| GPU "CUDA not found" | Run `docker exec slurmd ldconfig` after container start. Mount NVIDIA libs from host. |
| Disk full on VM | `docker system prune -af` to remove old images (each is ~12GB) |
| GCS 404 on features | Verify features exist: `gsutil ls gs://wz-nih-demo-shared/alphafold-features/` |
| Node "idle*" or "Not responding" | Restart slurmd: `docker exec slurmd bash -c 'slurmd --conf-server=172.16.0.2:6820 -N <name> &'` |
| predict.sh double-run | Stop trigger-watcher before manual runs: `systemctl stop trigger-watcher` |

## Files

```
backends/
  af2-tpu/predict.py          # AlphaFold 2 on JAX (CPU on TPU VM)
  af2-gpu/predict.py          # AlphaFold 2 on JAX (CUDA)
  esmfold-tpu/predict.py      # ESMFold on torch_xla (eager mode)
  esmfold-gpu/predict.py      # ESMFold on CUDA
  boltz2-tpu/predict.py       # Boltz-2 with 10 monkey-patches for XLA
  boltz2-gpu/predict.py       # Boltz-2 stock with trifast

containers/
  tpu/Dockerfile              # slurm-compute + torch_xla + jax + AF2 + boltz
  gpu/Dockerfile              # slurm-compute + torch-cu124 + jax-cuda + AF2 + boltz + trifast

scripts/
  predict.sh                  # 2-phase Spot→guaranteed sbatch dispatcher
  run_backend.sh              # Per-backend job: events + state + inference
  poll_squeue.sh              # slurmctld event scraper
  watch_triggers.sh           # GCS trigger → predict.sh
  env.sh                      # Project IDs, pricing

local-controller/
  server.py                   # Flask: POST /api/submit
  frontend/                   # React HUD (Vite)
```
