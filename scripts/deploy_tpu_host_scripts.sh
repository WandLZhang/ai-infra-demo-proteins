#!/bin/bash
# deploy_tpu_host_scripts.sh — Push the TPU VM host-side scripts to /opt/
# on each TPU VM, plus upload the container-side prewarm script to GCS.
#
# Scripts and where they live:
#   /opt/tpu-server-health.sh        — cron */5 min on east5a-0 (host) — ESMFold + badge
#   /opt/tpu-keep-warm.sh            — cron */20 min on east5a-0 (host)
#   /opt/tpu-boltz2-health.sh        — cron */5 min + @reboot on east5a-3 (host) — Boltz-2
#   gs://.../scripts/prewarm_all_proteins.sh — fetched from GCS by the cron
#                                       jobs into the slurmd container at /tmp/
#
# Why GCS for prewarm: the prewarm script runs INSIDE the slurmd container
# (it needs network access to ESMFold + Boltz-2 servers and lives alongside
# Python). The cron jobs on the host fetch it via gsutil cp at runtime.
#
# After deploy, manually triggers tpu-server-health.sh once on east5a-0 so
# the frontend badge reflects current state immediately rather than waiting
# for the next cron tick.
#
# Prerequisites:
#   - gcloud authenticated with TPU + storage access in BURST_PROJECT_ID
#
# Usage:
#   bash scripts/deploy_tpu_host_scripts.sh

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/env.sh"

# east5a-0 = ESMFold VM (drives the badge); east5a-3 = dedicated Boltz-2 VM.
TPU_VM="${TPU_VM:-nihprotein-tpuv6eeast5a-0}"
TPU_ZONE="${TPU_ZONE:-us-east5-a}"
BOLTZ_TPU_VM="${BOLTZ_TPU_VM:-nihprotein-tpuv6eeast5a-3}"
BOLTZ_TPU_ZONE="${BOLTZ_TPU_ZONE:-us-east5-a}"

echo "=== Uploading prewarm + boltz2 deploy/health scripts + env to GCS ==="
for f in prewarm_all_proteins.sh tpu-boltz2-health.sh boltz2_node_setup.sh recreate_boltz2_tpu.sh env.sh; do
  gsutil -q cp "$SCRIPT_DIR/$f" "$SHARED_BUCKET/scripts/$f" && echo "  ok: $SHARED_BUCKET/scripts/$f"
done

echo ""
echo "=== Pushing host scripts to $TPU_VM:/opt/ ==="
gcloud compute tpus tpu-vm scp \
  "$SCRIPT_DIR/tpu-server-health.sh" \
  "$SCRIPT_DIR/tpu-keep-warm.sh" \
  "$TPU_VM:/tmp/" \
  --zone="$TPU_ZONE" --project="$BURST_PROJECT_ID" 2>&1 | grep -v "To increase"

gcloud compute tpus tpu-vm ssh "$TPU_VM" --zone="$TPU_ZONE" --project="$BURST_PROJECT_ID" --command='
  sudo mv /tmp/tpu-server-health.sh /opt/tpu-server-health.sh
  sudo mv /tmp/tpu-keep-warm.sh     /opt/tpu-keep-warm.sh
  sudo chmod +x /opt/tpu-server-health.sh /opt/tpu-keep-warm.sh
  echo "  installed: /opt/tpu-server-health.sh ($(stat -c %s /opt/tpu-server-health.sh) bytes)"
  echo "  installed: /opt/tpu-keep-warm.sh    ($(stat -c %s /opt/tpu-keep-warm.sh) bytes)"
' 2>&1 | grep -v "To increase"

echo ""
echo "=== Triggering tpu-server-health.sh once so badge updates immediately ==="
gcloud compute tpus tpu-vm ssh "$TPU_VM" --zone="$TPU_ZONE" --project="$BURST_PROJECT_ID" --command='
  sudo /opt/tpu-server-health.sh
  echo ""
  echo "Current tpu-status.json:"
  gsutil cat '"$SHARED_BUCKET"'/tpu-status.json
' 2>&1 | grep -v "To increase"

