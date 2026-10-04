// Runner conversion (T6): turn a fresh fork of the base box (which may run its
// own standalone bb server; see BOX-CONTRACT.md) into a bb runner.
// Runs on the NEW box only, as root via `sudo -n`, after Boat has settled and
// before the identity guard and bootstrap. Idempotent: safe on retried creates
// and on every resume. Never prints env, secrets or Tailscale state.
//
// Evidence for each step: DESIGN.md.
//   - bb-app.service (user unit) runs the box's own bb server on :38886.
//   - Disabling it is not enough: /usr/local/bin/agents-update.sh runs
//     `systemctl --user restart bb-app`, which starts a disabled unit.
//   - /usr/local/sbin/bb-ensure.sh starts bb-app and publishes it with
//     `tailscale serve`. Callers: tailscale-ensure.sh (only if executable),
//     pi-boot-init.sh (calls it directly), boat-heal.sh (after DB repair).
import { BB_RUNNER_GUARD_SH, RUNNER_ENSURE_SH } from "./runner-files.generated.ts";

/** The standalone bb server's port on the base box. */
export const BB_SERVER_PORT = 38886;
/** Marker file; the bb-app drop-in and the bb-ensure.sh guard key on it. */
export const RUNNER_MODE_MARKER = "/etc/bb-runner-mode";
const EOF_MARK = "BB_RUNNER_FILE_EOF";

function heredoc(path: string, mode: string, content: string): string {
  if (content.includes(EOF_MARK)) throw new Error(`embedded file contains ${EOF_MARK}`);
  return [`cat >${path} <<'${EOF_MARK}'`, content.replace(/\n$/, ""), EOF_MARK, `chmod ${mode} ${path}`].join("\n");
}

