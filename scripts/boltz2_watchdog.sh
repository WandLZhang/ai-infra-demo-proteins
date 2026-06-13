#!/bin/bash
# boltz2_watchdog.sh — OFF-node auto-heal for the Boltz-2 TPU warm server.
#
# Run this on the CONTROLLER VM (it must survive the TPU node's own reboots), on a cron such
# as */10. It probes the Boltz-2 server; if it has been DOWN for FAIL_THRESHOLD consecutive
# checks — long enough that the node-side */5 health cron (which re-runs boltz2_node_setup.sh)
# has already failed to recover it, i.e. the chip is dead after a host reboot — it triggers a
# full QR recreate via recreate_boltz2_tpu.sh.
#
# SAFETY: deleting+recreating a scarce v6e is drastic and capacity-dependent, so this is
# heavily guarded — it needs FAIL_THRESHOLD consecutive failures AND obeys RECREATE_COOLDOWN
# (at most one recreate per window). It is intentionally NOT enabled by default. Enable with:
#   ( crontab -l 2>/dev/null; echo '*/10 * * * * BOLTZ_HOST= bash /opt/protein-demo/boltz2_watchdog.sh >> /tmp/boltz2_watchdog.log 2>&1' ) | crontab -
# Requirements on the controller: gcloud auth (compute admin in the burst project), this repo
# (env.sh + recreate_boltz2_tpu.sh + boltz2_node_setup.sh), and the SSH key recreate uses.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/env.sh" 2>/dev/null || true
PORT="${BOLTZ_PORT:-8091}"
SHARED_BUCKET="${SHARED_BUCKET:-gs://wz-nih-demo-shared}"
STATE=/tmp/boltz2_watchdog.fails
COOLDOWN_FILE=/tmp/boltz2_watchdog.last_recreate
FAIL_THRESHOLD="${FAIL_THRESHOLD:-3}"            # consecutive down-checks before recreate
RECREATE_COOLDOWN="${RECREATE_COOLDOWN:-3600}"   # min seconds between recreates
ts(){ date "+%Y-%m-%d %H:%M:%S %Z"; }

# Resolve the live server IP (recreate publishes it here; env.sh fallback otherwise).
HOST="$(gsutil -q cat "$SHARED_BUCKET/config/boltz_host" 2>/dev/null || echo "${BOLTZ_HOST:-}")"
[ -z "$HOST" ] && { echo "$(ts) no BOLTZ_HOST known — skipping"; exit 0; }

if curl -sf -m 8 "http://$HOST:$PORT/" >/dev/null 2>&1; then
  echo 0 > "$STATE"; exit 0
fi

n=$(( $(cat "$STATE" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$STATE"
echo "$(ts) boltz2 DOWN at $HOST:$PORT (consecutive=$n / threshold=$FAIL_THRESHOLD)"
[ "$n" -lt "$FAIL_THRESHOLD" ] && exit 0

now=$(date +%s); last=$(cat "$COOLDOWN_FILE" 2>/dev/null || echo 0)
if [ $(( now - last )) -lt "$RECREATE_COOLDOWN" ]; then
  echo "$(ts) within recreate cooldown ($(( now - last ))s < ${RECREATE_COOLDOWN}s) — holding off"; exit 0
fi

echo "$(ts) sustained outage — triggering QR recreate (recreate_boltz2_tpu.sh)"
echo "$now" > "$COOLDOWN_FILE"; echo 0 > "$STATE"
bash "$SCRIPT_DIR/recreate_boltz2_tpu.sh"
