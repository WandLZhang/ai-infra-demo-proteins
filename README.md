# NIH Biowulf Protein Structure Prediction Demo

Live demo for the NIH Biowulf HPC briefing (June 4, 2026). Pressing Enter dispatches 6 real protein inference jobs (3 models × 2 silicons) via Slurm from an on-prem controller to cloud compute nodes.

## Quick Start

**Hosted frontend (no local setup needed):** [protein-demo-frontend-212183265679.us-east5.run.app](https://protein-demo-frontend-212183265679.us-east5.run.app) — open, press Enter.

**Local frontend** (for iterating on the React HUD):

```bash
cd local-controller/frontend && npm run dev   # http://localhost:3000
```

The frontend talks to the state server at `VITE_STATE_SERVER` (see `local-controller/frontend/.env`). No IAP tunnel needed — the state server is a public Cloud Run service.

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
Frontend (Cloud Run, nginx)              State server (Cloud Run, Flask)        Controller (biowulf-controller VM)
  protein-demo-frontend-...run.app         protein-demo-server-...run.app         trigger-watcher.service → predict.sh
  │ POST /api/submit ──────────────────▶ │ writes trigger blob to GCS ─────────▶ │ → sbatch × 6 to spot-tpu/spot-gpu
  │ GET  /api/status (polled)            │ GET reads {backend}.json from GCS     │ Phase 1 (65s) → Phase 2 retries on tpu/gpu
  ▼                                      ▼                                       ▼
project: wz-nih-demo-burst             project: wz-nih-demo-burst             Slurm scheduler
region:  us-east5                      region:  us-east5                        │ weight ladder: Spot (w=1) → Guaranteed (w=10)
                                                                                ▼
                                                                         ┌──────────────────────────────────────────┐
                                                                         │  Compute Nodes (wz-nih-demo-burst)       │
                                                                         │  us-east5-a:  TPU v6e (slurm-tpu image)  │
                                                                         │  us-central1: A100 GPU (slurm-gpu image) │
                                                                         │  us-west1:    A100 GPU (slurm-gpu image) │
                                                                         │  Each runs predict.py in fat container.  │
                                                                         └──────────────────┬───────────────────────┘
                                                                                            │ writes to
                                                                                            ▼
                                                                         GCS: gs://wz-nih-demo-shared/job/
                                                                           {backend}.json     (state blob)
                                                                           {backend}.pdb/cif  (structure output)
                                                                           log/*.json         (structured events)
```

## Models & Silicon

| Backend | Model | Silicon | Time (warm) | Cost | TPU wins? |
|---------|-------|---------|------------|------|:---------:|
| af2-tpu | AlphaFold 2 | TPU v6e | **270s** | **$0.15** | **1.4x faster, 2.6x cheaper** |
| af2-gpu | AlphaFold 2 | A100 GPU | 394s | $0.40 | |
| esmfold-tpu | ESMFold | TPU v6e | **9s** (warm server) | **$0.01** | **4x faster** |
| esmfold-gpu | ESMFold | A100 GPU | 38s | $0.04 | |
| boltz2-tpu | Boltz-2 | TPU v6e | **11s** (warm server) | **$0.006** | **6x faster** |
| boltz2-gpu | Boltz-2 | A100 GPU | 67s | $0.07 | |

### TPU Architecture (two VMs, no VFIO conflict)

Two separate TPU v6e VMs eliminate the VFIO conflict between JAX (AF2) and torch_xla (ESMFold/Boltz-2):

| TPU VM | Slurm Node | Role | Backends |
|--------|-----------|------|----------|
| east5a-0 | nihprotein-tpuv6eeast5a-0 | Model server (perpetually warm) | ESMFold-TPU, Boltz2-TPU |
| east5b-0 | nihprotein-tpuv6eeast5a-1 | JAX inference (no server) | AF2-TPU |

`predict.sh` pins jobs via `--nodelist`: AF2-TPU → east5a-1, ESMFold/Boltz2 → east5a-0. All 3 TPU jobs run in parallel.

### TPU Model Server (warm inference)

ESMFold and Boltz-2 TPU use a **persistent model server** (`backends/tpu-model-server.py`) that keeps both models loaded on TPU in a single process on east5a-0. XLA ops are pre-compiled for all 6 demo proteins via `scripts/tpu-warmup-all.sh` (~28 min one-time warmup).

The server runs perpetually. A health cron on the TPU VM checks every 5 minutes and restarts + warms all 6 proteins if the server is down.

## Container Images

Two fat Docker images with all ML deps, built on top of `slurm-compute:latest`:

**slurm-tpu** (`us-east5-docker.pkg.dev/wz-nih-demo-burst/proteins/slurm-tpu:latest`)
- torch 2.9 + torch_xla 2.9, JAX 0.4.38, AlphaFold 2.3, boltz 2.0.3, transformers
- Needs: `--privileged --ulimit memlock=-1:-1`, tpu-runtime stopped

**slurm-gpu** (`us-east5-docker.pkg.dev/wz-nih-demo-burst/proteins/slurm-gpu:latest`)
- torch 2.6.0 cu124, JAX cuda12 0.4.38, AlphaFold 2.3, boltz 2.0.3, transformers
- Needs: `--privileged`, NVIDIA libs mounted from host, `ldconfig` after start

## Deploy Containers to VMs

### TPU VM (us-east5-a)

```bash
# 1. Attach 200GB Hyperdisk for Docker storage (one-time)
gcloud compute disks create tpu-docker-storage --project=wz-nih-demo-burst \
  --zone=us-east5-a --size=200GB --type=hyperdisk-balanced
gcloud alpha compute tpus tpu-vm attach-disk nihprotein-tpuv6eeast5a-0 \
  --project=wz-nih-demo-burst --zone=us-east5-a \
  --disk=tpu-docker-storage --mode=read-write

# 2. SSH in and set up Docker on Hyperdisk
gcloud alpha compute tpus tpu-vm ssh nihprotein-tpuv6eeast5a-0 \
  --project=wz-nih-demo-burst --zone=us-east5-a --tunnel-through-iap
# Inside the VM:
sudo mkfs.ext4 -F /dev/nvme0n2       # Format the Hyperdisk
sudo systemctl stop docker
sudo mkdir -p /mnt/docker-data && sudo mount /dev/nvme0n2 /mnt/docker-data
sudo cp -a /var/lib/docker/* /mnt/docker-data/ 2>/dev/null
sudo umount /mnt/docker-data && sudo mv /var/lib/docker /var/lib/docker.bak
sudo mkdir -p /var/lib/docker && sudo mount /dev/nvme0n2 /var/lib/docker
echo '/dev/nvme0n2 /var/lib/docker ext4 defaults 0 2' | sudo tee -a /etc/fstab
sudo systemctl start docker && sudo rm -rf /var/lib/docker.bak

# 3. Create slurmd container
sudo gsutil cp gs://wz-nih-demo-shared/config/munge.key /tmp/munge.key
sudo chmod 400 /tmp/munge.key
sudo docker pull us-east5-docker.pkg.dev/wz-nih-demo-burst/proteins/slurm-tpu:latest
sudo docker run -d --name slurmd --privileged --net=host --restart=unless-stopped \
  --ulimit memlock=-1:-1 --hostname=nihprotein-tpuv6eeast5a-0 \
  -v /tmp/munge.key:/etc/munge/munge.key \
  -v /etc/slurm:/etc/slurm -v /var/spool/slurm:/var/spool/slurm \
  --entrypoint=/usr/bin/systemd \
  us-east5-docker.pkg.dev/wz-nih-demo-burst/proteins/slurm-tpu:latest

# 4. Configure munge + symlink caches to Hyperdisk
sudo docker exec slurmd bash -c '
  mkdir -p /run/munge && chown munge:munge /run/munge /etc/munge/munge.key
  /usr/sbin/munged --force && systemctl restart slurmd
  # Symlink model caches to Docker writable layer (on Hyperdisk)
  mkdir -p /var/lib/hf-cache /var/lib/boltz-cache
  rm -rf /root/.cache/huggingface && ln -s /var/lib/hf-cache /root/.cache/huggingface
  rm -rf /root/.boltz /tmp/.boltz && ln -s /var/lib/boltz-cache /root/.boltz && ln -s /var/lib/boltz-cache /tmp/.boltz
'

# 5. Cache model weights + deploy scripts
sudo docker exec slurmd bash -c '
  python3 -c "from transformers import AutoTokenizer, EsmForProteinFolding; AutoTokenizer.from_pretrained(\"facebook/esmfold_v1\"); EsmForProteinFolding.from_pretrained(\"facebook/esmfold_v1\")"
  chmod -R a+rwX /root/.cache/huggingface/ && chmod a+rx /root /root/.cache
  gsutil -q cp gs://wz-nih-demo-shared/scripts/backends/tpu-model-server.py /opt/backends/tpu-model-server.py
  for b in af2-tpu esmfold-tpu boltz2-tpu; do
    gsutil -q cp gs://wz-nih-demo-shared/scripts/backends/$b/predict.py /opt/backends/$b/predict.py
  done
  gsutil -q cp gs://wz-nih-demo-shared/scripts/backends/esmfold-tpu/server.py /opt/backends/esmfold-tpu/server.py
  gsutil -q cp gs://wz-nih-demo-shared/scripts/backends/boltz2-tpu/server.py /opt/backends/boltz2-tpu/server.py
'
# Boltz weights will auto-download on first predict run

# 6. Start combined model server + warm
sudo docker exec -d slurmd bash -c 'cd /opt/backends && PJRT_DEVICE=TPU HF_HOME=/root/.cache/huggingface BOLTZ_CACHE=/tmp/.boltz python3 tpu-model-server.py > /tmp/tpu-model-server.log 2>&1'
# Wait ~60s for load, then warm ALL 6 proteins (~28 min, runs in background):
sudo docker exec -d slurmd bash -c 'bash /opt/scripts/tpu-warmup-all.sh > /tmp/tpu-warmup.log 2>&1'
# Monitor: sudo docker exec slurmd tail -f /tmp/tpu-warmup.log
# When "ALL PROTEINS WARMED" appears, TPU wins every model for any protein.

# 7. Install health cron
sudo gsutil cp gs://wz-nih-demo-shared/scripts/tpu-server-health.sh /opt/tpu-server-health.sh
sudo chmod +x /opt/tpu-server-health.sh
(sudo crontab -l 2>/dev/null | grep -v tpu-server-health; echo '*/5 * * * * /opt/tpu-server-health.sh >> /tmp/tpu-health.log 2>&1') | sudo crontab -
```

### GPU VMs (us-central1-f, us-west1-b)

Repeat for both GPU VMs (`nihprotein-a100spotcentra-0` in `us-central1-f` and `nihprotein-a100west1-0` in `us-west1-b`).

**Important for west1**: The VM has NVIDIA driver 570 (CUDA 12.8). The container image has `torch==2.6.0+cu124` which is compatible. If the kernel auto-upgrades, the NVIDIA driver module may break — the GRUB default is pinned to kernel `6.8.0-1047-gcp` in `/etc/default/grub.d/50-cloudimg-settings.cfg`.

```bash
gcloud compute ssh <VM_NAME> --zone=<ZONE> --project=wz-nih-demo-burst --tunnel-through-iap

# 1. Create container with NVIDIA lib mounts + munge key
sudo gsutil cp gs://wz-nih-demo-shared/config/munge.key /tmp/munge.key
sudo chmod 400 /tmp/munge.key
NVIDIA_VER=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1)
sudo docker pull us-east5-docker.pkg.dev/wz-nih-demo-burst/proteins/slurm-gpu:latest
sudo docker run -d --name slurmd --privileged --net=host --restart=unless-stopped \
  --ulimit memlock=-1:-1 --hostname=<VM_NAME> \
  -v /tmp/munge.key:/etc/munge/munge.key \
  -v /usr/lib/x86_64-linux-gnu/libnvidia-ml.so.${NVIDIA_VER}:/usr/lib/x86_64-linux-gnu/libnvidia-ml.so.1 \
  -v /usr/lib/x86_64-linux-gnu/libcuda.so.${NVIDIA_VER}:/usr/lib/x86_64-linux-gnu/libcuda.so.1 \
  -v /usr/lib/x86_64-linux-gnu/libnvidia-ptxjitcompiler.so.${NVIDIA_VER}:/usr/lib/x86_64-linux-gnu/libnvidia-ptxjitcompiler.so.1 \
  -v /etc/slurm:/etc/slurm -v /var/spool/slurm:/var/spool/slurm \
  --entrypoint=/usr/bin/systemd \
  us-east5-docker.pkg.dev/wz-nih-demo-burst/proteins/slurm-gpu:latest