/** Bash script, run as root. Last stdout line: `runner-conversion=ok …` or `runner-conversion=failed reason=…`. */
export function runnerConversionScript(): string {
  return [
    "set -uo pipefail",
    "U=user",
    'UID_=$(id -u "$U") || { echo "runner-conversion=failed reason=no-user-$U"; exit 1; }',
    'H=$(getent passwd "$U" | cut -d: -f6)',
    'uctl() { runuser -u "$U" -- env XDG_RUNTIME_DIR=/run/user/$UID_ DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$UID_/bus timeout 30 systemctl --user "$@"; }',
    'fail() { echo "runner-conversion=failed reason=$1"; exit 1; }',
    `listening() { timeout 2 bash -c 'exec 3<>/dev/tcp/127.0.0.1/${BB_SERVER_PORT}' 2>/dev/null; }`,
    `served() { command -v tailscale >/dev/null && timeout 10 tailscale serve status --json 2>/dev/null | grep -q ':${BB_SERVER_PORT}'; }`,
    "",
    "# 1. Block the box's own bb server (user unit bb-app.service) for good.",
    `touch ${RUNNER_MODE_MARKER}`,
    'D="$H/.config/systemd/user/bb-app.service.d"',
    'mkdir -p "$D"',
    `printf '[Unit]\\nConditionPathExists=!${RUNNER_MODE_MARKER}\\n' >"$D/runner-mode.conf"`,
    'chown -R "$U:$U" "$D"',
    "uctl daemon-reload >/dev/null 2>&1",
    "uctl disable --now bb-app.service >/dev/null 2>&1 || true",
    "#    Its boot-time starter: make it a no-op in runner mode, and non-executable.",
    "B=/usr/local/sbin/bb-ensure.sh",
    'if [ -f "$B" ]; then',
    `  grep -q '${RUNNER_MODE_MARKER}' "$B" || sed -i '1a [ -e ${RUNNER_MODE_MARKER} ] \\&\\& exit 0  # bb runner: own bb server stays off' "$B"`,
    '  chmod -x "$B"',
    "fi",
    "#    A server started outside the unit (by hand or an old script). The [b]",
    "#    keeps the pattern from matching this script's own parent shell, whose",
    "#    command line holds the script text (live run 2026-10-04: exit 143).",
    "pkill -u \"$U\" -f '[b]in/bb-app --server-bind-host' 2>/dev/null || true",
    "",
    "# 2. Stop publishing it on the box's tailnet name.",
    "if served; then timeout 15 tailscale serve --https=443 off >/dev/null 2>&1; fi",
    "if served; then timeout 15 tailscale serve reset >/dev/null 2>&1; fi",
    "",
    "# 3. runner-ensure on every runner (fork identity guard, T1). No stamp here:",
    "#    runner-ensure itself wipes any copied identity, then stamps this box.",
    heredoc("/usr/local/sbin/runner-ensure.sh", "755", RUNNER_ENSURE_SH),
    heredoc("/usr/local/sbin/bb-runner-guard.sh", "755", BB_RUNNER_GUARD_SH),
    "cat >/etc/systemd/system/bb-runner-ensure.service <<'UNIT'",
    "[Unit]",
    "Description=Keep the bb runner identity on the Boat box that enrolled it",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=oneshot",
    "ExecStart=/usr/local/sbin/runner-ensure.sh",
    "RemainAfterExit=yes",
    "TimeoutStartSec=600",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "UNIT",
    'G="$H/.config/systemd/user/bb-host-daemon-.service.d"',
    'mkdir -p "$G"',
    `printf '[Unit]\\nStartLimitIntervalSec=0\\n\\n[Service]\\nExecStartPre=/usr/local/sbin/bb-runner-guard.sh\\n' >"$G/boat-guard.conf"`,
    'chown -R "$U:$U" "$G"',
    "systemctl daemon-reload",
    "uctl daemon-reload >/dev/null 2>&1",
    "systemctl enable bb-runner-ensure.service >/dev/null 2>&1",
    "timeout 360 systemctl restart bb-runner-ensure.service >/dev/null 2>&1 || fail runner-ensure-did-not-run",
    "",
    "# 4. Verify.",
    "for _ in $(seq 1 20); do listening || break; sleep 1; done",
    `listening && fail port-${BB_SERVER_PORT}-still-listening`,
    "act=$(uctl is-active bb-app.service 2>/dev/null)",
    "en=$(uctl is-enabled bb-app.service 2>/dev/null)",
    '[ "$act" = active ] && fail bb-app-still-active',
    '[ "$en" = enabled ] && fail bb-app-still-enabled',
    `[ -e ${RUNNER_MODE_MARKER} ] && [ -f "$D/runner-mode.conf" ] || fail bb-app-block-missing`,
    '[ -f "$B" ] && [ -x "$B" ] && fail bb-ensure-still-executable',
    "served && fail bb-server-still-on-tailnet",
    `serve=$(command -v tailscale >/dev/null && echo off || echo no-tailscale)`,
    "[ \"$(systemctl is-enabled bb-runner-ensure.service 2>/dev/null)\" = enabled ] || fail runner-ensure-not-enabled",
    '[ -s /run/bb-runner/verified ] || fail runner-ensure-not-verified',
    '[ -f "$G/boat-guard.conf" ] || fail daemon-guard-missing',
    "st=$(cat /run/bb-runner/status 2>/dev/null)",
    'case "$st" in ok|needs-enrollment) ;; *) fail "runner-ensure-status-${st:-none}";; esac',
    'echo "runner-conversion=ok bb-app=${act:-inactive}/${en:-unknown} port' + BB_SERVER_PORT + '=free serve=$serve runner-ensure=$st"',
  ].join("\n");
}

export type ConversionResult = { ok: true; summary: string } | { ok: false; reason: string };

/** Read the script's one-line verdict; anything else counts as failure. */
export function parseConversionResult(stdout: string, exitCode: number): ConversionResult {
  const line = stdout
    .split("\n")
    .map((l) => l.trim())
    .reverse()
    .find((l) => l.startsWith("runner-conversion="));
  if (!line) return { ok: false, reason: exitCode === 0 ? "no result line" : `exit ${exitCode} without a result line (sudo -n refused?)` };
  if (line.startsWith("runner-conversion=ok") && exitCode === 0) return { ok: true, summary: line };
  const m = /reason=(\S+)/.exec(line);
  return { ok: false, reason: m ? m[1]! : `exit ${exitCode}: ${line}` };
}

/** argv for the executor: root via passwordless sudo, script as one bash -c argument. */
export function runnerConversionCommand(): string[] {
  return ["sudo", "-n", "bash", "-c", runnerConversionScript()];
}
