// Environment-lifecycle guard (T14). bb keeps environment hook state (setup /
// teardown) only in the host daemon's memory, so a daemon restart or a box stop
// in the middle of a hook leaves its outcome unknown and core blocks automatic
// cleanup ("Environment hook outcome is unknown after interruption…"). Run 9:
// three archived worktree environments stuck in phase `teardown` (failed,
// attempt 8) after the test archived threads and suspended within seconds; the
// agent-env watcher can also restart the daemon. There is NO supported recovery
// in bb 0.45.0: `bb environment cleanup` returns ok but the server keeps failing the
// teardown (the hook-operation row is never marked finished). See UPSTREAM-BB-BUGS.md.

/** The parts of bb's Environment DTO the guard reads (SDK `environments.list`). */
export interface EnvLite {
  id: string;
  status: string; // creating | provisioning | ready | error | destroyed
  lifecycle: {
    phase: string; // active | retiring | teardown | destroyed
    retireAt: number | null;
    teardown: { status: string; attempt: number } | null;
  };
}

export interface EnvBlocker {
  id: string;
  reason: "provisioning" | "teardown running" | "teardown failed" | "retiring";
}

export interface EnvGuardOptions {
  /**
   * Which retiring environments block. "all" for actions that may restart the
   * daemon or request a suspend (a retiring env starts its teardown when its
   * grace ends). "imminent" when we are about to stop the box: only those whose
   * retireAt falls within horizonMs.
   */
  retiring: "all" | "imminent";
  horizonMs: number;
}

export const DEFER_ACTIONS: EnvGuardOptions = { retiring: "all", horizonMs: 2 * 60_000 };
export const BEFORE_STOP: EnvGuardOptions = { retiring: "imminent", horizonMs: 2 * 60_000 };

/** Environments on a host that make a daemon restart / suspend / stop unsafe right now. */
export function envBlockers(envs: EnvLite[], now: number, opts: EnvGuardOptions): EnvBlocker[] {
  const out: EnvBlocker[] = [];
  for (const e of envs) {
    if (e.status === "destroyed" || e.lifecycle.phase === "destroyed") continue;
    if (e.status === "creating" || e.status === "provisioning") {
      out.push({ id: e.id, reason: "provisioning" });
    } else if (e.lifecycle.phase === "teardown") {
      out.push({ id: e.id, reason: e.lifecycle.teardown?.status === "failed" ? "teardown failed" : "teardown running" });
    } else if (e.lifecycle.phase === "retiring") {
      const r = e.lifecycle.retireAt;
      if (opts.retiring === "all" || r === null || r - now <= opts.horizonMs) out.push({ id: e.id, reason: "retiring" });
    }
  }
  return out;
}

/** "env_a teardown failed, env_b retiring" for logs and progress. */
export function describeBlockers(b: EnvBlocker[]): string {
  return b.map((x) => `${x.id} ${x.reason}`).join(", ");
}

/** A failed teardown can't be fixed from bb's CLI/SDK: say so, don't suggest a fake recovery. */
export function recoveryHint(b: EnvBlocker[]): string | null {
  const failed = b.filter((x) => x.reason === "teardown failed").map((x) => x.id);
  if (failed.length === 0) return null;
  return `teardown failed for ${failed.join(", ")}: bb has no supported recovery for an interrupted hook (the record stays until bb fixes it); inspect the worktree so no work is lost, and tell the owner`;
}
