# NIH Protein Demo — Deployment Guide

Cross-project Slurm cloud bursting demo: 6 protein structure prediction backends
(3 models × 2 silicons) dispatch from an on-prem controller to cloud compute
nodes across 3 CONUS regions.

## Architecture

```
┌─────────────────────────────┐     VPC Peering     ┌──────────────────────────────┐
│  wz-nih-demo-controller     │◄───────────────────►│  wz-nih-demo-burst           │
│                             │                     │                              │
│  biowulf-controller         │                     │  TPU v6e (us-east5-a)        │
│  - slurmctld                │                     │  TPU v6e (us-central1-b)     │
│  - server.py (Cloud Run)    │                     │  A100 GPU (us-central1-f)    │
│  - trigger-watcher.service  │                     │  A100 GPU (us-west1-b)       │
│  - poll-squeue.service      │                     │                              │
└─────────────────────────────┘                     └──────────────────────────────┘
         ▲                                                     │
         │ POST /api/submit                                    │ GCS events
         │                                                     ▼
    ┌────┴──────────────────────────────────────────────────────┐
    │  Frontend (Vite)                                          │
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

| VM | Zone | Type | Provisioning | Weight |
|----|------|------|-------------|--------|
| nihprotein-tpuv6eeast5a-0 | us-east5-a | TPU v6e-4 | DWS Flex / keep-alive | 1 |
| nihprotein-tpuv6ecentral1-0 | us-central1-b | TPU v6e-4 | Spot / keep-alive | 2 |
| nihprotein-a100spotcentra-0 | us-central1-f | a2-highgpu-1g (A100 40GB) | Spot / keep-alive | 1 |
| nihprotein-a100west1-0 | us-west1-b | a2-highgpu-1g (A100 40GB) | On-demand / keep-alive | 2 |

All 4 nodes in `SuspendExcNodes` — Slurm keeps them alive between runs.

## Slurm Config

2 partitions with weight-based auto-distribution. File: `/etc/slurm/cloud.conf` on biowulf-controller.

- `tpu` partition: tpuv6eeast5a (w=1), tpuv6ecentral1 (w=2)
- `gpu` partition: a100spotcentra (w=1), a100west1 (w=2)

Slurm fills lowest-weight nodes first, overflows to higher-weight.

## GCS Layout

All state in `gs://wz-nih-demo-shared/job/` (flat, no run subfolders):

```
job/
  manifest.json          # run metadata (protein, submitted_at)
  af2-tpu.json           # backend state blob (state, cost, elapsed)
  af2-gpu.json
  esmfold-tpu.json
  esmfold-gpu.json
  boltz2-tpu.json
  boltz2-gpu.json
  log/
    {nanosecond_ts}-{source}.json   # structured event stream
```

### Structured Event Schema

Every event has `ts`, `type`, `msg`. Additional fields per type:

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

## Event Flow

```
Press Enter → frontend POST /api/submit → server.py writes trigger blob
→ trigger-watcher.service detects blob → runs predict.sh
→ predict.sh clears job/, writes manifest + queued blobs, sbatch × 6
→ Each sbatch --wrap downloads scripts from GCS, runs run_backend.sh
→ run_backend.sh writes structured events + state blobs to GCS
→ poll_squeue.service writes slurmctld events (spot_fail, sched_allocate)
→ Frontend polls GCS, drip-queues events with real timestamps
→ Each event updates terminal + side ladder + map markers in lockstep
```

## Deployment Steps

### 1. Deploy scripts to controller + GCS

```bash
# Upload scripts to GCS (compute nodes pull these at job start)
gsutil cp scripts/run_backend.sh scripts/env.sh scripts/predict.sh gs://wz-nih-demo-shared/scripts/

# Deploy to controller
gcloud compute scp scripts/*.sh local-controller/server.py \
  biowulf-controller:/opt/protein-demo/ \
  --zone=us-east5-a --project=wz-nih-demo-controller
```

### 2. Restart services on controller

```bash
gcloud compute ssh biowulf-controller --zone=us-east5-a --project=wz-nih-demo-controller --command="
  sudo systemctl restart trigger-watcher poll-squeue
  pkill -f 'python server.py' || true
  sleep 2
  cd /opt/protein-demo && nohup /opt/protein-demo/venv/bin/python server.py > /tmp/server.log 2>&1 &
"
```

### 3. Verify Slurm nodes

```bash
gcloud compute ssh biowulf-controller --zone=us-east5-a --project=wz-nih-demo-controller \
  --command="sinfo -N -l | grep idle"
```

All 4 nodes should show `idle` (not `idle~` or `down~`).

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

### 6. Press Enter in the browser

## Setting up a new compute node

Each compute node runs slurmd inside a Docker container:

```bash
# 1. SSH to the VM
# 2. Install Docker if needed
sudo apt-get update -qq && sudo apt-get install -y -qq docker.io
sudo systemctl start docker

# 3. Pull and run the Slurm container
sudo gcloud auth configure-docker us-east5-docker.pkg.dev --quiet
sudo docker pull us-east5-docker.pkg.dev/wz-nih-demo-burst/proteins/slurm-compute:latest
sudo docker run -d --name slurmd --privileged --net=host --restart=always \
  us-east5-docker.pkg.dev/wz-nih-demo-burst/proteins/slurm-compute:latest

# 4. Start slurmd with the node's Slurm name
sleep 10
sudo docker exec slurmd bash -c 'slurmd --conf-server=172.16.0.2:6820 -N <NODE_NAME> &'
```

The container init downloads the munge key from GCS and starts systemd. slurmd connects to the controller at 172.16.0.2:6820 via VPC peering.

## Slurm config (cloud.conf)

To update partitions/nodesets, edit `/etc/slurm/cloud.conf` on biowulf-controller and run `sudo scontrol reconfigure`. The GCS nodeset configs live in `gs://slurm-nihprotein6e309/nihprotein-files/nodeset_configs/` and are read by resume.py for auto-provisioning.

## Troubleshooting

- **Jobs fail with ExitCode=1**: Check `HOME=/tmp` in the sbatch --wrap command. Docker containers don't have the submitting user's home dir — gsutil needs HOME for credential cache.
- **No backend events in GCS**: Verify burst compute SA has `storage.objectAdmin` on `gs://wz-nih-demo-shared`.
- **Node shows `idle~`**: slurmd not running or not registered. SSH to the VM, check `docker exec slurmd ps aux | grep slurmd`.
- **TPU VM name mismatch**: run_backend.sh uses `SLURMD_NODENAME` (Slurm node name) not the GCE metadata instance name (TPU worker name like `t1v-n-...`).
