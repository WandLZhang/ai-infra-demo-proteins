#!/bin/bash
# deploy_frontend.sh — Build and deploy the React HUD to Cloud Run.
#
# Builds the Vite app locally (so VITE_* values from local-controller/frontend/.env
# are baked into the bundle without uploading the .env file to Cloud Build),
# then containerizes the dist/ folder behind nginx and deploys to Cloud Run
# in the same project/region as the state server.
#
# Live URL: https://protein-demo-frontend-212183265679.us-east5.run.app
#
# Prerequisites:
#   - gcloud CLI authenticated with deploy access to wz-nih-demo-burst
#   - npm + Node.js installed locally
#   - local-controller/frontend/.env populated (VITE_GOOGLE_MAPS_API_KEY,
#     VITE_STATE_SERVER)
#
# Usage:
#   bash scripts/deploy_frontend.sh

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/env.sh"

FRONTEND_DIR="$REPO_ROOT/local-controller/frontend"
SERVICE="protein-demo-frontend"
REGION="us-east5"          # match state server (Cloud Run in burst project)
PROJECT="$BURST_PROJECT_ID"

echo "=== Building Vite bundle (local) ==="
cd "$FRONTEND_DIR"
npm run build

echo ""
echo "=== Deploying to Cloud Run ==="
echo "  Service: $SERVICE"
echo "  Project: $PROJECT"
echo "  Region:  $REGION"
echo ""

# --source . uploads the build context (respecting .gcloudignore) and runs
# Cloud Build against the Dockerfile, then deploys the resulting image.
# .gcloudignore is required because .gitignore excludes dist/ which the
# Dockerfile needs.
gcloud run deploy "$SERVICE" \
  --source . \
  --project="$PROJECT" \
  --region="$REGION" \
  --allow-unauthenticated \
  --port=8080 \
  --memory=256Mi \
  --cpu=1 \
  --max-instances=10

echo ""
echo "=== Done ==="
gcloud run services describe "$SERVICE" \
  --project="$PROJECT" --region="$REGION" \
  --format="value(status.url)"
