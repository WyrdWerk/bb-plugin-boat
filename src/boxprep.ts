// Box preparation right before bb's bootstrap (T12, from run 6 on a test runner).
// Both fixes were first applied by hand on the box, then encoded here.
//
// 1. Stale skill tree: a failed first pull leaves an EMPTY
//    ~/.bb-machines/<server>/runtime/skill-store/<hash>/ and the daemon never
//    retries ("Failed to pull required injected skill tree … ENOENT …/.last-used").
//    Deleting empty <hash> dirs lets the next pull complete.
// 2. No provider auth in the daemon: Claude Code on Boat boxes authenticates via
//    CLAUDE_CODE_OAUTH_TOKEN in /run/ascii-secrets/env.sh; the bb-host-daemon user
//    unit only had HOME ("Not logged in · Please run /login"). Give every
//    bb-host-daemon-*.service an EnvironmentFile generated from Boat's secret files.
//
// Never print values: scripts report counts, variable NAMES of interest, a short
// content hash (change detection) and booleans.

/**
 * User-level: delete empty skill-store entries and `.tmp-*` leftovers in every bb
 * data dir (plus the rename-probe area). Prints `skill-store-cleaned=<n> tmp-cleaned=<m>`.
 */
export function skillStoreCleanupScript(minTmpAgeMinutes = 0): string {
  // Before bootstrap no pull can be running: remove every .tmp-*. In the background
  // (threads may be starting) only remove .tmp-* older than minTmpAgeMinutes.
  const age = minTmpAgeMinutes > 0 ? ` -mmin +${Math.floor(minTmpAgeMinutes)}` : "";
  return [
    "set -u",
    "n=0; t=0",
    'for d in "$HOME"/.bb-machines/*/runtime/skill-store; do',
    '  [ -d "$d" ] || continue',
    '  c=$(find "$d" -mindepth 1 -maxdepth 1 -type d -empty | wc -l)',
    '  find "$d" -mindepth 1 -maxdepth 1 -type d -empty -delete',
    "  n=$((n + c))",
    // T13: a rename that failed with EIO (lazy restore) leaves the daemon's
    // half-built `.tmp-…` tree behind.
    `  c=$(find "$d" -mindepth 1 -maxdepth 1 -name ".tmp-*"${age} | wc -l)`,
    `  find "$d" -mindepth 1 -maxdepth 1 -name ".tmp-*"${age} -exec rm -rf {} +`,
    "  t=$((t + c))",
    "done",
    // The T13 rename probe's area, if a failed attempt left it behind.
    'rm -rf "$HOME/.bb-machines/.rename-probe" "$HOME"/.bb-machines/*/runtime/.bb-rename-probe 2>/dev/null',
    'echo "skill-store-cleaned=$n tmp-cleaned=$t"',
  ].join("\n");
}

export const AGENT_ENV_FILE = "/run/bb-runner/agent-env";
/** Secret sources on Boat boxes (bws-providers.sh appears when pi-boot-init finishes). */
export const AGENT_ENV_SOURCES = ["/run/ascii-secrets/env.sh", "/run/ascii-secrets/bws-providers.sh"] as const;
/**
 * Never copied: the unit manages these, and systemd does not expand `$VAR` in an
 * EnvironmentFile, so `export PATH="$PATH:…"` would break the daemon's PATH.
 */
export const AGENT_ENV_EXCLUDE = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "PWD", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"] as const;

/**
 * Root script (run via `sudo -n bash -c`). Generates AGENT_ENV_FILE (dir 0700 user,
 * file 0600 user, atomic mv), installs the prefix drop-in
 * `bb-host-daemon-.service.d/20-agent-env.conf`, daemon-reloads, and restarts running
 * bb-host-daemon units when the content changed since it was last applied and
 * `restart` is allowed. Last line:
 *   agent-env=ok vars=<n> hash=<16 hex> changed=yes|no restarted=<n> claude=yes|no bws=yes|no
 */
