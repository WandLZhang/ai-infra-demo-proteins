# NIH Biowulf Protein Structure Prediction Demo

Live demo for the NIH Biowulf HPC briefing (June 4, 2026). Presenter presses Enter to dispatch 6 protein inference jobs (3 models × 2 silicons) via Slurm from an on-prem controller to cloud compute nodes across 3 CONUS regions.

## Architecture

```
┌─────────────────────────────┐     VPC Peering     ┌──────────────────────────────┐
│  wz-nih-demo-controller     │◄───────────────────►│  wz-nih-demo-burst           │
│                             │                     │                              │
│  biowulf-controller         │                     │  TPU v6e (us-east5-a)  w=10  │
│  - slurmctld                │                     │  TPU v6e (us-central1-b) w=11│
│  - server.py (:8080)        │                     │  A100 GPU (us-central1-f) w=10│
│  - trigger-watcher.service  │                     │  A100 GPU (us-west1-b)  w=11 │
│  - poll-squeue.service      │                     │  + Spot nodesets (w=1-2)     │
└─────────────────────────────┘                     └──────────────────────────────┘
         ▲                                                     │
         │ POST /api/submit                                    │ GCS events
         │                                                     ▼
    ┌────┴──────────────────────────────────────────────────────┐
    │  Frontend (Vite dev / Cloud Run prod)                     │
    │  Polls gs://wz-nih-demo-shared/job/log/*.json             │
    │  Polls gs://wz-nih-demo-shared/job/{backend}.json         │
    └───────────────────────────────────────────────────────────┘
```

## Projects & IAM

| Resource | Project | Service Account |
|----------|---------|-----------------|
| Controller VM | wz-nih-demo-controller | 281348638866-compute (objectAdmin on shared bucket) |
| Compute VMs | wz-nih-demo-burst | 212183265679-compute (objectAdmin on shared bucket) |
| GCS bucket | wz-nih-demo-shared | Both SAs have storage.objectAdmin |

## Compute Nodes

4 pre-warmed guaranteed nodes + Spot nodesets for failover visual:

| VM | Zone | Type | Weight | Role |
|----|------|------|--------|------|
| nihprotein-tpuv6ewest1c-[0-1] | us-west1-c | TPU v6e Spot | 1 | Try first (Spot, likely fails) |
| nihprotein-tpuv6eeast5b-[0-1] | us-east5-b | TPU v6e Spot | 2 | Try second (Spot) |
| nihprotein-a100spoteast5-[0-1] | us-east5 | A100 Spot | 1 | Try first (Spot, likely fails) |
| nihprotein-tpuv6eeast5a-0 | us-east5-a | TPU v6e | **10** | Guaranteed fallback |
| nihprotein-tpuv6ecentral1-0 | us-central1-b | TPU v6e | **11** | Guaranteed fallback |
| nihprotein-a100spotcentra-0 | us-central1-f | A100 40GB | **10** | Guaranteed fallback |
| nihprotein-a100west1-0 | us-west1-b | A100 40GB | **11** | Guaranteed fallback |

Weight ladder: Slurm tries lowest weight first. Spot nodes (w=1-2) fail → requeue → guaranteed nodes (w=10-11) succeed. Frontend shows yellow→red→green transition.

## GCS Layout

All state in `gs://wz-nih-demo-shared/job/` (flat, no run subfolders):

```
job/
  manifest.json          # run metadata (protein, submitted_at)
  af2-tpu.json           # backend state blob
  af2-gpu.json
  esmfold-tpu.json
  esmfold-gpu.json
  boltz2-tpu.json
  boltz2-gpu.json
  log/
    {nanosecond_ts}-{source}.json   # structured event stream
```

## Structured Event Schema

Every log event has `ts`, `type`, `msg`. Additional fields per type:

| type | Fields | Source |
|------|--------|--------|
| dispatch | backend, partition, job_id | predict.sh |
| sched_allocate | vm, region, partition | poll_squeue.sh |
| allocate | backend, vm, zone, region, partition, project | run_backend.sh |
| loading | backend, vm, zone, region, partition, project | run_backend.sh |
| inferring | backend, vm, zone, region, partition, project, protein_id, seq_len | run_backend.sh |
| done | backend, vm, zone, region, partition, project, elapsed_ms, cost | run_backend.sh |
| spot_fail | nodeset, region | poll_squeue.sh |
| requeue | job_id | poll_squeue.sh |

