#!/bin/bash
# tpu-server-health.sh — Cron on the ESMFold TPU VM host (every 5 min).
#
# Behavior:
#   1. If disk > 75%, clean ephemeral state inside slurmd.
#   2. If the ESMFold server PID is alive, do NOTHING. Never kill a working server.
#   3. If the server process is dead, restart it as slurmuser and fire a warmup
#      POST in the background so the next real Slurm job hits a warm XLA cache.
#   4. Push the current server status to $SHARED_BUCKET/tpu-status.json
#      so the frontend badge reflects reality.
#
# Install: */5 * * * * /opt/tpu-server-health.sh >> /tmp/tpu-health.log 2>&1
# Reads /opt/env.sh if present for SHARED_BUCKET + SLURMUSER_UID overrides.

set -uo pipefail
[ -r /opt/env.sh ] && source /opt/env.sh
CONTAINER="${CONTAINER:-slurmd}"
SHARED_BUCKET="${SHARED_BUCKET:-gs://wz-nih-demo-shared}"
STATUS_BLOB="$SHARED_BUCKET/tpu-status.json"
SLURMUSER_UID="${SLURMUSER_UID:-1015145168}"

# ── 1. Disk + memory hygiene ──────────────────────────────────────
DISK_PCT=$(df / --output=pcent 2>/dev/null | tail -1 | tr -d ' %')
if [[ -n "${DISK_PCT:-}" && "$DISK_PCT" -gt 75 ]]; then
  echo "$(date) disk at ${DISK_PCT}%, cleaning..."
  docker exec $CONTAINER bash -c 'rm -rf /tmp/b2w_out* /tmp/boltz_warm* /tmp/boltz2_server_out* /tmp/result-* /tmp/esmfold_warm* /tmp/precheck.pdb /root/.cache/pip 2>/dev/null; find /tmp -maxdepth 2 -name "*.fasta" -mtime +1 -delete 2>/dev/null; find /tmp -maxdepth 2 -name "*.log" -mtime +1 -delete 2>/dev/null' 2>/dev/null
  journalctl --vacuum-size=20M 2>/dev/null
  # /var/log is the real filler on TPU VMs: rsyslog + the TPU health agent can push
  # syslog/kern.log into the tens of GB (2026-08-02: syslog.1 + kern.log.1 were 34 GB
  # EACH and wedged the node at 100% — docker exec then fails with "no space left on
  # device", which kills the warm server AND every Slurm job that lands here).
  # journalctl --vacuum does NOT touch these; drop rotated copies + cap the live ones.
  rm -f /var/log/*.gz /var/log/*.[1-9] /var/log/*.old 2>/dev/null
  for f in /var/log/syslog /var/log/kern.log /var/log/messages /var/log/daemon.log; do
    [ -f "$f" ] && [ "$(stat -c %s "$f" 2>/dev/null || echo 0)" -gt 1073741824 ] && truncate -s 0 "$f" 2>/dev/null
  done
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
# Post-reboot /root resets to 700 — slurmuser then can't traverse it to read the
# HF weight cache and the server relaunch below fails. Reopen traversal + read.
docker exec $CONTAINER bash -c 'chmod o+x /root /root/.cache 2>/dev/null; chmod -R a+rX /root/.cache/huggingface 2>/dev/null' 2>/dev/null

# ── 3b. Rebuild af2-tpu's isolated jax-venv if a /tmp wipe (reboot) removed it.
# Non-blocking (background) + lock-guarded so */5 ticks don't stack rebuilds.
if ! docker exec $CONTAINER test -x /tmp/jax-venv/bin/python3 2>/dev/null && [ ! -f /tmp/jax-venv-rebuild.lock ]; then
  echo "$(date) jax-venv missing (reboot wiped /tmp) — rebuilding in background"
  touch /tmp/jax-venv-rebuild.lock
  ( docker exec $CONTAINER bash -c 'python3 -m venv --system-site-packages /tmp/jax-venv && /tmp/jax-venv/bin/pip install --no-cache-dir "jax[tpu]==0.4.38" -f https://storage.googleapis.com/jax-releases/libtpu_releases.html && chmod -R a+rX /tmp/jax-venv' > /tmp/jax-venv-rebuild.log 2>&1; rm -f /tmp/jax-venv-rebuild.lock ) &
fi

# ── 4. ESMFold server alive AND prewarm sentinel fresh? ──────────
# Frontend badge contract — "ready" means brca1's shape is currently HOT
# on BOTH warm servers (TPU will win the next press), nothing weaker:
#   server responds + sentinel <  9 min → "ready"
#   server responds + sentinel ≥  9 min → "loading"  (XLA cache may have evicted,
#                                                      next keep-warm cron should refresh it)
#   server process exists, no HTTP      → "loading"  (mid-compile / mid-startup)
#   no server process                   → "offline" → fall through to restart block
#
# 9-min threshold: keep-warm cron fires every 5 min and the brca1-only
# prewarm takes ~80s warm path (~13s ESMFold + ~13s Boltz-2 + RPC overhead).
# So the sentinel mtime is normally <6 min old. Two missed cycles → loading.
SENTINEL_AGE=$(docker exec $CONTAINER bash -c 'if [ -f /tmp/tpu-prewarm-done ]; then echo $(( $(date +%s) - $(stat -c %Y /tmp/tpu-prewarm-done) )); else echo 99999; fi' 2>/dev/null || echo 99999)

if curl -sf -m 5 http://localhost:8090/ > /dev/null 2>&1; then
  if [ "$SENTINEL_AGE" -lt 540 ]; then
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

docker exec -d -u "$SLURMUSER_UID" $CONTAINER bash -c 'cd /opt/backends && HOME=/tmp PJRT_DEVICE=TPU HF_HOME=/root/.cache/huggingface HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 BOLTZ_CACHE=/tmp/.boltz NUMBA_CACHE_DIR=/tmp/numba_cache python3 -u tpu-esmfold-server.py > /tmp/tpu-model-server.log 2>&1 & echo $! > /tmp/tpu-model-server.pid'

# ── 6. Wait for HTTP listener (~60s for weight load) ─────────────
echo "$(date) waiting for ESMFold to start listening..."
for i in $(seq 1 120); do
  if curl -sf -m 3 http://localhost:8090/ > /dev/null 2>&1; then
    echo "$(date) ESMFold listening, firing all-6-protein prewarm in background"
    # Pre-warm all 6 demo protein shapes on BOTH ESMFold (local) and
    # Boltz-2 (east5a-3) so the badge only flips to "ready" once any
    # protein the user picks will hit warm cache.
    docker exec $CONTAINER bash -c "gsutil -q cp $SHARED_BUCKET/scripts/prewarm_all_proteins.sh /tmp/prewarm_all_proteins.sh && chmod +x /tmp/prewarm_all_proteins.sh" 2>/dev/null
    docker exec -d $CONTAINER bash -c 'bash /tmp/prewarm_all_proteins.sh > /tmp/tpu-prewarm.log 2>&1'
    echo '{"status":"loading"}' | gsutil -q cp - "$STATUS_BLOB" 2>/dev/null
    exit 0
  fi
  sleep 1
done
echo "$(date) ESMFold failed to start within 120s"
echo '{"status":"offline"}' | gsutil -q cp - "$STATUS_BLOB" 2>/dev/null