# 2. Configure munge + ldconfig + cache weights
sudo docker exec slurmd bash -c '
  mkdir -p /run/munge && chown munge:munge /run/munge /etc/munge/munge.key
  /usr/sbin/munged --force && systemctl restart slurmd
  ln -sf /usr/lib/x86_64-linux-gnu/libcuda.so.1 /usr/lib/x86_64-linux-gnu/libcuda.so
  echo /usr/lib/x86_64-linux-gnu > /etc/ld.so.conf.d/nvidia.conf && ldconfig
  python3 -c "from transformers import AutoTokenizer, EsmForProteinFolding; AutoTokenizer.from_pretrained(\"facebook/esmfold_v1\"); EsmForProteinFolding.from_pretrained(\"facebook/esmfold_v1\")"
  chmod -R a+rwX /root/.cache/huggingface/ && chmod a+rx /root /root/.cache
  mkdir -p /tmp/.config/trifast && chmod 777 /tmp/.config /tmp/.config/trifast
'

# 3. Install health cron
sudo gsutil cp gs://wz-nih-demo-shared/scripts/gpu-health.sh /opt/gpu-health.sh
sudo chmod +x /opt/gpu-health.sh
sudo docker exec slurmd bash -c 'gsutil -q cp gs://wz-nih-demo-shared/scripts/gpu-node-setup.sh /opt/scripts/gpu-node-setup.sh && chmod +x /opt/scripts/gpu-node-setup.sh'
(sudo crontab -l 2>/dev/null | grep -v gpu-health; echo '*/10 * * * * /opt/gpu-health.sh >> /tmp/gpu-health.log 2>&1') | sudo crontab -
```

## Deploy

Three deploy targets, each with its own script. All idempotent — re-run after any code change.

### Frontend → Cloud Run

```bash
bash scripts/deploy_frontend.sh
```

Builds the Vite bundle locally (so `local-controller/frontend/.env` values are baked into the bundle and not uploaded to Cloud Build), then containerizes `dist/` with nginx and deploys to Cloud Run in `wz-nih-demo-burst` / `us-east5`. Returns the service URL. Source files: `local-controller/frontend/{Dockerfile,nginx.conf,.dockerignore,.gcloudignore}`.

> The `.gcloudignore` is critical — `dist/` is in `.gitignore`, which gcloud honors by default for source upload, so without it the Cloud Build context arrives without `dist/` and the build fails at `COPY dist`.

### Controller VM → scripts + systemd

```bash
bash scripts/deploy_controller.sh
```

Uploads `predict.sh`, `run_backend.sh`, `watch_triggers.sh`, `poll_squeue.sh`, `env.sh` to `/opt/protein-demo/` on the `biowulf-controller` VM in `wz-nih-demo-controller`, installs Python deps in a venv, fixes the Slurm `resume.py` shebang, tunes Slurm timeouts for demo pacing, grants cross-project IAM (controller SA → burst project for TPU/GPU/storage), and (re)installs `trigger-watcher.service` as a systemd unit.

### State server (Flask) → Cloud Run

`local-controller/server.py` is deployed manually with the Dockerfile in `local-controller/Dockerfile`:

```bash
cd local-controller
gcloud run deploy protein-demo-server --source . \
  --project=wz-nih-demo-burst --region=us-east5 \
  --allow-unauthenticated
