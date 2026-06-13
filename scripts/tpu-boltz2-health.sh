#!/bin/bash
# tpu-boltz2-health.sh — cron (*/5 + @reboot) on the Boltz-2 TPU VM host (east5a-3).
#
# If the warm server on :8091 is down, re-run the idempotent node setup, which restores the
# boltz2-server container, the weight cache (ephemeral /tmp/.boltz is wiped on container
# restart / host reboot), and relaunches the server. This covers the common recoverable
# failures: server crash, lost /tmp cache, container stopped.
#
# What it CANNOT fix: a host-maintenance reboot de-initializes the v6e chips at the hardware
# level, after which libtpu reports "Failed to get global TPU topology" / "No hardware is
# found". QR-backed TPUs can't stop/start, so the only fix is delete+recreate of the queued
# resource (recreate_boltz2_tpu.sh, run OFF the node). We detect that case and flag it loudly
# rather than thrashing — a 5-minute cron must never autonomously delete/recreate scarce TPUs.
#
# Install on the host:
#   sudo gsutil cp $SHARED_BUCKET/scripts/tpu-boltz2-health.sh /opt/tpu-boltz2-health.sh
#   sudo chmod +x /opt/tpu-boltz2-health.sh
#   ( sudo crontab -l 2>/dev/null | grep -v tpu-boltz2-health; \
#     echo '*/5 * * * * /opt/tpu-boltz2-health.sh >> /tmp/tpu-boltz2-health.log 2>&1'; \
#     echo '@reboot sleep 60 && /opt/tpu-boltz2-health.sh >> /tmp/tpu-boltz2-health.log 2>&1' ) | sudo crontab -

set -uo pipefail
[ -r /opt/env.sh ] && source /opt/env.sh
SHARED_BUCKET="${SHARED_BUCKET:-gs://wz-nih-demo-shared}"
PORT="${BOLTZ_PORT:-8091}"
CONTAINER="${BOLTZ_CONTAINER:-boltz2-server}"
ts(){ date "+%Y-%m-%d %H:%M:%S %Z"; }

# Single-instance guard: @reboot and */5 can fire seconds apart; two concurrent recoveries
# fighting over the exclusive TPU break things. flock it.
exec 9>/tmp/tpu-boltz2-health.lock
flock -n 9 || { echo "$(ts) another health run holds the lock — skipping"; exit 0; }

# ── 0. If the server already answers, do nothing. Never disturb a working server. ──
curl -sf -m 5 "http://localhost:$PORT/" >/dev/null 2>&1 && exit 0
echo "$(ts) boltz2 server not responding on :$PORT — running recovery"

# ── 1. Re-run the idempotent node setup (ensures vfio/vbar [skipped if already up from the
#       v2-alpha-tpuv6e runtime], container, weight cache, and a fresh server launch). ──
gsutil -q cp "$SHARED_BUCKET/scripts/boltz2_node_setup.sh" /opt/boltz2_node_setup.sh 2>/dev/null && chmod +x /opt/boltz2_node_setup.sh
bash /opt/boltz2_node_setup.sh 2>&1 | sed 's/^/  /'

# ── 2. Recovered? ──
if curl -sf -m 5 "http://localhost:$PORT/" >/dev/null 2>&1; then
  echo "$(ts) recovered — boltz2 server UP on :$PORT"
  exit 0
fi

# ── 3. Still down. Distinguish a dead chip (needs recreate) from other failures. ──
if docker exec "$CONTAINER" tail -40 /tmp/tpu-boltz2-server.log 2>/dev/null \
     | grep -qiE "Failed to get global TPU topology|No hardware is found"; then
  echo "$(ts) *** TPU DEAD (topology / no hardware) — the host likely rebooted and de-initialized"
  echo "$(ts) *** the v6e chips. This is NOT fixable on-node. Run OFF-node, from the repo:"
  echo "$(ts) ***     bash scripts/recreate_boltz2_tpu.sh"
  echo "$(ts) *** (delete+recreate the QR with v2-alpha-tpuv6e; QR TPUs cannot stop/start)."
else
  echo "$(ts) server still down (non-topology). Last server log lines:"
  docker exec "$CONTAINER" tail -15 /tmp/tpu-boltz2-server.log 2>/dev/null | sed 's/^/    /'
fi
exit 1
