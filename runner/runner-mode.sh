#!/usr/bin/env bash
# Run ON the box as root: switch from "standalone bb server" to "runner" mode.
# Reversible: data in ~/.bb stays; re-enable with `rm /etc/bb-runner-mode`,
# `chmod +x /usr/local/sbin/bb-ensure.sh` and `systemctl --user enable --now bb-app` as user.
# Disabling is not enough: /usr/local/bin/agents-update.sh runs
# `systemctl --user restart bb-app`, which starts a disabled unit (seen 2026-10-04).
# A ConditionPathExists drop-in keyed on /etc/bb-runner-mode blocks every start.
set -u
U=user; UID_=$(id -u $U)
uctl() { runuser -u $U -- env XDG_RUNTIME_DIR=/run/user/$UID_ DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$UID_/bus systemctl --user "$@"; }
echo "callers of bb-ensure: $(grep -rl 'bb-ensure' /etc/systemd /usr/local/bin /usr/local/sbin 2>/dev/null | tr '\n' ' ')"
touch /etc/bb-runner-mode
H=$(getent passwd $U | cut -d: -f6); mkdir -p "$H/.config/systemd/user/bb-app.service.d"
printf '[Unit]\nConditionPathExists=!/etc/bb-runner-mode\n' >"$H/.config/systemd/user/bb-app.service.d/runner-mode.conf"
chown -R $U:$U "$H/.config/systemd/user/bb-app.service.d"
uctl daemon-reload
uctl disable --now bb-app.service 2>&1 | tail -1
echo "bb-app: active=$(uctl is-active bb-app.service) enabled=$(uctl is-enabled bb-app.service)"
[ -f /usr/local/sbin/bb-ensure.sh ] && chmod -x /usr/local/sbin/bb-ensure.sh && echo "bb-ensure.sh: chmod -x (skipped by tailscale-ensure)"
timeout 10 tailscale serve --https=443 off >/dev/null 2>&1; echo "tailscale serve now: $(timeout 5 tailscale serve status 2>&1 | head -1)"
echo "node/bb processes left: $(pgrep -u $U -fa '[b]b-app|[b]b-server|[h]ost-daemon' | wc -l)"
