# NIH Biowulf Protein Structure Prediction Demo

Live HUD-style demo for the NIH Biowulf HPC briefing (June 4, 2026). Presenter presses Enter to dispatch 6 real protein inference jobs (3 models × 2 silicons) via Slurm across GCP regions.

## Architecture

```
Browser                          Cloud Run                        Controller VM                    Burst Project
───────                          ─────────                        ─────────────                    ─────────────
                                 protein-demo-server              biowulf-controller               wz-nih-demo-burst
                                 (wz-nih-demo-burst)              (wz-nih-demo-controller)

Press Enter ──► POST /api/submit ──► writes trigger blob ──────►  watch_triggers.sh picks up
                                     to GCS                       ──► predict.sh
                                                                  ──► sbatch 6 jobs ──────────►   resume.py creates
                                                                  ──► poll_squeue.sh starts        Spot VMs (GPU/TPU)
                                                                      writes events.json           ──► run_backend.sh
                                                                      updates lane blobs               writes state to GCS

◄── fetch(storage.googleapis.com/wz-nih-demo-shared/jobs/{run_id}/*.json) ◄─────────────────────────────────────────────
    Browser reads GCS directly (bucket is publicly readable, CORS enabled)
```

## Two GCP Projects

| Project | Role | Network |
|---------|------|---------|
| `wz-nih-demo-controller` | On-prem simulation. Runs slurmctld, trigger watcher | `onprem-net` (172.16.0.0/20) |
| `wz-nih-demo-burst` | STRIDES cloud burst. Spot GPU + TPU compute nodes | `default` (10.x.x.x) |

VPC peering connects the two. In production this maps to 400G Dedicated Interconnect.

## Setup

### 1. Deploy to controller VM

```bash
bash scripts/deploy_controller.sh
```

This does everything: uploads scripts, installs deps, fixes resume.py shebang, sets demo-paced Slurm timeouts (3 min resume, 2 min suspend), grants cross-project IAM (tpu.admin, compute.instanceAdmin, storage.objectAdmin), starts the trigger watcher.

### 2. Deploy Cloud Run (submit endpoint)

```bash
cd local-controller
gcloud run deploy protein-demo-server \
  --source=. \
  --project=wz-nih-demo-burst \
  --region=us-east5 \
  --allow-unauthenticated
```

### 3. Start frontend

```bash
cd local-controller/frontend
npm install
echo "VITE_STATE_SERVER=https://protein-demo-server-212183265679.us-east5.run.app" > .env
npx vite --port 5174 --host 0.0.0.0
```

### 4. Press Enter

## GCS State Protocol

Bucket: `gs://wz-nih-demo-shared` (publicly readable, CORS enabled)

```
jobs/{run_id}/
  manifest.json          ← written by predict.sh at submit
  af2-tpu.json           ← per-backend state blob
  af2-gpu.json
  esmfold-tpu.json
  esmfold-gpu.json
  boltz2-tpu.json
  boltz2-gpu.json
  events.json            ← streaming Slurm events from poll_squeue.sh

triggers/{run_id}.json   ← written by Cloud Run, consumed by watch_triggers.sh
```

Lane states: `idle` → `queued` → `allocating` → `loading` → `inferring` → `done` (or `failed`)

Events include: node allocations, Spot capacity failures, requeues, zone failovers.

## Files

```
scripts/
  env.sh                 # Project IDs, bucket, pricing constants
  predict.sh             # sbatch entrypoint — dispatches 6 jobs, writes initial GCS state
  run_backend.sh         # Per-backend Slurm job — runs predict.py, updates GCS state
  watch_triggers.sh      # Polls GCS for trigger blobs, runs predict.sh + poll_squeue.sh
  poll_squeue.sh         # Streams live Slurm state (squeue + slurmctld.log) to GCS
  deploy_controller.sh   # One-shot deploy to controller VM

local-controller/
  server.py              # Cloud Run service — POST /api/submit writes trigger to GCS
  Dockerfile             # Container for Cloud Run
  frontend/              # React + Vite HUD frontend

backends/
  af2-tpu/               # AlphaFold 2 on TPU v6e (JAX)
  af2-gpu/               # AlphaFold 2 on GPU (JAX)
  esmfold-tpu/           # ESMFold on TPU (TorchTPU)
  esmfold-gpu/           # ESMFold on GPU (PyTorch)
  boltz2-tpu/            # Boltz-2 on TPU (10 patches, eager mode)
  boltz2-gpu/            # Boltz-2 on GPU (stock)
```

## Slurm Timeouts (demo-paced)

| Setting | Default | Demo |
|---------|---------|------|
| ResumeTimeout | 900s (15 min) | 180s (3 min) |
| SuspendTime | 300s (5 min) | 120s (2 min) |
| SuspendTimeout | 300s (5 min) | 60s (1 min) |

## Cross-Project IAM

Controller SA (`{controller-project-number}-compute@developer.gserviceaccount.com`) needs in burst project:
- `roles/compute.instanceAdmin.v1` — create/delete GPU VMs
- `roles/tpu.admin` — create/delete TPU VMs
- `roles/storage.objectAdmin` — read/write GCS state blobs

Cloud Run SA (`{burst-project-number}-compute@developer.gserviceaccount.com`) needs:
- `roles/storage.objectAdmin` on the shared bucket (write triggers, read state)
