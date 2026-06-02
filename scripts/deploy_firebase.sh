#!/bin/bash
# deploy_firebase.sh — Build the Vite bundle and push to Firebase Hosting.
#
# Site:  nih-protein-demo (in wz-nih-demo-burst project)
# URL:   https://nih-protein-demo.web.app
#
# Why Firebase Hosting in addition to Cloud Run:
#   - Global CDN edge cache → faster first paint than single-region Cloud Run
#   - Free tier covers the demo traffic
#   - Vanity URL via the site name (no custom-domain DNS work needed)
#   - SPA still talks to the same Cloud Run state server + GCS bucket — no
#     proxy pattern needed (we have no WebSockets, no SSE, no streaming;
#     all calls are plain HTTPS fetch which works cross-origin via CORS).
#
# Usage:
#   bash scripts/deploy_firebase.sh

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

FRONTEND_DIR="$REPO_ROOT/local-controller/frontend"

echo "=== Building Vite bundle ==="
cd "$FRONTEND_DIR"
npm run build

echo ""
echo "=== Deploying to Firebase Hosting (site: nih-protein-demo) ==="
firebase deploy --only hosting --project wz-nih-demo-burst

echo ""
echo "=== Live at: https://nih-protein-demo.web.app ==="
