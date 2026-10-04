// Filesystem-settled gate (T13). While Boat is still lazily restoring a box's
// disk (minutes after "ready", and again after every resume), DIRECTORY RENAMES
// under /home fail with EIO, even for brand-new dirs. bb's daemon installs skill
// trees by building `.tmp-…` and rename()-ing it into runtime/skill-store/<hash>,
// so thread starts failed (runs 7–8: ENOENT …/.last-used or EIO on rename) until
// the restore finished. Probe the same filesystem until renames work N times in a row.

/** Fallback probe area when no bb data dir exists yet (create): only directories live here (T8). */
export const RENAME_PROBE_DIR = "$HOME/.bb-machines/.rename-probe";

/**
 * One attempt (box user). Location: inside the daemon's data dir when it exists
 * (`~/.bb-machines/<server>/runtime/.bb-rename-probe`, resume), else
 * RENAME_PROBE_DIR (create; the data dir doesn't exist before bootstrap).
 * mkdir a fresh dir, write a file, `mv` the dir to a new name, delete it. Also counts
 * kernel I/O error lines since boot (journalctl -k, else dmesg; via sudo -n).
 * Prints one line, codes and counts only:
 *   rename=ok|fail [err=<CODE> step=<step>] where=runtime|bb-machines kio=<n>|unknown kio_vda=<n>|unknown
 */
export function renameProbeScript(): string {
  return [
    "set -u",
    'P=""',
    'for r in "$HOME"/.bb-machines/*/runtime; do [ -d "$r" ] && P="$r/.bb-rename-probe" && W=runtime && break; done',
    `[ -n "$P" ] || { P="${RENAME_PROBE_DIR}"; W=bb-machines; }`,
    'a="$P/a.$$"; b="$P/b.$$"',
    // Kernel I/O errors since boot. Pattern from the owner's runs; vda = the box disk.
    "k=$({ sudo -n journalctl -k -b --no-pager -o cat 2>/dev/null || sudo -n dmesg 2>/dev/null; } | grep -E 'I/O error|blk_update_request|EIO')",
    'if sudo -n true 2>/dev/null; then kio=$(printf "%s" "$k" | grep -c . ); kv=$(printf "%s" "$k" | grep -c vda); else kio=unknown; kv=unknown; fi',
    'tail_="where=$W kio=$kio kio_vda=$kv"',
    'code() { case "$1" in *"Input/output error"*) echo EIO;; *"No such file"*) echo ENOENT;; *"Permission denied"*) echo EACCES;; *"Read-only"*) echo EROFS;; *"No space"*) echo ENOSPC;; *) echo OTHER;; esac; }',
    'fail() { echo "rename=fail err=$(code "$2") step=$1 $tail_"; rm -rf "$a" "$b" 2>/dev/null; exit 0; }',
    'e=$(mkdir -p "$P" 2>&1) || fail mkdir-parent "$e"',
    'rm -rf "$a" "$b" 2>/dev/null',
    'e=$(mkdir "$a" 2>&1) || fail mkdir "$e"',
    'e=$( { echo probe >"$a/f"; } 2>&1) || fail write "$e"',
    'e=$(mv "$a" "$b" 2>&1) || fail rename "$e"',
    'e=$(rm -rf "$b" 2>&1) || fail delete "$e"',
    'echo "rename=ok $tail_"',
  ].join("\n");
}

/** Remove the probe areas once the gate is done (best effort). */
export function renameProbeCleanupScript(): string {
  return `rm -rf "${RENAME_PROBE_DIR}" "$HOME"/.bb-machines/*/runtime/.bb-rename-probe 2>/dev/null; echo rename-probe-cleaned=1`;
}

export interface RenameProbe {
  ok: boolean;
  err: string | null;
  step: string | null;
  where: "runtime" | "bb-machines" | "unknown";
  /** Kernel I/O error lines since boot; null when not readable (no sudo/journal). */
  kio: number | null;
  kioVda: number | null;
}

export function parseRenameProbe(stdout: string, exitCode = 0): RenameProbe {
  const line = stdout.split("\n").find((l) => l.startsWith("rename=")) ?? "";
  const f: Record<string, string> = {};
  for (const p of line.trim().split(/\s+/)) {
    const i = p.indexOf("=");
    if (i > 0) f[p.slice(0, i)] = p.slice(i + 1);
  }
  const num = (v: string | undefined) => (v !== undefined && /^\d+$/.test(v) ? Number(v) : null);
  const ok = f.rename === "ok" && exitCode === 0;
  return {
    ok,
    err: ok ? null : (f.err ?? (line ? "OTHER" : "NO_RESULT")),
    step: ok ? null : (f.step ?? "unknown"),
    where: f.where === "runtime" || f.where === "bb-machines" ? f.where : "unknown",
    kio: num(f.kio),
    kioVda: num(f.kio_vda),
  };
}

export interface RenameGateOptions {
  /** Consecutive successes required (setting renameProbeOk, default 6). */
  requiredOk: number;
  /** Give up after this long (setting renameProbeTimeoutMinutes, default 20 min). */
  timeoutMs: number;
}

export const DEFAULT_RENAME_GATE: RenameGateOptions = { requiredOk: 6, timeoutMs: 20 * 60_000 };

export interface RenameGateState {
  consecutive: number;
  /** Kernel I/O error count at the previous sample (null = unknown). */
  lastKio: number | null;
}

/**
 * Pure state machine. A sample counts toward the streak only if the rename worked
 * AND the kernel I/O error count did not grow since the previous sample (when known).
 */
export function renameGateStep(
  state: RenameGateState,
  probe: RenameProbe,
  opts: RenameGateOptions,
): RenameGateState & { done: boolean; kioGrew: boolean } {
  const kioGrew = probe.kio !== null && state.lastKio !== null && probe.kio > state.lastKio;
  const good = probe.ok && !kioGrew;
  const consecutive = good ? state.consecutive + 1 : 0;
  return { consecutive, lastKio: probe.kio ?? state.lastKio, done: consecutive >= opts.requiredOk, kioGrew };
}