The frontend reads these fields directly — no text parsing. Terminal, side ladder, and map markers all update from the same event stream in lockstep.

## Deployment

### 1. Deploy scripts to controller + GCS

```bash
gsutil cp scripts/run_backend.sh scripts/env.sh scripts/predict.sh \
  scripts/poll_squeue.sh scripts/watch_triggers.sh gs://wz-nih-demo-shared/scripts/

gcloud compute scp scripts/*.sh local-controller/server.py \
  biowulf-controller:/opt/protein-demo/ \
  --zone=us-east5-a --project=wz-nih-demo-controller
```

### 2. Restart services on controller

```bash
gcloud compute ssh biowulf-controller --zone=us-east5-a --project=wz-nih-demo-controller --command="
  sudo systemctl restart trigger-watcher poll-squeue
  pkill -f 'python server.py' || true; sleep 2
  cd /opt/protein-demo && nohup /opt/protein-demo/venv/bin/python server.py > /tmp/server.log 2>&1 &
"
```

### 3. Verify Slurm nodes

```bash
gcloud compute ssh biowulf-controller --zone=us-east5-a --project=wz-nih-demo-controller \
  --command="sinfo -N -l | grep idle"
```

4 nodes should show `idle` (guaranteed, pre-warmed). Spot nodes show `idle~` (cloud, will auto-provision on demand).

### 4. Start IAP tunnel for server.py

```bash
gcloud compute start-iap-tunnel biowulf-controller 8080 \
  --local-host-port=localhost:8080 \
  --zone=us-east5-a --project=wz-nih-demo-controller
```

### 5. Start frontend

```bash
cd local-controller/frontend
echo "VITE_STATE_SERVER=http://localhost:8080" > .env.local
npm run dev
```

### 6. Press Enter

## Setting Up a New Compute Node

```bash
# SSH to the VM
# Install Docker if needed
sudo apt-get update -qq && sudo apt-get install -y -qq docker.io
sudo systemctl start docker

# Pull and run the Slurm container
sudo gcloud auth configure-docker us-east5-docker.pkg.dev --quiet
sudo docker pull us-east5-docker.pkg.dev/wz-nih-demo-burst/proteins/slurm-compute:latest
sudo docker run -d --name slurmd --privileged --net=host --restart=always \
  us-east5-docker.pkg.dev/wz-nih-demo-burst/proteins/slurm-compute:latest

# Start slurmd (container init downloads munge key, starts systemd)
sleep 10
sudo docker exec slurmd bash -c 'slurmd --conf-server=172.16.0.2:6820 -N <SLURM_NODE_NAME> &'
```

## Slurm Config

`/etc/slurm/cloud.conf` on biowulf-controller. Edit and run `sudo scontrol reconfigure`.

`/etc/slurm/slurm.conf` critical settings:
```
ProctrackType=proctrack/linuxproc
JobAcctGatherType=jobacct_gather/linux
TaskPlugin=task/affinity
SlurmctldHost=biowulf-controller(172.16.0.2)
```

GCS nodeset configs: `gs://slurm-nihprotein6e309/nihprotein-files/nodeset_configs/`

## Troubleshooting

- **Jobs fail ExitCode=1**: `HOME=/tmp` missing in sbatch --wrap. Docker containers don't have the submitting user's home dir.
- **No backend events**: Burst compute SA needs `storage.objectAdmin` on `gs://wz-nih-demo-shared`.
- **Node `idle~`**: slurmd not running. SSH → `docker exec slurmd ps aux | grep slurmd`.
- **TPU VM name mismatch**: run_backend.sh uses `SLURMD_NODENAME`, not GCE metadata instance name.
- **Stale GCS data**: predict.sh clears `job/` on each submit. If frontend polls stale data, clean manually: `gsutil -m rm -r gs://wz-nih-demo-shared/job`.

## Files

```
scripts/
  predict.sh             # sbatch entrypoint — dispatches 6 jobs
  run_backend.sh         # per-backend job — writes structured events to GCS
  env.sh                 # project IDs, pricing constants
  watch_triggers.sh      # GCS trigger watcher (systemd: trigger-watcher.service)
  poll_squeue.sh         # slurmctld event scraper (systemd: poll-squeue.service)

local-controller/
  server.py              # Flask: POST /api/submit writes trigger blob
  frontend/              # React HUD (Vite)

containers/
  Dockerfile.slurm-compute  # Slurm compute container (systemd + slurmd + gsutil)
```