```

### Containers → Artifact Registry

Two fat ML images (TPU + GPU). Rebuild only when ML dep versions change in `containers/{tpu,gpu}/Dockerfile`.

```bash
cp containers/tpu/Dockerfile Dockerfile
gcloud builds submit --tag=us-east5-docker.pkg.dev/wz-nih-demo-burst/proteins/slurm-tpu:latest \
  --project=wz-nih-demo-burst --region=us-east5 --timeout=3600 .

cp containers/gpu/Dockerfile Dockerfile
gcloud builds submit --tag=us-east5-docker.pkg.dev/wz-nih-demo-burst/proteins/slurm-gpu:latest \
  --project=wz-nih-demo-burst --region=us-east5 --timeout=3600 .
rm Dockerfile
```

After rebuilding, pull the new image on each compute VM and restart `slurmd` (see "Deploy Containers to VMs" below).

### Scripts to GCS (read by sbatch jobs at start)

```bash
gsutil cp scripts/run_backend.sh scripts/predict.sh scripts/env.sh \
  scripts/poll_squeue.sh scripts/watch_triggers.sh gs://wz-nih-demo-shared/scripts/
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

## Self-Healing & Storage

### Health Crons (auto-installed on VMs)

| VM | Cron | What it does |
|----|------|-------------|
| TPU (east5a-0) | `*/5 * * * *` | Checks `curl localhost:8090`, restarts combined model server + auto-warms both models if down. Cleans disk when >85%. |
| GPU (west1-0, central1-f) | `*/10 * * * *` | Checks `torch.cuda.is_available()`, installs torch 2.6.0+cu124 if broken, caches HF weights, fixes ldconfig. Cleans disk when >85%. |

