// Pure policy for the Boat machine provider: naming, the fork-identity rule
// (T1), the post-resume settle rule (T2) and idle / pre-TTL suspension.
// No I/O here, so every rule is unit-testable without Boat.
import { createHash } from "node:crypto";

/**
 * Recognisable Boat name for a runner, set with PATCH after create. Display only:
 * Boat ignores names on fork (live 2026-10-04), so nothing looks boxes up by it.
 */
export function runnerBoxName(key: string): string {
  return `bb-runner ${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
}

/**
 * Deterministic Idempotency-Key for a bb creation key. A retried create sends the
 * same key and body, so Boat returns the same box instead of billing a second one
 * (keys bind for 24 h).
 */
export function idempotencyKey(key: string): string {
  const h = createHash("sha256").update(`bb-plugin-boat:${key}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** bb machine display name: bx_abc123 → bx-abc123 (same as the Tailscale node). */
export function machineName(boxId: string): string {
  return boxId.replace(/_/g, "-");
}

const BOX_ID = /^bx_[a-z0-9]+$/;

export function assertBoxId(id: string): string {
  if (!BOX_ID.test(id)) throw new Error(`not a Boat box id: ${JSON.stringify(id)}`);
  return id;
}

/**
 * T1 rule. A fork or snapshot copy carries ~/.bb-machines/<server>/auth.json from
 * its source and would connect as the source machine (seen: the two daemons
 * replaced each other's hub session every ~3 s). Before bootstrap on a box, keep
 * runner state only if the stamp says it was made on this box; otherwise remove
 * the copied identity. Writing the stamp afterwards keeps a retried create (same
 * box) from wiping an enrollment it already finished. Runs as the box user.
 */
/** Runner stamp directory, relative to the box user's home (see identityGuardScript). */
export const STAMP_REL_DIR = ".config/bb-runner";

export function identityGuardScript(boxId: string): string {
  const id = assertBoxId(boxId);
  return [
    "set -u",
    // Stamp outside ~/.bb-machines: bb core's bootstrap opens <entry>/auth.json for
    // every entry there and failed on a stamp file (ENOTDIR, live resume, T8).
    `R="$HOME/.bb-machines"; SD="$HOME/${STAMP_REL_DIR}"; S="$SD/boat-id"; U="$HOME/.config/systemd/user"`,
    `ID=${id}`,
    'if [ -e "$R/.boat-id" ]; then mkdir -p "$SD"; [ -s "$S" ] || mv -f "$R/.boat-id" "$S"; rm -f "$R/.boat-id"; fi',
    'if [ -d "$R" ] && [ "$(cat "$S" 2>/dev/null)" != "$ID" ]; then',
    '  for u in $(ls "$U" 2>/dev/null | grep -E \'^bb-host-daemon-.*\\.service$\'); do',
    '    systemctl --user disable --now "$u" >/dev/null 2>&1; rm -f "$U/$u"',
    "  done",
    "  systemctl --user daemon-reload >/dev/null 2>&1; systemctl --user reset-failed >/dev/null 2>&1",
    "  pkill -f '[b]b-app[ /]host-daemon' 2>/dev/null",
    '  find "$R" -mindepth 1 -maxdepth 1 -exec rm -rf {} +',
    "  echo identity=wiped",
    "else",
    "  echo identity=kept",
    "fi",
    'mkdir -p "$SD" && echo "$ID" >"$S"',
  ].join("\n");
}

/** Boot units from the snapshot, in start order. All are started if Boat skips them. */
export const BOOT_UNITS = ["pi-boot-init", "tailscale-rejoin", "agents-update"] as const;
/**
 * Units settle waits for. T11: only tailscale-rejoin. pi-boot-init can stay
 * `activating` for minutes (live: still activating at +5 min) and isn't needed to
 * enroll; reaching the hub is checked directly by the hub gate before bootstrap.
 */
export const REQUIRED_BOOT_UNITS = ["tailscale-rejoin"] as const;

/**
 * T2 probe, run on the box. Prints one line per check:
 *   verified=yes|no            runner-ensure ran after Boat's "reboot semantics"
 *   ensure=yes|no              runner-ensure is installed on this box at all
 *   repo <path> <n> <names>    git status --porcelain for each bb checkout/worktree
 */
export const SETTLE_PROBE_SCRIPT = [
  "set -u",
  'echo "verified=$([ -s /run/bb-runner/verified ] && echo yes || echo no)"',
  'echo "ensure=$([ -x /usr/local/sbin/runner-ensure.sh ] && echo yes || echo no)"',
  // T19: a bb-ensure.sh process (started by pi-boot-init, tailscale-ensure or
  // boat-heal) publishes the box's own bb server with `tailscale serve`. The
  // conversion's chmod -x cannot stop an instance that is already running (bash
  // keeps executing the old inode), so settle must see none running. `( |$)` keeps
  // the pattern from matching any script text that merely names the path
  // (T7: a pgrep -f pattern must never match a shell carrying a script).
  'echo "ensure-running=$(pgrep -f \'[b]b-ensure\\.sh( |$)\' >/dev/null 2>&1 && echo yes || echo no)"',
  // T2/T8: Boat starts the snapshot's boot units itself after "ready" (~50–80 s), or
  // sometimes never (one base fork: 40 min). One line per unit:
  //   unit <name> <LoadState> <ActiveState> <Result> <ExecMainStartTimestampMonotonic>
  // A start timestamp of 0 means "never started this boot".
  `for u in ${BOOT_UNITS.join(" ")}; do`,
  // KEY=VALUE, parsed by name. T11: `--value` loses the names and systemd prints
  // properties in ITS order, not the -p order (systemd 255 on the boxes lists
  // Service properties before Unit ones), so positional parsing read Result as
  // LoadState and every unit looked absent.
  '  echo "unit $u $(systemctl show -p LoadState -p ActiveState -p Result -p ExecMainStartTimestampMonotonic $u.service 2>/dev/null | tr "\\n" " ")"',
  "done",
  // T8: the base's agents-update writes this ~8–10 min after ready. Sanitized, one line.
  'm=/run/user/$(id -u)/agents-update.done',
  'if [ -s "$m" ]; then echo "agents=$(head -1 "$m" | tr -cd "A-Za-z0-9=:._ +-" | cut -c1-300)"; else echo agents=none; fi',
  'for g in "$HOME"/.bb-machines/*/checkouts/*/.git "$HOME"/.bb-machines/*/plugins/environment-git-worktree/host-data/worktrees/*/*/.git; do',
  '  [ -e "$g" ] || continue; r=${g%/.git}',
  '  st=$(cd "$r" && timeout 60 git status --porcelain 2>/dev/null | awk \'{print $NF}\' | sort | tr "\\n" " ")',
  '  n=$(printf %s "$st" | wc -w); echo "repo $r $n $st"',
  "done",
].join("\n");

export type BootUnitState = "absent" | "notstarted" | "running" | "done" | "failed" | "unknown";

/** Classify one `unit …` probe line's systemctl fields. */
export function bootUnitState(load: string, active: string, result: string, startMono: string): BootUnitState {
  if (load === "") return "unknown"; // couldn't read it: fail closed
  if (load !== "loaded") return "absent";
  if (active === "activating" || active === "deactivating" || active === "reloading") return "running";
  if (active === "failed" || (result !== "" && result !== "success")) return "failed";
  if (active === "active") return "done";
  return /^[1-9][0-9]*$/.test(startMono) ? "done" : "notstarted";
}

export interface SettleSample {
  at: number;
  verified: boolean;
  ensureInstalled: boolean;
  /** A bb-ensure.sh process is running (T19: it can re-publish the box's own bb server). */
  ensureRunning: boolean;
  /** A required boot unit hasn't finished yet (not started by Boat, or still running). */
  bootPending: boolean;
  /** Per-unit state; empty when the probe had no unit lines. */
  bootUnits: Record<string, BootUnitState>;
  /** agents-update marker line (`<time> pi=ok codex=ok …`), or null if not written yet. */
  agentsMarker: string | null;
  /** repo path → sorted dirty file names */
  repos: Record<string, string[]>;
}

export function parseSettleProbe(stdout: string, at: number): SettleSample {
  const sample: SettleSample = { at, verified: false, ensureInstalled: false, ensureRunning: false, bootPending: false, bootUnits: {}, agentsMarker: null, repos: {} };
  for (const line of stdout.split("\n")) {
    if (line.startsWith("verified=")) sample.verified = line.endsWith("yes");
    else if (line.startsWith("ensure-running=")) sample.ensureRunning = line.endsWith("yes");
    else if (line.startsWith("ensure=")) sample.ensureInstalled = line.endsWith("yes");
    else if (line.startsWith("boot=")) sample.bootPending = line.endsWith("pending");
    else if (line.startsWith("unit ")) {
      const [, name, ...pairs] = line.trim().split(/\s+/);
      const f: Record<string, string> = {};
      for (const p of pairs) {
        const i = p.indexOf("=");
        if (i > 0) f[p.slice(0, i)] = p.slice(i + 1);
      }
      if (name) {
        sample.bootUnits[name] = bootUnitState(f.LoadState ?? "", f.ActiveState ?? "", f.Result ?? "", f.ExecMainStartTimestampMonotonic ?? "");
      }
    } else if (line.startsWith("agents=")) {
      const v = line.slice("agents=".length).trim();
      sample.agentsMarker = v === "none" || v === "" ? null : v;
    }
    else if (line.startsWith("repo ")) {
      const [, path, , ...names] = line.trim().split(/\s+/);
      if (path) sample.repos[path] = names.filter(Boolean).sort();
    }
  }
  if (Object.keys(sample.bootUnits).length > 0) {
    sample.bootPending = REQUIRED_BOOT_UNITS.some((u) => {
      const st = sample.bootUnits[u];
      return st === "notstarted" || st === "running" || st === "unknown";
    });
  }
  return sample;
}

/** Boot units Boat never started (candidates for the plugin to start itself). */
export function unstartedBootUnits(sample: SettleSample): string[] {
  return BOOT_UNITS.filter((u) => sample.bootUnits[u] === "notstarted");
}

export interface SettleOptions {
  /** Minimum gap between the two matching samples. T2 saw dirty files clear within ~20 s. */
  stableForMs: number;
  /** Give up after this long and report unsettled rather than pretend. */
  timeoutMs: number;
}

// 12 min: a 2-min wait for Boat to start the boot units, then pi-boot-init (~2 min
// observed) and tailscale-ensure (bounded 10 min by its unit) on top of hydration.
export const DEFAULT_SETTLE: SettleOptions = { stableForMs: 10_000, timeoutMs: 12 * 60_000 };

export type SettleDecision =
  | { status: "settled" }
  | { status: "wait"; reason: string }
  | { status: "timeout"; reason: string }
  | { status: "failed"; reason: string };

function sameRepos(a: Record<string, string[]>, b: Record<string, string[]>): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.join("\0") !== kb.join("\0")) return false;
  return ka.every((k) => a[k]!.join("\0") === b[k]!.join("\0"));
}

