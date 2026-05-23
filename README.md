# NIH Biowulf Protein Structure Prediction Demo

Live demo for the NIH Biowulf HPC briefing (June 4, 2026). Presenter presses Enter to dispatch 6 protein inference jobs (3 models × 2 silicons) via Slurm from an on-prem controller to cloud compute nodes.

## Architecture

```
Frontend (React)
  │  POST /api/submit
  ▼
Cloud Run ──► writes trigger to GCS
                    │
                    ▼  (~3s)
biowulf-controller (wz-nih-demo-controller, 172.16.0.2)
  │  trigger watcher → predict.sh → sbatch 6 jobs
  │  slurmctld dispatches to weighted nodesets
  ▼
Cloud compute nodes (wz-nih-demo-burst)
  │  resume.py creates VMs → startup.sh pulls Docker container
  │  slurmd registers with controller via VPC peering
  │  prolog stages run_backend.sh from GCS
  │  job runs → writes state to GCS
  ▼
GCS (gs://wz-nih-demo-shared/jobs/{run_id}/*.json)
  │  publicly readable, CORS enabled
  ▼
Frontend polls storage.googleapis.com directly
```

## Deployment — Step by Step

### 1. Pre-provision compute nodes (DWS Flex + on-demand)

Pre-warm VMs before the demo. They stay up for 7 days (Flex) or until deleted (on-demand).

```bash
# TPU v6e via DWS Flex (guaranteed capacity, us-east5-a)
gcloud alpha compute tpus queued-resources create demo-tpu \
  --project=wz-nih-demo-burst --zone=us-east5-a \
  --accelerator-type=v6e-4 --runtime-version=v2-alpha-tpuv6e \
  --node-id=nihprotein-tpuv6eeast5a-0 \
  --network=default --subnetwork=default \
  --service-account=212183265679-compute@developer.gserviceaccount.com

# A100 40GB on-demand (us-central1-f)
gcloud compute instances create nihprotein-a100spotcentra-0 \
  --project=wz-nih-demo-burst --zone=us-central1-f \
  --machine-type=a2-highgpu-1g \
  --accelerator=type=nvidia-tesla-a100,count=1 \
  --maintenance-policy=TERMINATE --no-restart-on-failure \
  --network=default \
  --service-account=212183265679-compute@developer.gserviceaccount.com \
  --scopes=cloud-platform \
  --image-family=ubuntu-2204-lts --image-project=ubuntu-os-cloud \
  --boot-disk-size=100GB
```

### 2. Set up each compute node with the Slurm container

Run this on **each** compute VM (TPU and GPU):

```bash
# SSH to the VM (use gcloud compute tpus tpu-vm ssh for TPU, gcloud compute ssh for GPU)
# Then run:

# Install Docker (GPU VMs only — TPU VMs have it pre-installed)
curl -fsSL https://get.docker.com | sudo sh

# Auth for Artifact Registry
sudo mkdir -p /root/.docker
echo '{"credHelpers":{"us-east5-docker.pkg.dev":"gcloud"}}' | sudo tee /root/.docker/config.json

# Pull container
sudo docker pull us-east5-docker.pkg.dev/wz-nih-demo-burst/proteins/slurm-compute:latest

# Set hostname to match Slurm nodeset name
sudo hostnamectl set-hostname nihprotein-tpuv6eeast5a-0  # or nihprotein-a100spotcentra-0

# Run container
sudo docker run -d --privileged --net=host --name=slurmd \
  --hostname=$(hostname) --entrypoint=/usr/bin/systemd \
  --restart unless-stopped \
  us-east5-docker.pkg.dev/wz-nih-demo-burst/proteins/slurm-compute:latest

# Copy munge key (must match biowulf-controller's key)
gsutil cat gs://wz-nih-demo-shared/munge.key.b64 | base64 -d > /tmp/munge.key
sudo docker cp /tmp/munge.key slurmd:/etc/munge/munge.key

# Configure slurmd inside container
sudo docker exec slurmd bash -c '
chown munge:munge /etc/munge/munge.key; chmod 400 /etc/munge/munge.key
echo SLURMD_OPTIONS=--conf-server=172.16.0.2:6820 > /etc/default/slurmd

# Create the submitting user (must match controller OS Login UID)
groupadd -g 1015145168 admin_williszhang_altostrat_com 2>/dev/null || true
useradd -u 1015145168 -g 1015145168 -m admin_williszhang_altostrat_com 2>/dev/null || true

# Prolog: stages job scripts from GCS at job start
mkdir -p /slurm/custom_scripts/prolog.d
cat > /slurm/custom_scripts/prolog.d/stage_scripts.sh << "PROLOG"
#!/bin/bash
mkdir -p /tmp/protein-demo
gsutil -q cp gs://wz-nih-demo-shared/scripts/run_backend.sh /tmp/protein-demo/
gsutil -q cp gs://wz-nih-demo-shared/scripts/env.sh /tmp/protein-demo/
chmod +x /tmp/protein-demo/run_backend.sh
PROLOG
chmod +x /slurm/custom_scripts/prolog.d/stage_scripts.sh

systemctl restart munge
systemctl restart slurmd
'
```

