#!/usr/bin/env bash
# Install runner-ensure on a Boat box (run as root from the uploaded dir).
#   install.sh            stamp the current runner state as belonging to this box
#   install.sh --no-stamp leave the stamp alone (e.g. a box that is not enrolled)
set -euo pipefail
cd "$(dirname "$0")"
U=user; H=$(getent passwd "$U" | cut -d: -f6)
install -m 755 runner-ensure.sh /usr/local/sbin/runner-ensure.sh
install -m 755 bb-runner-guard.sh /usr/local/sbin/bb-runner-guard.sh
cat >/etc/systemd/system/bb-runner-ensure.service <<'UNIT'
[Unit]
Description=Keep the bb runner identity on the Boat box that enrolled it
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/runner-ensure.sh
RemainAfterExit=yes
TimeoutStartSec=600

[Install]
WantedBy=multi-user.target
UNIT
# Prefix drop-in: applies to every bb-host-daemon-<server>-<host>.service.
D=$H/.config/systemd/user/bb-host-daemon-.service.d
mkdir -p "$D"
cat >"$D/boat-guard.conf" <<'DROP'
[Unit]
StartLimitIntervalSec=0

[Service]
ExecStartPre=/usr/local/sbin/bb-runner-guard.sh
DROP
chown -R "$U:$U" "$D"
if [[ "${1:-}" != --no-stamp ]]; then
  id=$(sed -n 's/^export BOAT_ID="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' /run/ascii-secrets/env.sh | tail -1)
  # Stamp outside ~/.bb-machines (bb core treats every entry there as a data dir).
  mkdir -p "$H/.config/bb-runner"; echo "$id" >"$H/.config/bb-runner/boat-id"; chown -R "$U:$U" "$H/.config/bb-runner"
  rm -f "$H/.bb-machines/.boat-id"
  echo "stamped runner state for $id"
fi
mkdir -p /run/bb-runner
systemctl daemon-reload
runuser -u "$U" -- env XDG_RUNTIME_DIR=/run/user/$(id -u $U) DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u $U)/bus systemctl --user daemon-reload
systemctl enable bb-runner-ensure.service
systemctl restart bb-runner-ensure.service
cat /run/bb-runner/status
