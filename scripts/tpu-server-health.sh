#!/bin/bash
# tpu-server-health.sh — Cron on the east5a-0 TPU VM host (every 5 min).
#
# Behavior:
#   1. If disk > 75%, clean ephemeral state inside slurmd.
#   2. If the ESMFold server PID is alive, do NOTHING. Never kill a working server.
#   3. If the server process is dead, restart it as slurmuser and fire a warmup
#      POST in the background so the next real Slurm job hits a warm XLA cache.
#   4. Push the current server status to gs://wz-nih-demo-shared/tpu-status.json
#      so the frontend badge reflects reality.
#
# Install: */5 * * * * /opt/tpu-server-health.sh >> /tmp/tpu-health.log 2>&1

set -uo pipefail
CONTAINER=slurmd
STATUS_BLOB="gs://wz-nih-demo-shared/tpu-status.json"
SLURMUSER_UID=1015145168

# ── 1. Disk + memory hygiene ──────────────────────────────────────
DISK_PCT=$(df / --output=pcent 2>/dev/null | tail -1 | tr -d ' %')
if [[ -n "${DISK_PCT:-}" && "$DISK_PCT" -gt 75 ]]; then
  echo "$(date) disk at ${DISK_PCT}%, cleaning..."
  docker exec $CONTAINER bash -c 'rm -rf /tmp/b2w_out* /tmp/boltz_warm* /tmp/boltz2_server_out* /tmp/result-* /tmp/esmfold_warm* /tmp/precheck.pdb /root/.cache/pip 2>/dev/null; find /tmp -maxdepth 2 -name "*.fasta" -mtime +1 -delete 2>/dev/null; find /tmp -maxdepth 2 -name "*.log" -mtime +1 -delete 2>/dev/null' 2>/dev/null
  journalctl --vacuum-size=20M 2>/dev/null
  echo "$(date) disk now at $(df / --output=pcent | tail -1 | tr -d ' %')%"
fi

DOCKER_PCT=$(df /var/lib/docker --output=pcent 2>/dev/null | tail -1 | tr -d ' %')
if [[ -n "${DOCKER_PCT:-}" && "$DOCKER_PCT" -gt 80 ]]; then
  echo "$(date) docker disk at ${DOCKER_PCT}%, pruning..."
  docker system prune -f 2>/dev/null
fi

# ── 2. Container must be up ──────────────────────────────────────
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  echo "$(date) container $CONTAINER not running, nothing to do"
  echo '{"status":"offline"}' | gsutil -q cp - "$STATUS_BLOB" 2>/dev/null
  exit 0
fi

# ── 3. Fix slurmuser scratch perms (cheap, always safe) ──────────
docker exec $CONTAINER bash -c 'chmod -R 777 /tmp/.gsutil /tmp/.config /tmp/protein-demo /tmp/numba_cache 2>/dev/null; chmod 666 /tmp/*.log /tmp/*.fasta /tmp/*.pdb /tmp/tpu-model-server.pid 2>/dev/null; mkdir -p /tmp/numba_cache && chmod 777 /tmp/numba_cache' 2>/dev/null

# ── 4. ESMFold server alive? HTTP first (source of truth), pgrep fallback ─
# Pid file can be stale/empty (docker exec -d's $! often doesn't propagate
# through the detached bash subshell). Trust HTTP if it answers — never
# restart a server that's actually serving.
#
# Frontend badge logic — only "ready" means TPU is warm RIGHT NOW:
#   server dead                                  → "offline"
#   server alive, no sentinel OR sentinel stale  → "loading"
#   server alive, sentinel younger than 25 min   → "ready"
#
# Eager-mode XLA cache evicts after hours of idle. The keep-warm cron
# refreshes the sentinel every 20 min by re-firing all 12 shapes. If two
# consecutive keep-warm runs miss (e.g. demo in flight blocks them), the
# sentinel ages past 25 min and the badge correctly downgrades to loading.
SENTINEL_AGE=$(docker exec $CONTAINER bash -c 'if [ -f /tmp/tpu-prewarm-done ]; then echo $(( $(date +%s) - $(stat -c %Y /tmp/tpu-prewarm-done) )); else echo 99999; fi' 2>/dev/null || echo 99999)

if curl -sf -m 5 http://localhost:8090/ > /dev/null 2>&1; then
  if [ "$SENTINEL_AGE" -lt 600 ]; then  # 10 min — matches eager XLA cache eviction window
    echo '{"status":"ready"}' | gsutil -q cp - "$STATUS_BLOB" 2>/dev/null
  else
    echo '{"status":"loading"}' | gsutil -q cp - "$STATUS_BLOB" 2>/dev/null
  fi
  exit 0
fi

# HTTP didn't answer — process might still be alive but mid-compile, or dead.
# Use pgrep to see if the python process exists; if yes, server is loading.
if docker exec $CONTAINER bash -c "pgrep -f tpu-esmfold-server > /dev/null"; then
  echo '{"status":"loading"}' | gsutil -q cp - "$STATUS_BLOB" 2>/dev/null
  exit 0
fi

# ── 5. Server dead — restart cleanly ─────────────────────────────
echo "$(date) ESMFold server dead, restarting as slurmuser..."
echo '{"status":"loading"}' | gsutil -q cp - "$STATUS_BLOB" 2>/dev/null

# Clear stale VFIO lock + pid file + prewarm sentinel
docker exec $CONTAINER bash -c 'rm -f /tmp/libtpu_lockfile /tmp/tpu-model-server.pid /tmp/tpu-prewarm-done' 2>/dev/null
sleep 2

docker exec -d -u "$SLURMUSER_UID" $CONTAINER bash -c 'cd /opt/backends && HOME=/tmp PJRT_DEVICE=TPU HF_HOME=/root/.cache/huggingface BOLTZ_CACHE=/tmp/.boltz NUMBA_CACHE_DIR=/tmp/numba_cache python3 -u tpu-esmfold-server.py > /tmp/tpu-model-server.log 2>&1 & echo $! > /tmp/tpu-model-server.pid'

# ── 6. Wait for HTTP listener (~60s for weight load) ─────────────
echo "$(date) waiting for ESMFold to start listening..."
for i in $(seq 1 120); do
  if curl -sf -m 3 http://localhost:8090/ > /dev/null 2>&1; then
    echo "$(date) ESMFold listening, firing all-6-protein prewarm in background"
    # Pre-warm all 6 demo protein shapes on BOTH ESMFold (local) and
    # Boltz-2 (east5a-3) so the badge only flips to "ready" once any
    # protein the user picks will hit warm cache.
    docker exec $CONTAINER bash -c 'gsutil -q cp gs://wz-nih-demo-shared/scripts/prewarm_all_proteins.sh /tmp/prewarm_all_proteins.sh && chmod +x /tmp/prewarm_all_proteins.sh' 2>/dev/null
    docker exec -d $CONTAINER bash -c 'bash /tmp/prewarm_all_proteins.sh > /tmp/tpu-prewarm.log 2>&1'
    echo '{"status":"loading"}' | gsutil -q cp - "$STATUS_BLOB" 2>/dev/null
    exit 0
  fi
  sleep 1
done
echo "$(date) ESMFold failed to start within 120s"
echo '{"status":"offline"}' | gsutil -q cp - "$STATUS_BLOB" 2>/dev/null