### 3. Register each node on biowulf-controller

```bash
gcloud compute ssh biowulf-controller --zone=us-east5-a --project=wz-nih-demo-controller --tunnel-through-iap

# Add hostname → IP mapping
echo '10.202.0.14 nihprotein-tpuv6eeast5a-0' | sudo tee -a /etc/hosts
echo '10.128.0.39 nihprotein-a100spotcentra-0' | sudo tee -a /etc/hosts

# Register with Slurm
sudo scontrol update NodeName=nihprotein-tpuv6eeast5a-0 NodeAddr=10.202.0.14 State=IDLE
sudo scontrol update NodeName=nihprotein-a100spotcentra-0 NodeAddr=10.128.0.39 State=IDLE

# Verify
sinfo  # Should show nodes as "idle" (not "idle~")
```

### 4. Upload job scripts to GCS

```bash
gsutil cp scripts/run_backend.sh scripts/env.sh gs://wz-nih-demo-shared/scripts/
```

### 5. Start frontend

```bash
cd local-controller/frontend
npm install
echo "VITE_STATE_SERVER=https://protein-demo-server-212183265679.us-east5.run.app" > .env
npx vite --port 5174 --host 0.0.0.0
```

### 6. Press Enter

## Key Infrastructure Details

### Slurm Config (biowulf-controller)

These settings are required for cross-project burst with cgroup v2 compute nodes:

```
ProctrackType=proctrack/linuxproc    # not cgroup (v1 only binary)
JobAcctGatherType=jobacct_gather/linux
TaskPlugin=task/affinity             # remove task/cgroup
SlurmctldHost=biowulf-controller(172.16.0.2)
SlurmctldPort=6820-6830
```

`cgroup.conf`:
```
CgroupPlugin=cgroup/v1
ConstrainCores=no
ConstrainRamSpace=no
```

### GCS Cluster Config (gs://slurm-nihprotein6e309/nihprotein-files/config.yaml)

```yaml
slurm_control_host: "172.16.0.2"     # raw IP, not hostname
slurm_control_addr: null              # avoids host(addr):port format
disable_default_mounts: true          # no /home, /opt/apps NFS
network_storage: []                   # no gcsfuse
munge_mount: {server_ip: "10.202.0.7", ...}   # nihprotein-controller NFS
slurm_key_mount: {server_ip: "10.202.0.7", ...}
docker_image: us-east5-docker.pkg.dev/wz-nih-demo-burst/proteins/slurm-compute:latest
```

### Cross-Project IAM

Controller SA (`281348638866-compute@developer.gserviceaccount.com`) needs on burst project:
- `roles/tpu.admin`
- `roles/compute.instanceAdmin.v1`
- `roles/storage.objectAdmin`
- `roles/iam.serviceAccountUser` on burst default SA

### Container Image

Built from `containers/Dockerfile.slurm-compute`. Includes systemd, slurmd 25.05.6, munge, gcloud CLI, Python venv. Slurm binary tarball at `gs://wz-nih-demo-shared/slurm-25.05-bin.tar.gz`.

```bash
cd containers
gsutil cp gs://wz-nih-demo-shared/slurm-25.05-bin.tar.gz .
cp Dockerfile.slurm-compute Dockerfile
gcloud builds submit --tag=us-east5-docker.pkg.dev/wz-nih-demo-burst/proteins/slurm-compute:latest \
  --project=wz-nih-demo-burst --region=us-east5 .
```

## Files

```
scripts/
  predict.sh             # sbatch entrypoint (controller)
  run_backend.sh         # per-backend job (compute node, staged from GCS)
  env.sh                 # project IDs, pricing
  deploy_controller.sh   # one-shot controller setup
  watch_triggers.sh      # GCS trigger watcher (systemd service)
  poll_squeue.sh         # streams Slurm events to GCS

local-controller/
  server.py              # Cloud Run: POST /api/submit writes GCS trigger
  Dockerfile             # Cloud Run container
  frontend/              # React HUD

containers/
  Dockerfile.slurm-compute  # Slurm compute container
  slurmd.service             # systemd units for container
  sackd.service
  slurmcmd.timer/service

backends/
  {af2,esmfold,boltz2}-{tpu,gpu}/predict.py  # ML inference (staged from GCS)
```