Install scripts: `scripts/tpu-server-health.sh`, `scripts/gpu-health.sh`, `scripts/gpu-node-setup.sh`.

### Storage Layout

| VM | Boot Disk | Docker Storage | Model Caches |
|----|-----------|---------------|-------------|
| TPU | 100GB NVMe (OS only) | **200GB Hyperdisk Balanced** mounted at `/var/lib/docker` | Symlinked: `/root/.cache/huggingface` → `/var/lib/hf-cache/`, `/root/.boltz` → `/var/lib/boltz-cache/` (both on Hyperdisk via Docker writable layer) |
| GPU central1 | 200GB PD | Same disk | HF cache at `/root/.cache/huggingface/` |
| GPU west1 | 200GB PD | Same disk | HF cache at `/root/.cache/huggingface/` |

### Systemd Services (controller VM)

| Service | Restart policy | What |
|---------|---------------|------|
| `trigger-watcher.service` | `Restart=always` | Polls GCS for triggers, runs `predict.sh` |
| `protein-server.service` | `Restart=always` | Flask state server on port 8080 |

### Submit Resilience (3-layer guard)

1. **Frontend** (`App.tsx`): Checks if any lane is actively running (queued/allocating/inferring). If yes, just polls existing run without resubmitting.
2. **Cloud Run** (`server.py`): Reads GCS backend states. If any backend is not idle/done/failed, returns `already_running: true`.
3. **predict.sh**: Checks `squeue`. If ANY jobs exist in queue, exits immediately.

