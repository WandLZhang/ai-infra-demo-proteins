#!/bin/bash
# deploy_controller.sh — Deploy scripts + configure the Slurm controller VM.
#
# Deploys predict.sh, run_backend.sh, watch_triggers.sh, poll_squeue.sh,
# env.sh to the controller VM. Installs Python deps. Fixes resume.py
# shebang. Sets Slurm timeouts for demo pacing. Starts the trigger watcher.
#
# Prerequisites:
#   - gcloud CLI authenticated with IAP tunnel access to $CONTROLLER_PROJECT_ID
#   - Controller VM running in $CONTROLLER_PROJECT_ID / $CONTROLLER_VM_ZONE
#   - Slurm 25.05.6 installed and slurmctld running on the VM
#
# Usage:
#   bash scripts/deploy_controller.sh

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/env.sh"

VM="$CONTROLLER_VM_NAME"
ZONE="$CONTROLLER_VM_ZONE"
PROJECT="$CONTROLLER_PROJECT_ID"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/protein-demo}"

# Look up controller project number for the compute SA email.
CONTROLLER_PROJECT_NUMBER=$(gcloud projects describe "$CONTROLLER_PROJECT_ID" \
  --format='value(projectNumber)')

ssh_cmd() {
  gcloud compute ssh "$VM" --zone="$ZONE" --project="$PROJECT" --tunnel-through-iap --command="$1" 2>&1 | grep -v "To increase the performance"
}

echo "=== Deploying to $VM ($ZONE, $PROJECT) ==="

echo "[1/7] Creating deploy directory..."
ssh_cmd "sudo mkdir -p $DEPLOY_DIR && sudo chown \$(whoami) $DEPLOY_DIR"

echo "[2/7] Uploading scripts..."
# SCP to /tmp first, then sudo mv into $DEPLOY_DIR. Files in $DEPLOY_DIR
# from prior deploys are root-owned (chmod +x via sudo earlier), so direct
# scp overwrite fails with Permission denied even though the directory
# itself is user-owned. /tmp is always writable; sudo mv works.
gcloud compute scp \
  "$SCRIPT_DIR/predict.sh" \
  "$SCRIPT_DIR/run_backend.sh" \
  "$SCRIPT_DIR/watch_triggers.sh" \
  "$SCRIPT_DIR/poll_squeue.sh" \
  "$SCRIPT_DIR/env.sh" \
  "$VM:/tmp/" \
  --zone="$ZONE" --project="$PROJECT" --tunnel-through-iap 2>&1 | grep -v "To increase"
ssh_cmd "
  for f in predict.sh run_backend.sh watch_triggers.sh poll_squeue.sh env.sh; do
    sudo mv /tmp/\$f $DEPLOY_DIR/\$f
    sudo chmod +x $DEPLOY_DIR/\$f
  done
"

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
CTRL_SA="${CONTROLLER_PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
BURST_SA="${BURST_PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
# Project-level roles (idempotent)
for ROLE in roles/tpu.admin roles/compute.instanceAdmin.v1 roles/storage.objectAdmin; do
  gcloud projects add-iam-policy-binding "$BURST_PROJECT_ID" \
    --member="serviceAccount:$CTRL_SA" --role="$ROLE" --condition=None --quiet 2>/dev/null || true
done
# Controller SA needs serviceAccountUser on burst SA to create TPU VMs
# (TPU API requires it when specifying the VM's service account)
gcloud iam service-accounts add-iam-policy-binding "$BURST_SA" \
  --project="$BURST_PROJECT_ID" \
  --member="serviceAccount:$CTRL_SA" \
  --role="roles/iam.serviceAccountUser" --quiet 2>/dev/null || true

echo "[7/7] Installing trigger watcher as systemd service..."
ssh_cmd "
  sudo tee /etc/systemd/system/trigger-watcher.service > /dev/null << 'UNIT'
[Unit]
Description=GCS Trigger Watcher for Protein Demo
After=network-online.target slurmctld.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=/bin/bash /opt/protein-demo/watch_triggers.sh
Restart=always
RestartSec=5
StandardOutput=append:/var/log/trigger-watcher.log
StandardError=append:/var/log/trigger-watcher.log

[Install]
WantedBy=multi-user.target
UNIT
  sudo systemctl daemon-reload
  sudo systemctl enable trigger-watcher
  sudo systemctl restart trigger-watcher
"

sleep 3
echo ""
echo "=== Verifying ==="
ssh_cmd "sudo systemctl is-active trigger-watcher"
ssh_cmd "sudo tail -3 /var/log/trigger-watcher.log"
ssh_cmd "sinfo"

echo ""
echo "=== Deploy complete ==="
echo "Trigger watcher: systemd service (auto-restarts, survives reboot)"
echo "Slurm timeouts: ResumeTimeout=180s, SuspendTime=120s, SuspendTimeout=60s"
echo "Logs: gcloud compute ssh $VM --zone=$ZONE --project=$PROJECT --tunnel-through-iap --command='sudo tail -f /var/log/trigger-watcher.log'"
