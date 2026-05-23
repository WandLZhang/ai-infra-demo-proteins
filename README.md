# NIH Biowulf Protein Structure Prediction Demo

Live HUD-style demo for the NIH Biowulf HPC briefing (June 4, 2026). A presenter presses Enter on a terminal overlay to dispatch 6 real protein inference jobs (3 models × 2 silicons) via Slurm across GCP regions.

## Architecture

```
┌──────────────────────┐     SSH/IAP      ┌───────────────────────┐
│  Cloud Workstation   │ ──────────────── │  biowulf-controller   │
│  or Cloud Run        │                  │  (wz-nih-demo-controller)
│                      │                  │                       │
│  server.py           │                  │  predict.sh → sbatch  │
│  - POST /api/submit  │                  │  slurmctld 25.05.6    │
│  - GET /api/status   │                  │  VPC peered to burst  │
│  - GET /api/latest   │                  └──────────┬────────────┘
│                      │                             │ Slurm resume
│  Frontend (Vite/React)                             ▼
│  - Google Maps HUD   │                  ┌───────────────────────┐
│  - Terminal overlay   │                  │  wz-nih-demo-burst    │
│  - Side ladder        │                  │  Spot GPU + TPU nodes │
│  - Info button slides │                  │  A100, TPU v6e        │
└──────────────────────┘                  │  run_backend.sh       │
         │                                │  → predict.py         │
         │ polls every 2s                 │  → GCS state blobs    │
         ▼                                └───────────────────────┘
┌──────────────────────┐
│  gs://wz-nih-demo-shared/jobs/{run_id}/ │
│  manifest.json       │
│  af2-tpu.json        │  ← state: queued → allocating → inferring → done
│  af2-gpu.json        │
│  esmfold-tpu.json    │
│  esmfold-gpu.json    │
│  boltz2-tpu.json     │
│  boltz2-gpu.json     │
└──────────────────────┘
```

## Two GCP Projects

| Project | Role | Network |
|---------|------|---------|
| `wz-nih-demo-controller` | On-prem simulation. Runs slurmctld, server.py | `onprem-net` (172.16.0.0/20) |
| `wz-nih-demo-burst` | STRIDES cloud burst. Compute nodesets, model containers | `default` (10.x.x.x) |

VPC peering connects the two. In production, this maps to 400G Dedicated Interconnect from Building 12 to Ashburn.

## Setup

### 1. Deploy state server + scripts to controller VM

```bash
bash scripts/deploy_controller.sh
```

This SCPs `server.py`, `predict.sh`, `run_backend.sh`, and `env.sh` to `/opt/protein-demo/` on `biowulf-controller`, installs Python deps in a venv, and starts the Flask server on port 8080.

### 2. Run server.py locally (alternative — for development)

```bash
cd local-controller
python3 -m venv venv && source venv/bin/activate
pip install flask flask-cors google-cloud-storage
python server.py
```

server.py SSHes to the controller VM for sbatch and reads GCS directly for status.

### 3. Start the frontend

```bash
cd local-controller/frontend
npm install
npx vite --port 5174 --host 0.0.0.0
```

Set `VITE_STATE_SERVER` in `.env` to wherever server.py is reachable from the browser.

### 4. Press Enter

The terminal overlay shows a real `sbatch` command. Pressing Enter triggers:
1. `POST /api/submit` → server.py SSHes to controller VM
2. `predict.sh` runs on the VM → writes manifest + 6 "queued" blobs to GCS → sbatch 6 jobs
3. Frontend polls `GET /api/status/{run_id}` every 2 seconds
4. Side ladder fills in as backends progress through states
5. Map zooms from Building 12 to CONUS, markers light up at active zones

## Files

```
scripts/
  env.sh              # Project IDs, bucket, pricing constants
  predict.sh          # sbatch entrypoint — dispatches 6 jobs
  run_backend.sh      # Per-backend job wrapper — updates GCS state, runs predict.py
  deploy_controller.sh # One-shot deploy to controller VM

local-controller/
  server.py           # Flask GCS proxy + SSH submit trigger
  frontend/           # React + Vite HUD frontend

backends/
  af2-tpu/            # AlphaFold 2 on TPU v6e (JAX)
  af2-gpu/            # AlphaFold 2 on GPU (JAX)
  esmfold-tpu/        # ESMFold on TPU (TorchTPU)
  esmfold-gpu/        # ESMFold on GPU (PyTorch)
  boltz2-tpu/         # Boltz-2 on TPU (10 patches, eager mode)
  boltz2-gpu/         # Boltz-2 on GPU (stock)
```

## GCS State Protocol

Each backend writes a JSON blob to `gs://wz-nih-demo-shared/jobs/{run_id}/{backend_id}.json`:

```json
{
  "backend_id": "esmfold-tpu",
  "run_id": "20260604-100000",
  "state": "inferring",
  "started_at": "2026-06-04T10:00:02Z",
  "elapsed_ms": 12000,
  "cost_accumulated": 0.00667,
  "result": null
}
```

States: `queued` → `allocating` → `loading` → `inferring` → `done` (or `failed`).

The frontend maps these to the side ladder UI and triggers phase transitions (dispatching → running → done).
