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
# resource (recreate_tpu_node.sh, run OFF the node). We detect that case and flag it loudly
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

# ── 0a. Disk hygiene — MUST run before the "server is fine" early exit below. ─────
# 2026-08-25: this node hit 100% disk with /var/log/syslog at 32.9 GB and kern.log at
# 32.8 GB (67 GB of a 97 GB disk). At 100% the docker daemon itself goes to `failed`,
# which takes the warm server, the container and every Slurm job on this host with it.
# The equivalent fix already lives in tpu-server-health.sh, but that script is NOT what
# this node's cron runs — so it never executed here. Hence the duplicate.
# Placement matters: while the server still answers, the check below exits 0, so cleanup
# placed after it would never run and the disk would fill silently until everything dies
# at once. journalctl --vacuum does NOT touch rsyslog's syslog/kern.log.
DISK_PCT=$(df / --output=pcent 2>/dev/null | tail -1 | tr -d ' %')
if [[ -n "${DISK_PCT:-}" && "$DISK_PCT" -gt 75 ]]; then
  echo "$(ts) disk at ${DISK_PCT}%, cleaning /var/log"
  rm -f /var/log/*.gz /var/log/*.[1-9] /var/log/*.old 2>/dev/null
  for f in /var/log/syslog /var/log/kern.log /var/log/messages /var/log/daemon.log; do
    [ -f "$f" ] && [ "$(stat -c %s "$f" 2>/dev/null || echo 0)" -gt 1073741824 ] && truncate -s 0 "$f" 2>/dev/null
  done
  journalctl --vacuum-size=50M >/dev/null 2>&1
  echo "$(ts) disk now at $(df / --output=pcent | tail -1 | tr -d ' %')%"
fi

# ── 0b. A full disk kills host services outright. On 2026-08-25 it took down BOTH dockerd
#       and systemd-resolved. The second one is the nastier failure: /etc/resolv.conf is a
#       symlink to systemd-resolved's stub, so when resolved dies the node loses all DNS,
#       gsutil hangs, and this script can no longer fetch boltz2_node_setup.sh — recovery
#       cripples itself exactly when it is needed. Restore both before probing the server.
if ! systemctl is-active --quiet docker; then
  echo "$(ts) docker daemon is $(systemctl is-active docker) — restarting"
  systemctl restart docker 2>/dev/null; sleep 8
fi
if ! getent hosts storage.googleapis.com >/dev/null 2>&1; then
  echo "$(ts) DNS is broken (cannot resolve storage.googleapis.com) — repairing"
  systemctl restart systemd-resolved 2>/dev/null; sleep 3
  # The stub listener on 127.0.0.53 can stay dead even when the unit reports active, so
  # fall back to the GCP metadata resolver directly rather than trusting the symlink.
  if ! getent hosts storage.googleapis.com >/dev/null 2>&1; then
    rm -f /etc/resolv.conf
    printf "nameserver 169.254.169.254\nsearch google.internal\noptions timeout:2 attempts:2\n" > /etc/resolv.conf
    echo "$(ts) pointed /etc/resolv.conf at 169.254.169.254 directly"
  fi
fi
# Docker snapshots the host's /etc/resolv.conf into a container at creation time, so a
# container created while host DNS was broken keeps a nameserver-less resolv.conf forever —
# even after the host is repaired. Boltz needs api.colabfold.com for MSA, and without DNS
# the fold returns an empty CIF with no error, which the client reads as "server not
# available" and then falls back to local inference and dies on VFIO-busy. Repair in place.
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${CONTAINER}$"; then
  if ! docker exec "$CONTAINER" getent hosts api.colabfold.com >/dev/null 2>&1; then
    echo "$(ts) container DNS is broken — repairing $CONTAINER:/etc/resolv.conf"
    docker exec "$CONTAINER" bash -c 'printf "nameserver 169.254.169.254\nsearch google.internal\noptions timeout:2 attempts:2\n" > /etc/resolv.conf' 2>/dev/null
  fi
fi

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
  echo "$(ts) ***     bash scripts/recreate_tpu_node.sh boltz"
  echo "$(ts) *** (delete+recreate the QR with v2-alpha-tpuv6e; QR TPUs cannot stop/start)."
else
  echo "$(ts) server still down (non-topology). Last server log lines:"
  docker exec "$CONTAINER" tail -15 /tmp/tpu-boltz2-server.log 2>/dev/null | sed 's/^/    /'
fi
exit 1
