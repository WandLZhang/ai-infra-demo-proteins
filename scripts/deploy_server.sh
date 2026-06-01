#!/bin/bash
# deploy_server.sh — Build and deploy the Flask state server to Cloud Run.
#
# server.py is a GCS proxy: /api/submit writes a trigger blob,
# /api/status reads the 6 backend state blobs. The trigger watcher on the
# Slurm controller VM picks up the trigger and fires predict.sh.
#
# Live URL: https://protein-demo-server-212183265679.us-east5.run.app
#
# Prerequisites:
#   - gcloud authenticated with deploy access to wz-nih-demo-burst
#   - Default compute SA (212183265679-compute@...) has roles/storage.admin
#     on wz-nih-demo-shared (verified)
#
# Usage:
#   bash scripts/deploy_server.sh

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/env.sh"

SERVER_DIR="$REPO_ROOT/local-controller"
SERVICE="protein-demo-server"
REGION="us-east5"
PROJECT="$BURST_PROJECT_ID"

echo "=== Deploying $SERVICE to Cloud Run ==="
echo "  Project: $PROJECT"
echo "  Region:  $REGION"
echo "  Source:  $SERVER_DIR"
echo ""

cd "$SERVER_DIR"
gcloud run deploy "$SERVICE" \
  --source . \
  --project="$PROJECT" \
  --region="$REGION" \
  --allow-unauthenticated \
  --port=8080 \
  --memory=512Mi \
  --cpu=1 \
  --max-instances=10 \
  --set-env-vars="STATE_BUCKET=wz-nih-demo-shared"

echo ""
echo "=== Done ==="
URL=$(gcloud run services describe "$SERVICE" --project="$PROJECT" --region="$REGION" --format="value(status.url)")
echo "URL: $URL"
echo ""
echo "Health: curl $URL/api/health"