Press Enter any number of times — the system will either pick up the current run or start a new one when the previous is fully done. No manual GCS cleanup needed — `predict.sh` handles cleanup at the start of each run.

## Pre-Run Checklist

Run every item before presenting. Do not skip any.

```bash
# 1. Exactly one trigger watcher
gcloud compute ssh biowulf-controller --zone=us-east5-a --project=wz-nih-demo-controller \
  --command="pgrep -f watch_triggers | wc -l"          # expect: 1-3 (same parent)

# 2. Queue empty
gcloud compute ssh biowulf-controller --zone=us-east5-a --project=wz-nih-demo-controller \
  --command="squeue --noheader | wc -l"                 # expect: 0

# 3. Model server is slurmuser, both ports healthy, POST works
gcloud compute tpus tpu-vm ssh nihprotein-tpuv6eeast5a-0 --zone=us-east5-a --project=wz-nih-demo-burst \
  --worker=all --command='sudo docker exec slurmd bash -c "
    ps aux | grep tpu-model-server | grep -v grep | grep -v bash
    curl -s http://localhost:8090/health; echo
    curl -s http://localhost:8091/health; echo
    curl -s -m 60 -X POST http://localhost:8090/predict \
      -H \"Content-Type: application/json\" \
      -d \"{\\\"sequence\\\":\\\"MVLSPADKTNVKAAWGKVGAHAGEYGAEALERMFLSFPTTKTYFPHFDLSH\\\",\\\"out_path\\\":\\\"/tmp/precheck.pdb\\\"}\" | head -c 100
    echo"'
# expect: slurmus+ owner, both ready, POST returns JSON with solve_time_ms

# 4. Disk OK
gcloud compute tpus tpu-vm ssh nihprotein-tpuv6eeast5a-0 --zone=us-east5-a --project=wz-nih-demo-burst \
  --worker=all --command='df -h / /var/lib/docker | tail -2'   # expect: both < 80%

# 5. GCS badge + warmup
gsutil cat gs://wz-nih-demo-shared/tpu-status.json    # expect: {"status":"ready"}
# If "loading" or "offline": run warmup manually inside the container:
# docker exec slurmd bash /opt/scripts/tpu-warmup-all.sh
# Takes ~4 min (hemoglobin on ESMFold + Boltz-2)

# 6. Simulate frontend Enter (THE REAL TEST)
echo '{"protein_id":"hemoglobin"}' | gsutil cp - gs://wz-nih-demo-shared/triggers/precheck-$(date +%s).json
# Wait 5 min, then:
for b in af2-tpu esmfold-tpu boltz2-tpu af2-gpu esmfold-gpu boltz2-gpu; do
  gsutil cat gs://wz-nih-demo-shared/job/$b.json 2>/dev/null | python3 -c \
    "import sys,json; d=json.load(sys.stdin); print(f\"{d['state']:12s} {d['elapsed_ms']:6d}ms\")"
  printf "%-16s\n" "$b"
done
# expect: all 6 done (not failed)
```

