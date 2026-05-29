#!/bin/bash
# tpu-server-health.sh — Cron on TPU VM host (every 5 min).
# Restarts combined model server if dead, auto-warms both models.
# Install: */5 * * * * /opt/tpu-server-health.sh >> /tmp/tpu-health.log 2>&1

CONTAINER=slurmd

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
    echo "$(date) server ready, warming ESMFold..."
    # Warm ESMFold
    docker exec -d $CONTAINER bash -c 'curl -s -m 300 -X POST localhost:8090/predict -H "Content-Type: application/json" -d "{\"sequence\":\"MVLSPADKTNVKAAWGKVGAHAGEYGAEALERMFLSFPTTKTYFPHFDLSHGSAQVKGHGKKVADALTNAVAHVDDMPNALSALSDLHAHKLRVDPVNFKLLSHCLLVTLAAHLPAEFTPAVHASLDKFLASVSTVLTSKYR\",\"out_path\":\"/tmp/esm_warmup.pdb\"}" > /dev/null 2>&1 && echo "ESMFold warmed" >> /tmp/tpu-health.log; echo ">A|protein" > /tmp/b2w.fasta; echo MVLSPADKTNVKAAWGKVGAHAGEYGAEALERMFLSFPTTKTYFPHFDLSHGSAQVKGHGKKVADALTNAVAHVDDMPNALSALSDLHAHKLRVDPVNFKLLSHCLLVTLAAHLPAEFTPAVHASLDKFLASVSTVLTSKYR >> /tmp/b2w.fasta; curl -s -m 600 -X POST localhost:8091/predict -H "Content-Type: application/json" -d "{\"fasta_path\":\"/tmp/b2w.fasta\",\"out_dir\":\"/tmp/b2w_warmup\",\"sampling_steps\":10}" > /dev/null 2>&1 && echo "Boltz-2 warmed" >> /tmp/tpu-health.log'
    echo "$(date) warmup started in background"
    exit 0
  fi
  sleep 1
done
echo "$(date) server failed to start within 90s"