/**
 * T19 conversion race: pi-boot-init calls bb-ensure.sh, which publishes the box's
 * own bb server with `tailscale serve --https=443 → 127.0.0.1:38886`. If that is
 * still running when the conversion runs, its `chmod -x` + marker guard cannot
 * stop it (bash keeps executing the old inode), so it can re-publish after the
 * conversion's serve off and fail the verify. Settle waits, bounded by the settle
 * timeout, for pi-boot-init to finish and for no bb-ensure.sh process to run.
 * `notstarted` counts as pending: settle itself starts the boot units Boat skipped.
 */
export function conversionRacePending(s: SettleSample): string | null {
  const pi = s.bootUnits["pi-boot-init"];
  if (pi === "running" || pi === "notstarted" || pi === "unknown") return `pi-boot-init has not finished (${pi})`;
  if (s.ensureRunning) return "bb-ensure.sh is running (it can re-publish the box's own bb server)";
  return null;
}

/**
 * T2 rule: after resume (or create from a snapshot) the box is settled when
 * runner-ensure has run (if installed) and every bb repo is clean, or matches the
 * dirty set recorded before suspend, in two samples at least `stableForMs` apart.
 */
export function settleDecision(
  samples: SettleSample[],
  startedAt: number,
  opts: SettleOptions = DEFAULT_SETTLE,
  expectedDirty: Record<string, string[]> = {},
): SettleDecision {
  const last = samples.at(-1);
  const elapsed = (last?.at ?? startedAt) - startedAt;
  const verdict = (reason: string): SettleDecision =>
    elapsed >= opts.timeoutMs ? { status: "timeout", reason } : { status: "wait", reason };
  if (!last) return verdict("no probe yet");
  const failed = REQUIRED_BOOT_UNITS.filter((u) => last.bootUnits[u] === "failed");
  if (failed.length > 0) {
    return {
      status: "failed",
      reason: `boot unit ${failed.map((u) => `${u}.service`).join(", ")} failed: without it the box has no Tailscale and can't reach the bb hub`,
    };
  }
  if (last.bootPending) {
    const states = REQUIRED_BOOT_UNITS.map((u) => `${u}=${last.bootUnits[u] ?? "?"}`).join(", ");
    return verdict(
      Object.keys(last.bootUnits).length > 0
        ? `boot units not finished (${states})`
        : "Boat has not started the box's units yet (tailscale-rejoin pending)",
    );
  }
  // T19: don't convert while pi-boot-init/bb-ensure.sh can still publish the box.
  const race = conversionRacePending(last);
  if (race) return verdict(race);
  if (last.ensureInstalled && !last.verified) return verdict("runner-ensure has not run yet (Boat reboot semantics pending)");
  const expected = (path: string) => expectedDirty[path] ?? [];
  const unexpected = Object.entries(last.repos).filter(([p, names]) => names.join("\0") !== expected(p).join("\0"));
  if (unexpected.length > 0) {
    return verdict(`repos still changing: ${unexpected.map(([p, n]) => `${p.split("/").slice(-2).join("/")} (${n.length})`).join(", ")}`);
  }
  const earlier = samples.slice(0, -1).reverse().find((s) => last.at - s.at >= opts.stableForMs);
  if (!earlier || !sameRepos(earlier.repos, last.repos) || earlier.bootPending || conversionRacePending(earlier) || (earlier.ensureInstalled && !earlier.verified)) {
    return verdict("waiting for a second matching sample");
  }
  return { status: "settled" };
}