If ANY check fails, fix it before presenting.

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
  esmfold-tpu/predict.py      # ESMFold on torch_xla (tries warm server first)
  esmfold-tpu/server.py       # ESMFold model server (standalone, port 8090)
  esmfold-gpu/predict.py      # ESMFold on CUDA
  boltz2-tpu/predict.py       # Boltz-2 with 10 monkey-patches (tries warm server first)
  boltz2-tpu/server.py        # Boltz-2 model server (standalone, port 8091)
  boltz2-gpu/predict.py       # Boltz-2 stock with boltz CLI
  tpu-model-server.py         # Combined ESMFold+Boltz-2 server (single process, both models on TPU)
  esmfold-tpu/bench_modes.py  # Compare torch_xla execution modes on v6e

containers/
  tpu/Dockerfile              # slurm-compute + torch_xla + jax + AF2 + boltz
  gpu/Dockerfile              # slurm-compute + torch-cu124 + jax-cuda + AF2 + boltz

scripts/
  deploy_frontend.sh          # Build Vite + push to Cloud Run (frontend)
  deploy_controller.sh        # Upload scripts + (re)install systemd on controller VM
  predict.sh                  # 2-phase Spot→guaranteed sbatch dispatcher
  run_backend.sh              # Per-backend job: events + state + inference
  poll_squeue.sh              # slurmctld event scraper
  watch_triggers.sh           # GCS trigger → predict.sh
  env.sh                      # Project IDs, region, pricing (sourced by scripts)
  generate_af2_features.py    # ColabFold MMseqs2 helper for AF2 features.pkl
  tpu-server-health.sh        # Cron: restart TPU model server if down + warm + disk cleanup
  gpu-health.sh               # Cron: check CUDA + weights + disk cleanup on GPU VMs
  gpu-node-setup.sh           # Fix torch, ldconfig, cache weights inside GPU container

local-controller/
  Dockerfile                  # State server (Flask) container for Cloud Run
  server.py                   # Flask: POST /api/submit, GET /api/status
  frontend/
    Dockerfile                # nginx:alpine serving dist/ on port 8080
    nginx.conf                # SPA fallback + cache headers
    .dockerignore             # docker build excludes
    .gcloudignore             # Cloud Build source upload — DOES include dist/
    src/                      # React HUD source (Vite)
    .env                      # VITE_GOOGLE_MAPS_API_KEY, VITE_STATE_SERVER (gitignored)
```
