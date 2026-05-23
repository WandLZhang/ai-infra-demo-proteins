#!/bin/bash
# deploy_controller.sh — Deploy scripts + configure the biowulf-controller VM.
#
# Deploys predict.sh, run_backend.sh, watch_triggers.sh, poll_squeue.sh,
# env.sh to the controller VM. Installs Python deps. Fixes resume.py
# shebang. Sets Slurm timeouts for demo pacing. Starts the trigger watcher.
#
# Prerequisites:
#   - gcloud CLI authenticated with IAP tunnel access to the controller project
#   - biowulf-controller VM running in wz-nih-demo-controller
#   - Slurm 25.05.6 installed and slurmctld running on the VM
#
# Usage:
#   bash scripts/deploy_controller.sh

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/env.sh"

VM="biowulf-controller"
ZONE="us-east5-a"
PROJECT="$CONTROLLER_PROJECT_ID"
DEPLOY_DIR="/opt/protein-demo"

ssh_cmd() {
  gcloud compute ssh "$VM" --zone="$ZONE" --project="$PROJECT" --tunnel-through-iap --command="$1" 2>&1 | grep -v "To increase the performance"
}

echo "=== Deploying to $VM ($ZONE, $PROJECT) ==="

echo "[1/7] Creating deploy directory..."
ssh_cmd "sudo mkdir -p $DEPLOY_DIR && sudo chown \$(whoami) $DEPLOY_DIR"

echo "[2/7] Uploading scripts..."
gcloud compute scp \
  "$SCRIPT_DIR/predict.sh" \
  "$SCRIPT_DIR/run_backend.sh" \
  "$SCRIPT_DIR/watch_triggers.sh" \
  "$SCRIPT_DIR/poll_squeue.sh" \
  "$SCRIPT_DIR/env.sh" \
  "$VM:$DEPLOY_DIR/" \
  --zone="$ZONE" --project="$PROJECT" --tunnel-through-iap 2>&1 | grep -v "To increase"

echo "[3/7] Installing Python dependencies..."
ssh_cmd "
  if [ ! -d $DEPLOY_DIR/venv ]; then
    python3 -m venv $DEPLOY_DIR/venv
  fi
  $DEPLOY_DIR/venv/bin/pip install -q flask flask-cors google-cloud-storage
"

echo "[4/7] Fixing resume.py Python shebang..."
ssh_cmd "
  if [ ! -f /slurm/python/venv/bin/python3.13 ]; then
    sudo ln -s python3 /slurm/python/venv/bin/python3.13
  fi
  sudo /slurm/python/venv/bin/pip install -q addict 2>/dev/null || true
"

echo "[5/7] Setting Slurm timeouts for demo pacing..."
ssh_cmd "
  sudo sed -i 's/ResumeTimeout=900/ResumeTimeout=180/g' /etc/slurm/cloud.conf 2>/dev/null || true
  sudo sed -i 's/SuspendTimeout=300/SuspendTimeout=60/g' /etc/slurm/cloud.conf 2>/dev/null || true
  sudo sed -i 's/SuspendTime=300/SuspendTime=120/g' /etc/slurm/cloud.conf 2>/dev/null || true
  sudo chmod 644 /var/log/slurm/slurmctld.log 2>/dev/null || true
  sudo scontrol reconfigure 2>/dev/null || true
"

echo "[6/7] Granting cross-project permissions..."
CTRL_SA=\$(curl -s -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email 2>/dev/null || echo "")
# These are idempotent — safe to re-run
gcloud projects add-iam-policy-binding "$BURST_PROJECT_ID" \
  --member="serviceAccount:${CONTROLLER_PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role="roles/tpu.admin" --condition=None --quiet 2>/dev/null || true
gcloud projects add-iam-policy-binding "$BURST_PROJECT_ID" \
  --member="serviceAccount:${CONTROLLER_PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role="roles/compute.instanceAdmin.v1" --condition=None --quiet 2>/dev/null || true
gcloud projects add-iam-policy-binding "$BURST_PROJECT_ID" \
  --member="serviceAccount:${CONTROLLER_PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role="roles/storage.objectAdmin" --condition=None --quiet 2>/dev/null || true

echo "[7/7] Starting trigger watcher..."
ssh_cmd "
  cat > $DEPLOY_DIR/start_watcher.sh << 'SCRIPT'
#!/bin/bash
pkill -f watch_triggers 2>/dev/null
pkill -f poll_squeue 2>/dev/null
sleep 1
nohup bash /opt/protein-demo/watch_triggers.sh > /tmp/watch_triggers.log 2>&1 &
echo \$!
SCRIPT
  chmod +x $DEPLOY_DIR/start_watcher.sh
  bash $DEPLOY_DIR/start_watcher.sh
"

sleep 3
echo ""
echo "=== Verifying ==="
ssh_cmd "tail -3 /tmp/watch_triggers.log"
ssh_cmd "sinfo"

echo ""
echo "=== Deploy complete ==="
echo "Trigger watcher running on $VM"
echo "Slurm timeouts: ResumeTimeout=180s, SuspendTime=120s, SuspendTimeout=60s"
echo "Logs: gcloud compute ssh $VM --zone=$ZONE --project=$PROJECT --tunnel-through-iap --command='tail -f /tmp/watch_triggers.log'"
