#!/bin/bash
# deploy_firebase.sh — Build the Vite bundle and push to Firebase Hosting.
#
# Why Firebase Hosting in addition to Cloud Run:
#   - Global CDN edge cache → faster first paint than single-region Cloud Run
#   - Free tier covers the demo traffic
#   - Vanity URL via the site name (no custom-domain DNS work needed)
#   - SPA still talks to the same Cloud Run state server + GCS bucket — no
#     proxy pattern needed (no WebSockets, no SSE, no streaming;
#     all calls are plain HTTPS fetch which works cross-origin via CORS).
#
# Reads $BURST_PROJECT_ID from env.sh (defaults to wz-nih-demo-burst).
# Firebase site name is read from local-controller/frontend/.firebaserc /
# firebase.json — change those files to point at your own site, then run.
#
# Usage:
#   bash scripts/deploy_firebase.sh

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$SCRIPT_DIR/env.sh"

FRONTEND_DIR="$REPO_ROOT/local-controller/frontend"

echo "=== Building Vite bundle ==="
cd "$FRONTEND_DIR"
npm run build

echo ""
echo "=== Deploying to Firebase Hosting (project: $BURST_PROJECT_ID) ==="
firebase deploy --only hosting --project "$BURST_PROJECT_ID"

echo ""
echo "=== Deploy complete. URL is in firebase.json site config. ==="
