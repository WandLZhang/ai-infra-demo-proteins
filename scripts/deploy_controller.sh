#!/bin/bash
# deploy_controller.sh — Deploy state server + scripts to the biowulf-controller VM.
#
# Prerequisites:
#   - gcloud CLI authenticated with IAP tunnel access to the controller project
#   - biowulf-controller VM running in wz-nih-demo-controller
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

echo "=== Deploying to $VM ($ZONE, $PROJECT) ==="

SSH_CMD="gcloud compute ssh $VM --zone=$ZONE --project=$PROJECT --tunnel-through-iap"

echo "[1/4] Creating deploy directory..."
$SSH_CMD --command="sudo mkdir -p $DEPLOY_DIR && sudo chown \$(whoami) $DEPLOY_DIR"

echo "[2/4] Uploading scripts..."
gcloud compute scp \
  "$REPO_ROOT/local-controller/server.py" \
  "$SCRIPT_DIR/predict.sh" \
  "$SCRIPT_DIR/run_backend.sh" \
  "$SCRIPT_DIR/env.sh" \
  "$VM:$DEPLOY_DIR/" \
  --zone="$ZONE" --project="$PROJECT" --tunnel-through-iap

# Fix PREDICT_SCRIPT path for VM layout (all files in same directory)
$SSH_CMD --command="sed -i 's|os.path.join(os.path.dirname(__file__), \"..\", \"scripts\", \"predict.sh\")|os.path.join(os.path.dirname(os.path.abspath(__file__)), \"predict.sh\")|' $DEPLOY_DIR/server.py"

echo "[3/4] Installing Python dependencies..."
$SSH_CMD --command="
  if [ ! -d $DEPLOY_DIR/venv ]; then
    python3 -m venv $DEPLOY_DIR/venv
  fi
  $DEPLOY_DIR/venv/bin/pip install -q flask flask-cors google-cloud-storage
"

echo "[4/4] Starting state server..."
$SSH_CMD --command="
  pkill -f 'protein-demo.*server.py' 2>/dev/null || true
  sleep 1
  cd $DEPLOY_DIR
  nohup $DEPLOY_DIR/venv/bin/python server.py > /tmp/state-server.log 2>&1 &
  echo \$!
"

sleep 3
$SSH_CMD --command="curl -s http://localhost:8080/api/health"

echo ""
echo "=== Deploy complete ==="
echo "State server running on $VM:8080"
echo "Logs: $SSH_CMD --command='tail -f /tmp/state-server.log'"