echo ""
echo "=== Staging Boltz-2 host scripts on $BOLTZ_TPU_VM:/opt/ + installing cron ==="
echo "    (the node must be provisioned with runtime-version=v2-alpha-tpuv6e — see"
echo "     recreate_boltz2_tpu.sh; tpu-ubuntu2204-base no longer ships the TPU access daemon.)"
gcloud compute tpus tpu-vm ssh "$BOLTZ_TPU_VM" --zone="$BOLTZ_TPU_ZONE" --project="$BURST_PROJECT_ID" --command='
  sudo gsutil -q cp '"$SHARED_BUCKET"'/scripts/env.sh /opt/env.sh
  sudo gsutil -q cp '"$SHARED_BUCKET"'/scripts/tpu-boltz2-health.sh /opt/tpu-boltz2-health.sh
  sudo gsutil -q cp '"$SHARED_BUCKET"'/scripts/boltz2_node_setup.sh /opt/boltz2_node_setup.sh
  sudo chmod +x /opt/tpu-boltz2-health.sh /opt/boltz2_node_setup.sh
  # install */5 + @reboot cron (idempotent)
  ( sudo crontab -l 2>/dev/null | grep -v tpu-boltz2-health; \
    echo "*/5 * * * * /opt/tpu-boltz2-health.sh >> /tmp/tpu-boltz2-health.log 2>&1"; \
    echo "@reboot sleep 60 && /opt/tpu-boltz2-health.sh >> /tmp/tpu-boltz2-health.log 2>&1" ) | sudo crontab -
  echo "  installed: /opt/{env.sh,tpu-boltz2-health.sh,boltz2_node_setup.sh}"
  echo "  cron now:"; sudo crontab -l | grep tpu-boltz2-health | sed "s/^/    /"
  echo "  triggering once:"; sudo /opt/tpu-boltz2-health.sh 2>&1 | tail -3
' 2>&1 | grep -v "To increase"

echo ""
echo "=== Capping rsyslog on both TPU VMs (idempotent) ==="
# Both TPU hosts have filled their 97 GB disk with /var/log: east5a-0 on 2026-08-02 and
# east5a-3 on 2026-08-25, each with syslog + kern.log around 33 GB apiece. At 100% the
# docker daemon goes to `failed`, which takes the warm server, the container, and every
# Slurm job on that host with it. The health crons now truncate /var/log above 75% disk;
# this caps the files so it should not get that far. Applied here so a freshly provisioned
# node inherits it, rather than being hand-patched after the fact.
for VM_ZONE in "$TPU_VM:$TPU_ZONE" "$BOLTZ_TPU_VM:$BOLTZ_TPU_ZONE"; do
  VM="${VM_ZONE%%:*}"; VMZ="${VM_ZONE##*:}"
  gcloud compute tpus tpu-vm ssh "$VM" --zone="$VMZ" --project="$BURST_PROJECT_ID" --command='
    if [ -f /etc/logrotate.d/rsyslog ] && ! grep -q maxsize /etc/logrotate.d/rsyslog; then
      sudo sed -i "s/^\(\s*\)\(weekly\|daily\)/\1\2\n\1maxsize 200M/" /etc/logrotate.d/rsyslog
      echo "  '"$VM"': maxsize 200M added"
    else
      echo "  '"$VM"': already capped"
    fi
    # logrotate only enforces maxsize when it runs, and the default timer is daily — which
    # a runaway can outpace. Hourly keeps the ceiling meaningful.
    sudo mkdir -p /etc/systemd/system/logrotate.timer.d
    printf "[Timer]\nOnCalendar=\nOnCalendar=hourly\n" | sudo tee /etc/systemd/system/logrotate.timer.d/hourly.conf >/dev/null
    sudo systemctl daemon-reload 2>/dev/null && sudo systemctl restart logrotate.timer 2>/dev/null
    echo "  '"$VM"': logrotate timer -> $(systemctl show logrotate.timer -p TimersCalendar --value 2>/dev/null | head -c 40)"
  ' 2>&1 | grep -v "To increase"
done

echo ""
echo "=== Done ==="
echo "east5a-0 cron: */5 health, */8 keep-warm."
echo "east5a-3 cron: */5 boltz2-health + @reboot. Recoverable failures (server crash, lost"
echo "  /tmp weight cache) -> re-runs boltz2_node_setup.sh. Dead chip after host reboot"
echo "  (topology error) -> flags 'run recreate_boltz2_tpu.sh' (QR recreate; can't be fixed on-node)."