/** T2: a restore marked "Restore incomplete" really lost files (npm had 1743/1938). */
export function restoreProblem(error: string | null | undefined): string | null {
  if (error && /^Restore incomplete/i.test(error)) {
    return `Boat reports an incomplete restore; files may be missing. Stop and resume the box, or inspect it, before running agents. (${error.slice(0, 160)})`;
  }
  return null;
}

export interface LifecycleInput {
  now: number;
  /** Last thread or terminal activity on the machine (ms). */
  lastActiveAt: number;
  /** null disables idle suspension. */
  idleMs: number | null;
  /** Boat auto-stop time (ISO) or null for no auto-stop. */
  archiveAfter: string | null;
  /** Suspend or extend this long before Boat's auto-stop. Covers core's 5-min drain + snapshot. */
  preTtlMarginMs: number;
  /** Any starting/active thread on the machine. */
  busy: boolean;
}

export type LifecycleAction = "none" | "suspend-idle" | "suspend-before-ttl" | "extend-ttl";

/**
 * Idle and pre-TTL policy. Boat stops a box at `archiveAfter` without telling bb,
 * which would cut a running turn and leave the hub showing a stale "connected"
 * machine. So before the deadline: extend the TTL if work is running, otherwise
 * suspend through bb (core drains, then the provider stops the box).
 */
export function lifecycleDecision(i: LifecycleInput): LifecycleAction {
  if (i.archiveAfter !== null) {
    const deadline = Date.parse(i.archiveAfter);
    if (Number.isFinite(deadline) && deadline - i.now <= i.preTtlMarginMs) {
      return i.busy ? "extend-ttl" : "suspend-before-ttl";
    }
  }
  if (!i.busy && i.idleMs !== null && i.now - i.lastActiveAt >= i.idleMs) return "suspend-idle";
  return "none";
}
