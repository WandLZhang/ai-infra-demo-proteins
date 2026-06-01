#!/bin/bash
# tpu-keep-warm.sh — Cron entry on the east5a-0 host (every 20 min).
# Re-fires all 6 protein shapes on both warm servers (ESMFold + Boltz-2)
# so the eager-mode XLA op cache stays hot. Without this, the cache evicts
# after a few hours of idle and the first call after eviction costs ~60s
# instead of ~12s.
#
# Skipping rules:
#   - Skip if another keep-warm or prewarm is already running (no double-run)
#   - Skip if /tmp/tpu-busy exists and is fresh (< 10 min) — means a real
#     Slurm job is currently using the TPU; don't compete
#
# Install: */20 * * * * /opt/tpu-keep-warm.sh >> /tmp/tpu-keepwarm.log 2>&1

set -uo pipefail
CONTAINER=slurmd
BUSY_FILE_MAX_AGE=600   # seconds — if /tmp/tpu-busy is newer than this, skip

# Skip only if a real prewarm.pid exists AND that pid is alive in the container.
# (Using pgrep here self-matched the keep-warm's own bash -c argv and silently
# skipped every cron firing for hours — replaced with explicit pidfile check.)
PREWARM_PID=$(docker exec $CONTAINER cat /tmp/tpu-prewarm.pid 2>/dev/null | tr -d ' \n\r')
if [ -n "$PREWARM_PID" ] && docker exec $CONTAINER kill -0 "$PREWARM_PID" 2>/dev/null; then
  echo "$(date) keep-warm SKIP: prewarm.pid=$PREWARM_PID is alive in container"
  exit 0
fi

# Skip if a real Slurm job is using the TPU right now.
BUSY_AGE=$(docker exec $CONTAINER bash -c 'if [ -f /tmp/tpu-busy ]; then echo $(( $(date +%s) - $(stat -c %Y /tmp/tpu-busy) )); else echo 99999; fi' 2>/dev/null || echo 99999)
if [ "$BUSY_AGE" -lt "$BUSY_FILE_MAX_AGE" ]; then
  echo "$(date) keep-warm SKIP: TPU busy (busy file age=${BUSY_AGE}s)"
  exit 0
fi

# Require server alive — otherwise the health cron will restart it and fire prewarm itself.
if ! curl -sf -m 5 http://localhost:8090/ > /dev/null 2>&1; then
  echo "$(date) keep-warm SKIP: ESMFold server not responding (health cron will handle)"
  exit 0
fi

echo "$(date) keep-warm START"
docker exec $CONTAINER bash -c 'gsutil -q cp gs://wz-nih-demo-shared/scripts/prewarm_all_proteins.sh /tmp/prewarm_all_proteins.sh && chmod +x /tmp/prewarm_all_proteins.sh && bash /tmp/prewarm_all_proteins.sh' 2>&1 | tail -30
echo "$(date) keep-warm DONE"
