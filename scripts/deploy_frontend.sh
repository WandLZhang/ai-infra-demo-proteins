#!/bin/bash
# deploy_frontend.sh — Build and deploy the React HUD to Cloud Run.
#
# Builds the Vite app locally (so VITE_* values from local-controller/frontend/.env
# are baked into the bundle without uploading the .env file to Cloud Build),
# then containerizes the dist/ folder behind nginx and deploys to Cloud Run
# in the same project/region as the state server.
#
# Cloud Run service URL is printed at the end; copy it where needed.
#
# Prerequisites:
#   - gcloud CLI authenticated with deploy access to $BURST_PROJECT_ID
#   - npm + Node.js installed locally
#   - local-controller/frontend/.env populated (VITE_GOOGLE_MAPS_API_KEY,
#     VITE_STATE_SERVER) — see local-controller/frontend/.env.example
#   - Service name + region default to protein-demo-frontend + AR_REGION;
#     override via SERVICE / REGION env vars if you want different names.
#
# Usage:
#   bash scripts/deploy_frontend.sh

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/env.sh"

FRONTEND_DIR="$REPO_ROOT/local-controller/frontend"
SERVICE="${SERVICE:-protein-demo-frontend}"
REGION="${REGION:-$AR_REGION}"        # match state server region by default
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
