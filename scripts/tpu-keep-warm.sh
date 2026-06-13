#!/bin/bash
# tpu-keep-warm.sh — Cron entry on the east5a-0 host (every 20 min).
# Re-fires all 6 protein shapes on both warm servers (ESMFold + Boltz-2)
# so the eager-mode XLA op cache stays hot. Without this, the cache evicts
# after a few hours of idle and the first call after eviction costs ~60s
# instead of ~12s.
#
# Skipping rules:
#   - Skip if another keep-warm or prewarm is already running (no double-run)
#   - prewarm_all_proteins.sh self-gates on the AUTHORITATIVE run-state (GCS backend states)
#     and refuses to POST to any warm server while a real run is in flight — so keep-warm
#     never races / collides with a real job at the shared server.
#
# Install: */20 * * * * /opt/tpu-keep-warm.sh >> /tmp/tpu-keepwarm.log 2>&1
# Reads /opt/env.sh if present for SHARED_BUCKET override.

set -uo pipefail
[ -r /opt/env.sh ] && source /opt/env.sh
CONTAINER="${CONTAINER:-slurmd}"
SHARED_BUCKET="${SHARED_BUCKET:-gs://wz-nih-demo-shared}"

# Skip only if a real prewarm.pid exists AND that pid is alive in the container.
# (Using pgrep here self-matched the keep-warm's own bash -c argv and silently
# skipped every cron firing for hours — replaced with explicit pidfile check.)
PREWARM_PID=$(docker exec $CONTAINER cat /tmp/tpu-prewarm.pid 2>/dev/null | tr -d ' \n\r')
if [ -n "$PREWARM_PID" ] && docker exec $CONTAINER kill -0 "$PREWARM_PID" 2>/dev/null; then
  echo "$(date) keep-warm SKIP: prewarm.pid=$PREWARM_PID is alive in container"
  exit 0
fi

# Collision-avoidance is now enforced inside prewarm_all_proteins.sh via an AUTHORITATIVE
# run-state gate (it reads the GCS backend states — the same ones App.tsx polls and Cloud
# Run's server.py checks — and refuses to POST to any warm server while a real run is in
# flight). The old /tmp/tpu-busy flag was unreliable (often never set, so it never tripped),
# which let keep-warm race real jobs at the shared server. prewarm self-gates now, so we no
# longer rely on the busy file here.

# Require server alive — otherwise the health cron will restart it and fire prewarm itself.
if ! curl -sf -m 5 http://localhost:8090/ > /dev/null 2>&1; then
  echo "$(date) keep-warm SKIP: ESMFold server not responding (health cron will handle)"
  exit 0
fi

echo "$(date) keep-warm START"
docker exec $CONTAINER bash -c "gsutil -q cp $SHARED_BUCKET/scripts/prewarm_all_proteins.sh /tmp/prewarm_all_proteins.sh && chmod +x /tmp/prewarm_all_proteins.sh && bash /tmp/prewarm_all_proteins.sh" 2>&1 | tail -30
echo "$(date) keep-warm DONE"
