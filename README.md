# NIH Biowulf Protein Structure Prediction Demo

Live demo for the NIH Biowulf HPC briefing (June 4, 2026). Pressing Enter dispatches 6 real protein inference jobs (3 models × 2 silicons) via Slurm from an on-prem controller to cloud compute nodes.

## Quick Start

**Hosted frontend (no local setup needed):** [protein-demo-frontend-212183265679.us-east5.run.app](https://protein-demo-frontend-212183265679.us-east5.run.app) — open, press Enter.

**Local frontend** (for iterating on the React HUD):

```bash
cd local-controller/frontend && npm run dev   # http://localhost:3000
```

The frontend talks to the state server at `VITE_STATE_SERVER` (see `local-controller/frontend/.env`). The state server is a public Cloud Run service.

## What Happens When You Press Enter

1. Frontend → `POST /api/submit` on Cloud Run state server → writes `triggers/<timestamp>.json` to GCS
2. `trigger-watcher.service` on the controller VM polls GCS, picks up trigger, runs `predict.sh`
3. `predict.sh` Phase 1: submits all 6 to Spot partitions (65s timeout, usually fail with no capacity → red on map)
4. Phase 2: resubmits failures to guaranteed `tpu` / `gpu` partitions
5. Each Slurm job: downloads `run_backend.sh` + `backends/$BACKEND/predict.py` overrides from GCS, runs inference, uploads PDB/CIF
6. TPU jobs hit warm model servers (ESMFold on east5a-0:8090, Boltz-2 on east5a-3:8091, both pre-warmed for all 6 demo proteins)
7. Frontend polls GCS events + reads `tpu-status.json` for the warm-status badge

Total wall-clock: **~6 minutes** for all 6 backends (TPU chain serialized, GPU jobs parallel).

## Architecture

```
Frontend (Cloud Run, nginx)             State server (Cloud Run, Flask)        Controller (biowulf-controller VM)
  protein-demo-frontend-...run.app        protein-demo-server-...run.app         trigger-watcher.service → predict.sh
  │ POST /api/submit ─────────────────▶ │ writes trigger blob to GCS ─────────▶ │ → sbatch × 6 to spot-tpu/spot-gpu
  │ polls GCS directly (state + log)    │                                       │ Phase 1 (65s) → Phase 2 retries on tpu/gpu
  │ polls tpu-status.json (badge)       │                                       │
  ▼                                     ▼                                       ▼
project: wz-nih-demo-burst            project: wz-nih-demo-burst             Slurm scheduler
region:  us-east5                     region:  us-east5                        │
                                                                                ▼
                                                                         ┌──────────────────────────────────────────────┐
                                                                         │  Compute Nodes (wz-nih-demo-burst)           │
                                                                         │  east5a-0 (TPU v6e): slurmd + ESMFold server │
                                                                         │  east5a-3 (TPU v6e): Boltz-2 server          │
                                                                         │  central1 (A100):    slurmd                  │
                                                                         │  west1    (A100):    slurmd                  │
                                                                         └──────────────────┬───────────────────────────┘
                                                                                            │ writes to
                                                                                            ▼
                                                                         gs://wz-nih-demo-shared/job/
                                                                           {backend}.json     (state blob)
                                                                           {backend}.pdb/cif  (structure output)
                                                                           log/*.json         (structured events)
                                                                         gs://wz-nih-demo-shared/tpu-status.json
                                                                           {"status":"ready"|"loading"|"offline"}
```

## Models & Silicon

| Backend | Model | Silicon | Time (warm) | Notes |
|---------|-------|---------|-------------|-------|
| af2-tpu | AlphaFold 2 | TPU v6e (east5a-0, JAX) | **~130s** | Kills ESMFold server pre-run for VFIO |
| af2-gpu | AlphaFold 2 | A100 GPU (central1) | ~350s | |
| esmfold-tpu | ESMFold | TPU v6e (east5a-0, warm server) | **~12s** | torch_xla eager mode, priority lock |
| esmfold-gpu | ESMFold | A100 GPU (west1) | ~40s | |
| boltz2-tpu | Boltz-2 | TPU v6e (east5a-3, warm server) | **~28s** | Separate VM, cross-VM fasta_content protocol |
| boltz2-gpu | Boltz-2 | A100 GPU (west1) | ~67s | |

### TPU Architecture (two warm-server VMs)

Two separate v6e VMs because combining ESMFold + Boltz-2 on a single v6e-4 (32GB HBM) evicts the XLA op cache between calls. Split = each model gets full HBM headroom.

| TPU VM | IP | Server | Port | Container |
|--------|----|--------|------|-----------|
| nihprotein-tpuv6eeast5a-0 | 10.202.0.16 | `tpu-esmfold-server.py` + slurmd | 8090 | `slurm-tpu:latest` |
| nihprotein-tpuv6eeast5a-3 | 10.202.0.23 | `tpu-boltz2-server.py` | 8091 | `slurm-tpu:latest` |

AF2-TPU runs on east5a-0 in the `slurmd` container using an isolated JAX venv (`/tmp/jax-venv`) to dodge the torch_xla libtpu version conflict. Before running, it kills the ESMFold server to release VFIO. After running, `run_backend.sh` restarts ESMFold as `slurmuser` and fires `prewarm_all_proteins.sh` in the background.

### Warm-server design

Both servers use `torch_xla.experimental.eager_mode(True)` to avoid the **30+ minute** lazy-mode HLO compile (see commit `68bb0cd` for the predict.py precedent). Eager-mode tradeoffs:

- First call per unique tensor shape: ~60s (per-op compile)
- Subsequent calls same shape: ~12s
- Eviction window: ~10 min of idle and the shape goes cold

Three mechanisms keep the badge truthful:

1. **`prewarm_all_proteins.sh`** — fires the 6 demo protein shapes against both servers, writes `/tmp/tpu-prewarm-done` sentinel + sets `tpu-status.json` to `ready` at end. Uses `/tmp/tpu-prewarm.pid` mutex.
2. **`tpu-keep-warm.sh`** — cron every 8 min on east5a-0, calls `prewarm_all_proteins.sh` to refresh the sentinel (skips if real Slurm job has `/tmp/tpu-busy` touched, or if a prewarm is already running per pidfile).
3. **`tpu-server-health.sh`** — cron every 5 min on east5a-0, probes `http://localhost:8090/`. Server dead → restart as slurmuser + fire prewarm. Server alive + sentinel <10min → badge `ready`. Server alive + sentinel >10min → badge `loading`.

The servers use `ThreadingHTTPServer` + a serialized `INFERENCE_LOCK` + a `PRIORITY_CV` so real Slurm POSTs jump ahead of any in-flight keep-warm POSTs (header `X-Keepwarm: true` marks low-priority). Worst-case wait for a real POST during a keep-warm cycle: one in-flight inference (~12s) + actual inference (~12s) = ~24s.

## Container Images

Two fat Docker images with all ML deps, built on top of `slurm-compute:latest`:

**slurm-tpu** (`us-east5-docker.pkg.dev/wz-nih-demo-burst/proteins/slurm-tpu:latest`)
- torch 2.9 + torch_xla 2.9, JAX 0.4.38 (separate venv at `/tmp/jax-venv` for AF2-TPU to avoid libtpu PJRT version conflict), AlphaFold 2.3, boltz 2.0.3, transformers
- Needs: `--privileged --ulimit memlock=-1:-1`, tpu-runtime stopped

**slurm-gpu** (`us-east5-docker.pkg.dev/wz-nih-demo-burst/proteins/slurm-gpu:latest`)
- torch 2.6.0 cu124, JAX cuda12 0.4.38, AlphaFold 2.3, boltz 2.0.3, transformers
- Needs: `--privileged`, NVIDIA libs mounted from host, `ldconfig` after start

## Deploy Containers to VMs

### TPU VM east5a-0 (ESMFold warm server + slurmd)

```bash
# 1. Attach 200GB Hyperdisk for Docker storage (one-time)
gcloud compute disks create tpu-docker-storage --project=wz-nih-demo-burst \
  --zone=us-east5-a --size=200GB --type=hyperdisk-balanced
gcloud alpha compute tpus tpu-vm attach-disk nihprotein-tpuv6eeast5a-0 \
  --project=wz-nih-demo-burst --zone=us-east5-a \
  --disk=tpu-docker-storage --mode=read-write

# 2. SSH in and mount Hyperdisk for /var/lib/docker
gcloud alpha compute tpus tpu-vm ssh nihprotein-tpuv6eeast5a-0 \
  --project=wz-nih-demo-burst --zone=us-east5-a --tunnel-through-iap
# Inside the VM:
sudo mkfs.ext4 -F /dev/nvme0n2
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
  mkdir -p /var/lib/hf-cache /var/lib/boltz-cache
  rm -rf /root/.cache/huggingface && ln -s /var/lib/hf-cache /root/.cache/huggingface
  rm -rf /root/.boltz /tmp/.boltz && ln -s /var/lib/boltz-cache /root/.boltz && ln -s /var/lib/boltz-cache /tmp/.boltz
'

# 5. Cache ESMFold weights + deploy server and predict.py overrides
sudo docker exec slurmd bash -c '
  python3 -c "from transformers import AutoTokenizer, EsmForProteinFolding; AutoTokenizer.from_pretrained(\"facebook/esmfold_v1\"); EsmForProteinFolding.from_pretrained(\"facebook/esmfold_v1\")"
  chmod -R a+rwX /root/.cache/huggingface/ && chmod a+rx /root /root/.cache
  gsutil -q cp gs://wz-nih-demo-shared/backends/tpu-esmfold-server.py /opt/backends/tpu-esmfold-server.py
  for b in af2-tpu esmfold-tpu boltz2-tpu; do
    gsutil -q cp gs://wz-nih-demo-shared/backends/$b/predict.py /opt/backends/$b/predict.py
  done
'

# 6. Start the ESMFold warm server as slurmuser
sudo docker exec -d -u 1015145168 slurmd bash -c '
  cd /opt/backends && HOME=/tmp PJRT_DEVICE=TPU HF_HOME=/root/.cache/huggingface \
    BOLTZ_CACHE=/tmp/.boltz NUMBA_CACHE_DIR=/tmp/numba_cache \
    python3 -u tpu-esmfold-server.py > /tmp/tpu-model-server.log 2>&1 \
    & echo $! > /tmp/tpu-model-server.pid
'

# 7. Install health + keep-warm crons (host-side)
sudo gsutil cp gs://wz-nih-demo-shared/scripts/tpu-server-health.sh /opt/tpu-server-health.sh
sudo gsutil cp gs://wz-nih-demo-shared/scripts/tpu-keep-warm.sh /opt/tpu-keep-warm.sh
sudo chmod +x /opt/tpu-server-health.sh /opt/tpu-keep-warm.sh
(sudo crontab -l 2>/dev/null | grep -vE "tpu-server-health|tpu-keep-warm"; \
  echo "*/5 * * * * /opt/tpu-server-health.sh >> /tmp/tpu-health.log 2>&1"; \
  echo "*/8 * * * * /opt/tpu-keep-warm.sh >> /tmp/tpu-keepwarm.log 2>&1") | sudo crontab -
```

### TPU VM east5a-3 (Boltz-2 warm server, dedicated)

```bash
# 1. Persist VFIO modules across reboot (otherwise vfio_iommu_type1 unloads)
sudo tee /etc/modules-load.d/vfio.conf > /dev/null <<EOF
vfio
vfio_iommu_type1
vfio_pci
EOF
sudo tee /etc/modprobe.d/vfio.conf > /dev/null <<EOF
options vfio_iommu_type1 allow_unsafe_interrupts=1
EOF

# 2. Make vbarcontrolagent + boltz2-server containers auto-restart
sudo docker update --restart=always vbarcontrolagent
sudo docker run -d --name boltz2-server --privileged --net=host --restart=always \
  --ulimit memlock=-1:-1 --shm-size=4g --hostname=nihprotein-tpuv6eeast5a-3 \
  us-east5-docker.pkg.dev/wz-nih-demo-burst/proteins/slurm-tpu:latest \
  sleep infinity

# 3. Deploy Boltz-2 server + start as slurmuser
sudo docker exec boltz2-server bash -c '
  gsutil -q cp gs://wz-nih-demo-shared/backends/tpu-boltz2-server.py /opt/backends/tpu-boltz2-server.py
  gsutil -q cp gs://wz-nih-demo-shared/backends/boltz2-tpu/predict.py /opt/backends/boltz2-tpu/predict.py
  mkdir -p /tmp/numba_cache && chmod 777 /tmp/numba_cache
'
sudo docker exec -d -u 1015145168 boltz2-server bash -c '
  cd /opt/backends && HOME=/tmp PJRT_DEVICE=TPU HF_HOME=/root/.cache/huggingface \
    BOLTZ_CACHE=/tmp/.boltz NUMBA_CACHE_DIR=/tmp/numba_cache \
    python3 tpu-boltz2-server.py > /tmp/tpu-boltz2-server.log 2>&1 \
    & echo $! > /tmp/tpu-boltz2-server.pid
'
```

After both servers are running, kick off the all-12-shape prewarm:

```bash
gcloud alpha compute tpus tpu-vm ssh nihprotein-tpuv6eeast5a-0 \
  --project=wz-nih-demo-burst --zone=us-east5-a --tunnel-through-iap --command='
  sudo docker exec slurmd bash -c "gsutil cp gs://wz-nih-demo-shared/scripts/prewarm_all_proteins.sh /tmp/ && bash /tmp/prewarm_all_proteins.sh"
'
```

Takes ~10-15 min cold (6 ESMFold × ~60s + 6 Boltz-2 × ~120s). Sentinel touched at end → badge flips to `ready`. The `*/8` keep-warm cron then keeps it fresh.

### GPU VMs (us-central1-f, us-west1-b)

Repeat the basic slurmd setup for both GPU VMs (`nihprotein-a100spotcentra-0` in `us-central1-f` and `nihprotein-a100west1-0` in `us-west1-b`).

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

The `nihprotein-a100west1-0` VM has NVIDIA driver 570 (CUDA 12.8). The container has `torch==2.6.0+cu124` which is compatible. If the kernel auto-upgrades, the NVIDIA driver module may break — the GRUB default is pinned to `6.8.0-1047-gcp` in `/etc/default/grub.d/50-cloudimg-settings.cfg`.

## Deploy (code changes)

Three deploy targets, each idempotent. Re-run after any code change.

### Frontend → Cloud Run

```bash
bash scripts/deploy_frontend.sh
```

Builds the Vite bundle locally (so `local-controller/frontend/.env` values are baked in), containerizes `dist/` with nginx, deploys to Cloud Run in `wz-nih-demo-burst` / `us-east5`. `local-controller/frontend/.gcloudignore` whitelists `dist/`.

### State server → Cloud Run

```bash
bash scripts/deploy_server.sh
```

Builds `local-controller/server.py` (Flask GCS proxy) and deploys to Cloud Run. `local-controller/.gcloudignore` excludes `venv/`, `frontend/`, `terraform/`, `slurm/`. Service account: project default compute SA (has `roles/storage.admin`).

### Controller VM → scripts + systemd

```bash
bash scripts/deploy_controller.sh
```

Uploads `predict.sh`, `run_backend.sh`, `watch_triggers.sh`, `poll_squeue.sh`, `env.sh` to `/opt/protein-demo/` on `biowulf-controller` in `wz-nih-demo-controller`. Installs Python deps. Grants cross-project IAM. (Re)installs `trigger-watcher.service` as a systemd unit.

### Containers → Artifact Registry

Two fat ML images. Rebuild only when ML dep versions change in `containers/{tpu,gpu}/Dockerfile`.

```bash
cp containers/tpu/Dockerfile Dockerfile
gcloud builds submit --tag=us-east5-docker.pkg.dev/wz-nih-demo-burst/proteins/slurm-tpu:latest \
  --project=wz-nih-demo-burst --region=us-east5 --timeout=3600 .

cp containers/gpu/Dockerfile Dockerfile
gcloud builds submit --tag=us-east5-docker.pkg.dev/wz-nih-demo-burst/proteins/slurm-gpu:latest \
  --project=wz-nih-demo-burst --region=us-east5 --timeout=3600 .
rm Dockerfile
```

After rebuilding, pull the new image on each compute VM and restart `slurmd`.

### Scripts to GCS (read by sbatch jobs and host crons at runtime)

```bash
gsutil cp scripts/run_backend.sh scripts/predict.sh scripts/env.sh \
  scripts/poll_squeue.sh scripts/watch_triggers.sh \
  scripts/tpu-server-health.sh scripts/tpu-keep-warm.sh \
  scripts/prewarm_all_proteins.sh \
  gs://wz-nih-demo-shared/scripts/

gsutil cp backends/tpu-esmfold-server.py backends/tpu-boltz2-server.py \
  gs://wz-nih-demo-shared/backends/

for b in af2-tpu af2-gpu esmfold-tpu esmfold-gpu boltz2-tpu boltz2-gpu; do
  gsutil cp backends/$b/predict.py gs://wz-nih-demo-shared/backends/$b/predict.py
done
```

`run_backend.sh`'s `build_wrap` pulls these on each job, so a re-upload to GCS = live deploy without container rebuild.

## GCS Layout

```
gs://wz-nih-demo-shared/
  job/                          # Current run (flat, no run subfolders)
    manifest.json
    {backend}.json              # State blob (queued→allocating→loading→inferring→done)
    {backend}.pdb or .cif       # Structure output
    log/{nano_ts}-{source}.json # Structured event stream
  triggers/                     # Press-Enter writes here; watcher consumes + deletes
    {timestamp}.json
  tpu-status.json               # Frontend badge: {"status":"ready"|"loading"|"offline"}
  scripts/                      # Downloaded by sbatch jobs + cron at start
  backends/                     # predict.py overrides + warm servers
  alphafold-features/           # Pre-computed AF2 features per protein
  af2_params/params/            # AlphaFold model weights
```

## Slurm Config

`/etc/slurm/cloud.conf` on biowulf-controller. 4 partitions:

- `spot-tpu`: 1 Spot TPU node (tried first, usually fails → red on map)
- `spot-gpu`: 1 Spot GPU node (tried first)
- `tpu`: Guaranteed TPU nodes (east5-a w=10)
- `gpu`: Guaranteed GPU nodes (central1 w=10, west1 w=11)

`predict.sh` Phase 1 submits to `spot-*`, waits 65s, Phase 2 resubmits failures to guaranteed.

## Self-Healing

| VM | Cron | What it does |
|----|------|--------------|
| TPU east5a-0 | `*/5 * * * *` (`tpu-server-health.sh`) | HTTP probe `localhost:8090`. If dead → restart as slurmuser + fire `prewarm_all_proteins.sh`. If sentinel `<10min` → badge `ready`, else `loading`. Cleans disk at >75%, docker prune at >80%. |
| TPU east5a-0 | `*/8 * * * *` (`tpu-keep-warm.sh`) | Re-fires all 6 protein shapes on both servers via `prewarm_all_proteins.sh`. Skips if `/tmp/tpu-busy` (a Slurm job is in flight) or if `/tmp/tpu-prewarm.pid` is alive. |
| TPU east5a-3 | n/a | `boltz2-server` and `vbarcontrolagent` containers use `--restart=always`. VFIO modules persist via `/etc/modules-load.d/vfio.conf`. |
| GPU central1, west1 | `*/10 * * * *` (`gpu-health.sh`) | Checks `torch.cuda.is_available()`, runs `gpu-node-setup.sh` if broken. Cleans disk at >85%. |
| Controller VM | systemd `trigger-watcher.service`, `Restart=always` | Polls GCS for triggers, runs `predict.sh`. Single-instance enforced via `/tmp/watch_triggers.lock` (flock). |

### Submit Resilience (3-layer guard)

1. **Frontend** (`App.tsx`): If any lane is `queued|allocating|loading|inferring`, polls existing run instead of resubmitting.
2. **Cloud Run** (`server.py`): Reads GCS backend states. If any backend is not `idle|done|failed`, returns `already_running: true`.
3. **predict.sh**: Checks `squeue`. If any jobs are queued, exits immediately.

Press Enter any number of times — the system picks up an existing run or starts a new one when the previous is fully done.

## Pre-Run Checklist

Run every item before presenting. Do not skip any.

```bash
# Aliases for terseness
CTRL='gcloud compute ssh biowulf-controller --zone=us-east5-a --project=wz-nih-demo-controller --tunnel-through-iap'
TPU0_KEY='/home/admin_williszhang_altostrat_com/.ssh/google_compute_engine'
TPU0_USER='sa_110480722338943429390'

# 1. Exactly one trigger watcher
$CTRL --command='pgrep -f watch_triggers | wc -l'                  # expect 1-3 (parent + transient subshells)

# 2. Queue empty
$CTRL --command='squeue --noheader | wc -l'                         # expect 0

# 3. Both warm servers ready (from controller via internal IP)
$CTRL --command="ssh -i $TPU0_KEY -o StrictHostKeyChecking=no $TPU0_USER@10.202.0.16 'curl -sf -m 5 http://localhost:8090/'"
$CTRL --command="ssh -i $TPU0_KEY -o StrictHostKeyChecking=no $TPU0_USER@10.202.0.23 'curl -sf -m 5 http://localhost:8091/'"
# expect both: {"status":"ready",...}

# 4. ESMFold warm POST hemoglobin <20s
#    The test/timing_test.py file is baked into the slurmd container during deploy
#    (or you can scp it in once: scripts/timing_test.py).
$CTRL --command="ssh -i $TPU0_KEY -o StrictHostKeyChecking=no $TPU0_USER@10.202.0.16 'sudo docker exec slurmd python3 /tmp/timing_test.py'"
# expect: wall<20s warm=True
# Or run the same call manually:
#   ssh ...@10.202.0.16 'curl -s -m 60 -X POST -H "Content-Type: application/json" \
#     -d @hemoglobin.json http://localhost:8090/predict | head -c 200'

# 5. Disk + memory on east5a-0
$CTRL --command="ssh -i $TPU0_KEY -o StrictHostKeyChecking=no $TPU0_USER@10.202.0.16 'df -h / /var/lib/docker | tail -2; free -h | head -2'"
# expect: both < 80%, mem fine

# 6. Badge + sentinel age
gsutil cat gs://wz-nih-demo-shared/tpu-status.json    # expect: {"status":"ready"}
$CTRL --command="ssh -i $TPU0_KEY -o StrictHostKeyChecking=no $TPU0_USER@10.202.0.16 'sudo docker exec slurmd bash -c \"echo age=\$((\$(date +%s) - \$(stat -c %Y /tmp/tpu-prewarm-done)))s\"'"
# expect age < 600s (<10 min)

# 7. Crons installed
$CTRL --command="ssh -i $TPU0_KEY -o StrictHostKeyChecking=no $TPU0_USER@10.202.0.16 'sudo crontab -l'"
# expect: */5 ... tpu-server-health.sh AND */8 ... tpu-keep-warm.sh

# 8. Simulate frontend Enter (THE REAL TEST)
echo '{"protein_id":"hemoglobin"}' | gsutil cp - gs://wz-nih-demo-shared/triggers/precheck-$(date +%s).json
# Wait 6-8 min, then:
for b in af2-tpu esmfold-tpu boltz2-tpu af2-gpu esmfold-gpu boltz2-gpu; do
  gsutil cat gs://wz-nih-demo-shared/job/$b.json 2>/dev/null | \
    python3 -c "import sys,json; d=json.load(sys.stdin); print(f\"{d['state']:12s} {d['elapsed_ms']:6d}ms\")"
  printf "%-16s\n" "$b"
done
# expect: all 6 done (not failed)
```

If ANY check fails, fix it before presenting. There is also a Playwright spec that runs the full press-Enter test against the deployed frontend:

```bash
cd local-controller/frontend
FRONTEND_URL=https://protein-demo-frontend-212183265679.us-east5.run.app \
  ./node_modules/.bin/playwright test tests/e2e-prod-press-enter.spec.ts --reporter=list
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Jobs fail ExitCode=1 | `docker exec slurmd tail -20 /tmp/{backend}.log` |
| TPU "VFIO busy" | Stop tpu-runtime: `docker update --restart=no tpu-runtime; docker stop tpu-runtime` |
| GPU "CUDA not found" | `docker exec slurmd ldconfig`; mount NVIDIA libs from host |
| Disk full | `docker system prune -af` (each image ~12GB) |
| Badge stuck on `loading` | sentinel >10min — check `/tmp/tpu-keepwarm.log` for SKIP reasons; if keep-warm is misbehaving, `sudo /opt/tpu-keep-warm.sh` manually |
| east5a-3 server gone after reboot | Re-check `lsmod | grep vfio`, `/etc/modules-load.d/vfio.conf`, container `--restart=always` policies |
| Node "idle*" or "Not responding" | Restart slurmd: `docker exec slurmd bash -c 'slurmd --conf-server=172.16.0.2:6820 -N <name> &'` |
| predict.sh double-run | `systemctl stop trigger-watcher` before manual runs |

## Files

```
backends/
  af2-tpu/predict.py             # AlphaFold 2 on JAX (CPU on TPU VM, isolated venv)
  af2-gpu/predict.py             # AlphaFold 2 on JAX (CUDA)
  esmfold-tpu/predict.py         # ESMFold client — tries warm server, falls back to eager-mode direct
  esmfold-gpu/predict.py         # ESMFold on CUDA (transformers)
  boltz2-tpu/predict.py          # Boltz-2 client — uses BOLTZ_HOST env var to reach east5a-3
  boltz2-gpu/predict.py          # Boltz-2 stock CLI on CUDA
  tpu-esmfold-server.py          # Warm ESMFold server (east5a-0:8090) — eager mode, priority lock
  tpu-boltz2-server.py           # Warm Boltz-2 server (east5a-3:8091) — fasta_content protocol

containers/
  tpu/Dockerfile                 # slurm-compute + torch_xla + jax + AF2 + boltz
  gpu/Dockerfile                 # slurm-compute + torch-cu124 + jax-cuda + AF2 + boltz

scripts/
  deploy_frontend.sh             # Build Vite + push to Cloud Run
  deploy_server.sh               # Build Flask state server + push to Cloud Run
  deploy_controller.sh           # Upload scripts + (re)install systemd on controller VM
  predict.sh                     # 2-phase Spot→guaranteed sbatch dispatcher
  run_backend.sh                 # Per-backend job runner (state events, predict.py invocation)
  poll_squeue.sh                 # slurmctld event scraper
  watch_triggers.sh              # GCS trigger → predict.sh (systemd-managed, flock-guarded)
  env.sh                         # Project IDs, region, pricing, BOLTZ_HOST/PORT
  generate_af2_features.py       # ColabFold MMseqs2 helper for AF2 features.pkl
  tpu-server-health.sh           # Cron (*/5): probe + restart + badge update
  tpu-keep-warm.sh               # Cron (*/8): re-fire all 12 shapes
  prewarm_all_proteins.sh        # Fires 6 ESMFold + 6 Boltz-2 POSTs; sentinel + status
  gpu-health.sh                  # Cron (*/10) on GPU VMs
  gpu-node-setup.sh              # CUDA/ldconfig/weights fix inside GPU container

local-controller/
  Dockerfile                     # State server (Flask) container for Cloud Run
  server.py                      # Flask: POST /api/submit (writes trigger), GET /api/status, GET /api/health
  .gcloudignore                  # Excludes venv/, frontend/, terraform/, slurm/ from Cloud Build
  frontend/
    Dockerfile                   # nginx:alpine serving dist/ on port 8080
    nginx.conf                   # SPA fallback + cache headers
    .gcloudignore                # Whitelists dist/ for Cloud Build
    src/                         # React HUD source (Vite)
    .env                         # VITE_GOOGLE_MAPS_API_KEY, VITE_STATE_SERVER (gitignored)
    tests/e2e-prod-press-enter.spec.ts  # Playwright E2E vs deployed frontend
```