export function agentEnvScript(restart: boolean): string {
  const exclude = AGENT_ENV_EXCLUDE.join("|");
  return [
    "set -uo pipefail",
    "U=user",
    'UID_=$(id -u "$U") || { echo "agent-env=failed reason=no-user"; exit 1; }',
    'H=$(getent passwd "$U" | cut -d: -f6)',
    'uctl() { runuser -u "$U" -- env XDG_RUNTIME_DIR=/run/user/$UID_ DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$UID_/bus timeout 60 systemctl --user "$@"; }',
    "RUN=/run/bb-runner",
    `F=${AGENT_ENV_FILE}`,
    'install -d -m 0700 -o "$U" -g "$U" "$RUN"',
    'T=$(mktemp "$RUN/.agent-env.XXXXXX") || { echo "agent-env=failed reason=mktemp"; exit 1; }',
    'chmod 600 "$T"',
    // KEY=value only, no `export ` prefix (systemd logs invalid lines WITH their values).
    `for s in ${AGENT_ENV_SOURCES.join(" ")}; do`,
    `  [ -r "$s" ] && sed -nE 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/\\2=\\3/p' "$s"`,
    `done | grep -vE '^(${exclude})=' >"$T"`,
    'chown "$U:$U" "$T"',
    'mv -f "$T" "$F"',
    'vars=$(grep -c . "$F")',
    "hash=$(sha256sum <\"$F\" | cut -c1-16)",
    "claude=$(grep -q '^CLAUDE_CODE_OAUTH_TOKEN=' \"$F\" && echo yes || echo no)",
    'bws=$([ -s /run/ascii-secrets/bws-providers.sh ] && echo yes || echo no)',
    'D="$H/.config/systemd/user/bb-host-daemon-.service.d"',
    'mkdir -p "$D"',
    `printf '[Service]\\nEnvironmentFile=-%s\\n' "$F" >"$D/20-agent-env.conf"`,
    'chown -R "$U:$U" "$D"',
    "uctl daemon-reload >/dev/null 2>&1",
    'applied=$(cat "$RUN/agent-env.applied" 2>/dev/null || true)',
    'changed=$([ "$applied" = "$hash" ] && echo no || echo yes)',
    "restarted=0",
    `if [ "$changed" = yes ] && [ ${restart ? 1 : 0} = 1 ]; then`,
    '  for u in $(find "$H/.config/systemd/user" -maxdepth 1 -name "bb-host-daemon-*.service" -printf "%f\\n" 2>/dev/null); do',
    '    if [ "$(uctl is-active "$u" 2>/dev/null)" = active ]; then uctl restart "$u" >/dev/null 2>&1 && restarted=$((restarted + 1)); fi',
    "  done",
    '  echo "$hash" >"$RUN/agent-env.applied"',
    "fi",
    'echo "agent-env=ok vars=$vars hash=$hash changed=$changed restarted=$restarted claude=$claude bws=$bws"',
  ].join("\n");
}

export interface AgentEnvResult {
  ok: boolean;
  vars: number;
  hash: string;
  changed: boolean;
  restarted: number;
  claude: boolean;
  bws: boolean;
  reason?: string;
}

export function parseAgentEnv(stdout: string, exitCode: number): AgentEnvResult {
  const line = stdout
    .split("\n")
    .reverse()
    .find((l) => l.startsWith("agent-env="));
  const f: Record<string, string> = {};
  for (const p of (line ?? "").trim().split(/\s+/)) {
    const i = p.indexOf("=");
    if (i > 0) f[p.slice(0, i)] = p.slice(i + 1);
  }
  const ok = exitCode === 0 && f["agent-env"] === "ok";
  return {
    ok,
    vars: Number(f.vars ?? 0) || 0,
    hash: f.hash ?? "",
    changed: f.changed === "yes",
    restarted: Number(f.restarted ?? 0) || 0,
    claude: f.claude === "yes",
    bws: f.bws === "yes",
    ...(ok ? {} : { reason: f.reason ?? (line ? `exit ${exitCode}` : `exit ${exitCode} without a result line (sudo -n refused?)`) }),
  };
}

export function parseSkillStoreCleanup(stdout: string): number {
  const m = /skill-store-cleaned=(\d+)/.exec(stdout);
  return m ? Number(m[1]) : 0;
}

/** `.tmp-*` leftovers removed by the same script (T13). */
export function parseTmpCleanup(stdout: string): number {
  const m = /tmp-cleaned=(\d+)/.exec(stdout);
  return m ? Number(m[1]) : 0;
}
