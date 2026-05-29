#!/bin/bash
# tpu-server-health.sh — Cron on TPU VM host (every 5 min).
# Restarts combined model server if dead, auto-warms both models.
# Install: */5 * * * * /opt/tpu-server-health.sh >> /tmp/tpu-health.log 2>&1

CONTAINER=slurmd

# Disk cleanup — prevent filling up
DISK_PCT=$(df / --output=pcent | tail -1 | tr -d ' %')
if [[ "$DISK_PCT" -gt 85 ]]; then
  echo "$(date) disk at ${DISK_PCT}%, cleaning..."
  docker exec $CONTAINER bash -c 'rm -rf /tmp/b2w_out* /tmp/boltz_warmup* /tmp/result-* /tmp/*.fasta /tmp/*.pdb /root/.cache/pip /tmp/pip-* 2>/dev/null; find /usr/local/lib/python3.10/dist-packages -name __pycache__ -type d -exec rm -rf {} + 2>/dev/null' 2>/dev/null
  journalctl --vacuum-size=10M 2>/dev/null
  echo "$(date) disk now at $(df / --output=pcent | tail -1 | tr -d ' %')%"
fi

# Is container running?
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  echo "$(date) container not running"
  exit 0
fi

# Is ESMFold server alive?
if curl -sf http://localhost:8090/ > /dev/null 2>&1; then
  exit 0
fi

echo "$(date) TPU model server down, restarting..."

# Kill any stale python/libtpu processes
docker exec $CONTAINER bash -c 'kill -9 $(pgrep python3) 2>/dev/null; rm -f /tmp/libtpu_lockfile' 2>/dev/null
sleep 3

# Start combined server
docker exec -d $CONTAINER bash -c 'cd /opt/backends && PJRT_DEVICE=TPU HF_HOME=/root/.cache/huggingface BOLTZ_CACHE=/tmp/.boltz python3 tpu-model-server.py > /tmp/tpu-model-server.log 2>&1'

# Wait for server to load (~60s)
echo "$(date) waiting for server to load..."
for i in $(seq 1 90); do
  if curl -sf http://localhost:8090/ > /dev/null 2>&1; then
    echo "$(date) server ready, warming all 6 proteins..."
    docker exec -d $CONTAINER bash -c 'gsutil -q cp gs://wz-nih-demo-shared/scripts/tpu-warmup-all.sh /opt/scripts/tpu-warmup-all.sh 2>/dev/null; chmod +x /opt/scripts/tpu-warmup-all.sh 2>/dev/null; bash /opt/scripts/tpu-warmup-all.sh >> /tmp/tpu-warmup.log 2>&1'
    echo "$(date) warmup started in background (~28 min for all 6 proteins)"
    exit 0
  fi
  sleep 1
done
echo "$(date) server failed to start within 90s"
