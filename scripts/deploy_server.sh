#!/bin/bash
# deploy_server.sh — Build and deploy the Flask state server to Cloud Run.
#
# server.py is a GCS proxy: /api/submit writes a trigger blob,
# /api/status reads the 6 backend state blobs. The trigger watcher on the
# Slurm controller VM picks up the trigger and fires predict.sh.
#
# Cloud Run service URL is printed at the end; paste it into
# local-controller/frontend/.env as VITE_STATE_SERVER before deploying
# the frontend.
#
# Prerequisites:
#   - gcloud authenticated with deploy access to $BURST_PROJECT_ID
#   - Default compute SA ($BURST_PROJECT_NUMBER-compute@...) has
#     roles/storage.admin on $SHARED_BUCKET
#
# Usage:
#   bash scripts/deploy_server.sh

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/env.sh"

SERVER_DIR="$REPO_ROOT/local-controller"
SERVICE="${SERVICE:-protein-demo-server}"
REGION="${REGION:-$AR_REGION}"
PROJECT="$BURST_PROJECT_ID"
BUCKET_NAME="${SHARED_BUCKET#gs://}"

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
  --set-env-vars="STATE_BUCKET=$BUCKET_NAME"

echo ""
echo "=== Done ==="
URL=$(gcloud run services describe "$SERVICE" --project="$PROJECT" --region="$REGION" --format="value(status.url)")
echo "URL: $URL"
echo ""
echo "Health: curl $URL/api/health"
