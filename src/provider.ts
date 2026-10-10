// bb machine provider backed by Boat sandboxes. Resource operations only: core
// owns enrollment (bootstrap), checkout setup, retries and the machine record.
import { z } from "zod";
import type { MachineBootstrapApi, MachineExecutor } from "@get-bb/plugin-sdk";

/** Same shape as the SDK's (unexported) Progress. */
export interface Progress {
  step(text: string): void;
  log(text: string): void;
}
import { BoatApi, BoatApiError, canonicalCode, type Box, type BoxSource, type CreateBoxRequest, LIVE_STATES, STOPPED_STATES, STOPPING_STATES } from "./boat-api.ts";
import { CONVERSION_TIMEOUT_MS, parseConversionResult, runnerConversionCommand } from "./conversion.ts";
import { type AgentEnvResult, agentEnvScript, parseAgentEnv, parseSkillStoreCleanup, parseTmpCleanup, skillStoreCleanupScript } from "./boxprep.ts";
import { BEFORE_STOP, DEFER_ACTIONS, describeBlockers, type EnvBlocker, type EnvGuardOptions, type EnvLite, envBlockers, recoveryHint } from "./envguard.ts";
import { DEFAULT_RENAME_GATE, parseRenameProbe, renameGateStep, renameProbeCleanupScript, renameProbeScript } from "./fsgate.ts";
import {
  cloneWaitDecision,
  type Project,
  type ProjectLite,
  parseRepoProbe,
  planSources,
  REPOS_DIR,
  type RepoState,
  repoProbeScript,
  type SourceAction,
  writeManifestScript,
} from "./projects.ts";
import { hubGateDecision, hubGateScript, parseHubGate, parseHubUrl } from "./hubgate.ts";
import { BoatExecutor } from "./executor.ts";
import {
  runnerBoxName,
  DEFAULT_SETTLE,
  identityGuardScript,
  idempotencyKey,
  machineName,
  parseSettleProbe,
  restoreProblem,
  SETTLE_PROBE_SCRIPT,
  type SettleOptions,
  type SettleSample,
  settleDecision,
  unstartedBootUnits,
} from "./policy.ts";

export const PROVIDER_ID = "boat";

/** Replay answers that mean "try again later", not "nothing was created". */
const RETRYABLE_REPLAY_CODES = new Set(["idempotency_in_progress", "rate_limited", "daily_limit_reached", "idempotency_key_reused"]);

/** Persisted by core and readable by every plugin: ids and names only, never secrets. */
export const resourceSchema = z.object({
  boxId: z.string(),
  key: z.string(),
  /** bb repo path → dirty file names recorded at suspend; resume settles back to this. */
  dirtyAtSuspend: z.record(z.string(), z.array(z.string())).default({}),
  /** T18: multi-repo project provisioned on this runner (box named proj-<project>). */
  project: z.string().nullable().default(null),
});
/** Input form (fields with schema defaults may be absent, e.g. resources stored before T18). */
export type BoatResource = z.input<typeof resourceSchema>;

/** Machine inputs: non-secret overrides of the plugin settings. */
export const inputsSchema = z
  .object({
    source: z.enum(["snapshot", "fork"]).optional(),
    from: z.string().min(1).optional(),
    type: z.enum(["small", "default", "large", "xlarge"]).optional(),
    /** T18: provision this project's repos (one of the plugin's `projects` setting). */
    project: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/).optional(),
  })
  .strict();
export type BoatInputs = z.infer<typeof inputsSchema>;

export interface ProviderConfig {
  apiKey: string;
  org: string;
  source: "snapshot" | "fork";
  /** Named snapshot (source=snapshot) or box id (source=fork). */
  from: string;
  type: string;
  ttlSeconds: number;
  /** Wait (≤15 min) for the base's agents-update marker before bootstrap. Default false. */
  waitForAgentUpdates?: boolean;
  /** T13 filesystem gate: consecutive rename successes required (default 6). */
  renameProbeOk?: number;
  /** T13 filesystem gate bound (default 20 min). */
  renameProbeTimeoutMs?: number;
  /** T18: create a bb project for a cloned repo no bb project matches (default false). */
  createMissingProjects?: boolean;
}

export interface ProviderDeps {
  config(): Promise<ProviderConfig | { error: string }>;
  api(config: ProviderConfig): BoatApi;
  bootstrap: MachineBootstrapApi["bootstrap"];
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  settle?: SettleOptions;
  /** Poll interval while waiting for Boat state changes and settling. */
  pollMs?: number;
  /** Upper bound for create/resume/stop to reach the target state. */
  stateTimeoutMs?: number;
  /**
   * Allocation intents keyed by bb's creation key (plugin storage). Boat ignores
   * the box name on fork (seen live 2026-10-04), so cleanup can't find a box by
   * name: it replays the recorded request with the same Idempotency-Key instead.
   */
  intents: IntentStore;
  /** Step log for remove/cleanup/rename (ids, statuses, reasons; never secrets). */
  log?: (message: string) => void;
  /** Overall bound for one remove/cleanup (default 3 min). */
  removeMaxMs?: number;
  /** Start boot units Boat hasn't started after this long (default 2 min). */
  bootKickAfterMs?: number;
  /** Bound for waiting on / watching the agents-update marker (default 15 min). */
  agentUpdatesMaxMs?: number;
  /** Called once the agents-update marker line is seen (log it, keep it for the page). */
  onAgentUpdates?: (boxId: string, line: string) => void;
  /** Aborted on plugin dispose; stops background watchers. */
  backgroundSignal?: AbortSignal;
  /** Environments on a host (SDK environments.list({hostId})); T14 guard. */
  listHostEnvironments?: (hostId: string) => Promise<EnvLite[]>;
  /** T14 wait before stopping/deleting the box (default 3 min, 10 s polls). */
  envWaitMaxMs?: number;
  envWaitIntervalMs?: number;
  /** Rename probe spacing (default 10 s). */
  renameProbeIntervalMs?: number;
  /** T18: plugin-owned project definitions (Boat page → Projects). */
  getProject?: (name: string) => Promise<Project | null>;
  /** T18 project sources (SDK projects.list / projects.sources.add / projects.create). */
  listProjects?: () => Promise<ProjectLite[]>;
  addProjectSource?: (a: { projectId: string; hostId: string; path: string }) => Promise<void>;
  createProject?: (a: { name: string; hostId: string; path: string }) => Promise<{ id: string }>;
  /** T18 clone wait bound (default 10 min) and poll interval (default 10 s). */
  cloneWaitMaxMs?: number;
  cloneWaitIntervalMs?: number;
  /** Starting + active threads on a host (bb server count); gates daemon restarts after enrollment. */
  countBusyThreads?: (hostId: string) => Promise<number>;
  /**
   * The URL bb gives machines for the hub (SDK: system.config().serverAccess.effectiveUrl).
   * Used by the hub gate before every bootstrap. null = bb has none configured.
   */
  hubUrl?: () => Promise<string | null>;
  /** Hub gate bound (default 6 min) and interval (default 10 s). */
  hubGateMaxMs?: number;
  hubGateIntervalMs?: number;
  /**
   * Reset a host's idle clock. Called when resume completes so the lifecycle sweep
   * does not see the pre-suspend lastActive and suspend the box at once (T19).
   */
  markActive?: (hostId: string) => Promise<void>;
}

/** Exactly what create sent to Boat, so a replay is byte-identical. Non-secret. */
export interface AllocationIntent {
  request: CreateBoxRequest;
  boxId: string | null;
}

export interface IntentStore {
  get(key: string): Promise<AllocationIntent | undefined>;
  set(key: string, intent: AllocationIntent): Promise<void>;
  delete(key: string): Promise<void>;
}

export function resolveSource(config: ProviderConfig, inputs: BoatInputs | null): BoxSource {
  const kind = inputs?.source ?? config.source;
  const from = inputs?.from ?? config.from;
  if (!from) throw new Error("No Boat source configured: set the plugin's `from` setting (named snapshot or box id).");
  return kind === "fork" ? { kind: "fork", boxId: from } : { kind: "snapshot", from };
}

async function runScript(executor: MachineExecutor, script: string, signal: AbortSignal, timeoutMs = 120_000) {
  let out = "";
  const { exitCode } = await executor.exec({
    command: ["sh", "-c", script],
    stdin: "",
    timeoutMs,
    signal,
    onOutput: (chunk) => {
      out += chunk;
    },
  });
  return { exitCode, out };
}

export class BoatMachineOps {
  private readonly pollMs: number;
  private readonly stateTimeoutMs: number;
  private readonly settleOpts: SettleOptions;

  private readonly deps: ProviderDeps;

  constructor(deps: ProviderDeps) {
    this.deps = deps;
    this.pollMs = deps.pollMs ?? 5_000;
    this.stateTimeoutMs = deps.stateTimeoutMs ?? 15 * 60_000;
    this.settleOpts = deps.settle ?? DEFAULT_SETTLE;
  }

  async configured(): Promise<{ config: ProviderConfig; api: BoatApi }> {
    const config = await this.deps.config();
    if ("error" in config) throw new Error(config.error);
    return { config, api: this.deps.api(config) };
  }

  async waitForState(api: BoatApi, boxId: string, want: Set<string>, signal: AbortSignal): Promise<Box> {
    const start = this.deps.now();
    for (;;) {
      const box = await api.getBox(boxId, signal);
      if (!box) throw new Error(`Boat box ${boxId} no longer exists`);
      if (want.has(box.state)) return box;
      if (box.state === "error") throw new Error(`Boat box ${boxId} is in state error`);
      if (this.deps.now() - start > this.stateTimeoutMs) {
        throw new Error(`Boat box ${boxId} stayed ${box.state} for ${Math.round(this.stateTimeoutMs / 60_000)} min`);
      }
      await this.deps.sleep(this.pollMs, signal);
    }
  }

  /** T2 rule: wait for reboot semantics + runner-ensure, then for bb repos to stop changing. */
  async settle(
    executor: MachineExecutor,
    report: Progress,
    signal: AbortSignal,
    expectedDirty: Record<string, string[]>,
    reposToo: boolean,
  ): Promise<SettleSample> {
    const start = this.deps.now();
    // T9, first condition: Boat accepts commands. While its lazy restore runs, the
    // commands API answers 502 box_direct_failed "box_restoring" even though the box
    // state is already idle; the executor retries exactly those refusals.
    await executor.exec({ command: ["true"], stdin: "", timeoutMs: 30_000, signal, onOutput: () => {} });
    const acceptedAfter = Math.round((this.deps.now() - start) / 1000);
    report.log(`Boat accepts commands on the box (restore signal) after ${acceptedAfter} s`);
    this.log(`settle: commands accepted after ${acceptedAfter} s`);
    const kickAfterMs = this.deps.bootKickAfterMs ?? 120_000;
    const samples: SettleSample[] = [];
    let lastReason = "";
    let kicked = false;
    for (;;) {
      const { out } = await runScript(executor, SETTLE_PROBE_SCRIPT, signal);
      const sample = parseSettleProbe(out, this.deps.now());
      if (!reposToo) sample.repos = {};
      samples.push(sample);
      const d = settleDecision(samples, start, this.settleOpts, reposToo ? expectedDirty : {});
      if (d.status === "settled") return sample;
      if (d.status === "failed") throw new Error(`Box setup failed: ${d.reason}`);
      if (d.status === "timeout") throw new Error(`Box did not settle: ${d.reason}`);
      // T8: Boat sometimes never starts the snapshot's boot units (base fork
      // one fork: none started 40 min after ready). After ~2 min, start them.
      const unstarted = unstartedBootUnits(sample);
      if (!kicked && unstarted.length > 0 && this.deps.now() - start >= kickAfterMs) {
        kicked = true;
        const units = unstarted.map((u) => `${u}.service`);
        report.step(`Boat had not started ${units.join(", ")} ${Math.round((this.deps.now() - start) / 1000)} s after ready; starting them`);
        this.log(`settle: starting ${units.join(" ")} (Boat did not)`);
        const res = await executor.exec({
          command: ["sudo", "-n", "systemctl", "start", "--no-block", ...units],
          stdin: "",
          timeoutMs: 60_000,
          signal,
          onOutput: () => {},
        });
        if (res.exitCode !== 0) throw new Error(`Box setup failed: could not start ${units.join(", ")} (sudo -n systemctl exit ${res.exitCode})`);
      }
      if (d.reason !== lastReason) report.step(`Waiting for the box to settle: ${d.reason}`);
      lastReason = d.reason;
      await this.deps.sleep(this.pollMs, signal);
    }
  }

  /**
   * T8: the base's agents-update writes `<time> pi=ok codex=ok …` ~8–10 min after
   * ready. Never blocks by default: report the line if already there, otherwise
   * watch for it in the background and hand it to onAgentUpdates. With
   * waitForAgentUpdates, wait for it (bounded) before bootstrap.
   */
  async agentUpdates(
    api: BoatApi,
    executor: MachineExecutor,
    boxId: string,
    sample: SettleSample,
    wait: boolean,
    report: Progress,
    signal: AbortSignal,
  ): Promise<boolean> {
    void api;
    if (sample.agentsMarker) {
      report.log(`Agent updates: ${sample.agentsMarker}`);
      this.deps.onAgentUpdates?.(boxId, sample.agentsMarker);
      return true;
    }
    if (wait) {
      const start = this.deps.now();
      const maxMs = this.deps.agentUpdatesMaxMs ?? 15 * 60_000;
      report.step("Waiting for agent updates on the box (waitForAgentUpdates is on; up to 15 min)");
      while (this.deps.now() - start < maxMs) {
        await this.deps.sleep(Math.max(this.pollMs, 30_000), signal);
        const marker = parseSettleProbe((await runScript(executor, SETTLE_PROBE_SCRIPT, signal)).out, this.deps.now()).agentsMarker;
        if (marker) {
          report.log(`Agent updates: ${marker}`);
          this.deps.onAgentUpdates?.(boxId, marker);
          return true;
        }
      }
      report.log(`Agent updates not finished after ${Math.round(maxMs / 60_000)} min; continuing (agents keep their previous versions)`);
      this.log(`agents ${boxId}: no agents-update marker after ${Math.round(maxMs / 60_000)} min`);
      return false;
    }
    report.log("Agent updates still running on the box (done ~8–10 min after ready); agents use their previous versions meanwhile");
    return false;
  }

  /**
   * T12, right before bootstrap (after the hub gate): clear empty skill-store
   * entries, then (re)generate the daemon's agent env and its drop-in. Restarting a
   * running daemon is allowed here: during create/resume no thread can be running.
   */
  async prepareForBootstrap(executor: MachineExecutor, report: Progress, signal: AbortSignal): Promise<AgentEnvResult> {
    const clean = await runScript(executor, skillStoreCleanupScript(), signal);
    const cleaned = parseSkillStoreCleanup(clean.out);
    if (cleaned > 0) {
      report.log(`Removed ${cleaned} empty skill-store entr${cleaned === 1 ? "y" : "ies"} left by a failed skill pull`);
      this.log(`prep: removed ${cleaned} empty skill-store dir(s)`);
    }
    const tmps = parseTmpCleanup(clean.out);
    if (tmps > 0) {
      report.log(`Removed ${tmps} half-installed skill tree${tmps === 1 ? "" : "s"} (.tmp-*) left by a failed rename`);
      this.log(`prep: removed ${tmps} skill-store .tmp-* leftover(s)`);
    }
    report.step("Giving the bb daemon the box's provider credentials (agent env)");
    let out = "";
    const { exitCode } = await executor.exec({
      command: ["sudo", "-n", "bash", "-c", agentEnvScript(true)],
      stdin: "",
      timeoutMs: 120_000,
      signal,
      onOutput: (c) => {
        out += c;
      },
    });
    const env = parseAgentEnv(out, exitCode);
    if (!env.ok) throw new Error(`Agent env setup failed: ${env.reason}`);
    const summary = `agent env: ${env.vars} vars, Claude token ${env.claude ? "present" : "MISSING"}, provider keys file ${env.bws ? "present" : "not yet (pi-boot-init still running)"}${env.restarted ? `, restarted ${env.restarted} daemon unit(s)` : ""}`;
    report.log(summary);
    this.log(`prep: ${summary}`);
    return env;
  }

  /**
   * Background, after bootstrap (needs the host id): watch for the agents-update
   * marker and for bws-providers.sh appearing later (pi-boot-init can run for
   * minutes). When the agent env content changes, restart the daemon only if bb
   * counts no starting/active thread on the host; otherwise retry next minute.
   * Every 60 s, up to 15 min; never throws; stops on plugin dispose.
   */
  startAfterEnrollWatch(api: BoatApi, boxId: string, hostId: string, state: { markerSeen: boolean; envSettled: boolean }): void {
    if (!this.deps.backgroundSignal) return; // only with an owner that can stop it
    if (state.markerSeen && state.envSettled) return;
    void this.watchAfterEnroll(api, boxId, hostId, state);
  }

  async watchAfterEnroll(api: BoatApi, boxId: string, hostId: string, state: { markerSeen: boolean; envSettled: boolean }): Promise<void> {
    const signal = this.deps.backgroundSignal;
    if (!signal) return;
    const executor = this.executorFor(api, boxId);
    const start = this.deps.now();
    const maxMs = this.deps.agentUpdatesMaxMs ?? 15 * 60_000;
    let { markerSeen, envSettled } = state;
    try {
      while (this.deps.now() - start < maxMs && !signal.aborted && !(markerSeen && envSettled)) {
        await this.deps.sleep(60_000, signal);
        if (!markerSeen) {
          const marker = parseSettleProbe((await runScript(executor, SETTLE_PROBE_SCRIPT, signal)).out, this.deps.now()).agentsMarker;
          if (marker) {
            markerSeen = true;
            this.log(`agents ${boxId}: ${marker}`);
            this.deps.onAgentUpdates?.(boxId, marker);
          }
        }
        if (!envSettled) envSettled = await this.refreshAgentEnv(executor, boxId, hostId, signal);
        // T13: if a thread start already hit EIO/ENOENT in the skill store, clearing the
        // leftovers lets the next start pull again (run 6). Only old .tmp-* trees here.
        const clean = await runScript(executor, skillStoreCleanupScript(10), signal);
        const [n, t] = [parseSkillStoreCleanup(clean.out), parseTmpCleanup(clean.out)];
        if (n + t > 0) this.log(`skill store ${boxId}: removed ${n} empty entr${n === 1 ? "y" : "ies"} and ${t} stale .tmp-* tree(s); the next thread start pulls again`);
      }
      if (!signal.aborted && !markerSeen) this.log(`agents ${boxId}: no agents-update marker after ${Math.round(maxMs / 60_000)} min`);
      if (!signal.aborted && !envSettled) this.log(`agent env ${boxId}: provider keys file still missing or restart still deferred after ${Math.round(maxMs / 60_000)} min`);
    } catch (err) {
      if (!signal.aborted) this.log(`watch ${boxId} stopped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** One refresh: regenerate without restarting; restart only if changed and the host is idle. Returns "settled". */
  async refreshAgentEnv(executor: MachineExecutor, boxId: string, hostId: string, signal: AbortSignal): Promise<boolean> {
    const run = async (restart: boolean) => {
      let out = "";
      const { exitCode } = await executor.exec({
        command: ["sudo", "-n", "bash", "-c", agentEnvScript(restart)],
        stdin: "",
        timeoutMs: 120_000,
        signal,
        onOutput: (c) => {
          out += c;
        },
      });
      return parseAgentEnv(out, exitCode);
    };
    const env = await run(false);
    if (!env.ok) {
      this.log(`agent env ${boxId}: refresh failed: ${env.reason}`);
      return false;
    }
    if (env.changed) {
      const busy = this.deps.countBusyThreads ? await this.deps.countBusyThreads(hostId) : null;
      if (busy !== 0) {
        this.log(`agent env ${boxId}: changed (${env.vars} vars); daemon restart deferred (${busy === null ? "thread count unavailable" : `${busy} thread(s) running`})`);
        return false;
      }
      // T14: a daemon restart in the middle of an environment hook leaves its outcome
      // unknown and blocks core's cleanup. Never restart while one may be running.
      const blockers = await this.envBlockersFor(hostId, DEFER_ACTIONS);
      if (blockers === null || blockers.length > 0) {
        this.log(
          `agent env ${boxId}: changed (${env.vars} vars); daemon restart deferred (${blockers === null ? "environment list unavailable" : `environment teardown running: ${describeBlockers(blockers)}`})`,
        );
        return false;
      }
      const applied = await run(true);
      this.log(`agent env ${boxId}: changed (${applied.vars} vars, provider keys file ${applied.bws ? "present" : "missing"}); restarted ${applied.restarted} daemon unit(s)`);
      return applied.ok && applied.bws;
    }
    return env.bws;
  }

  /**
   * Environments on the host that block restarts/stops now. [] when no lister is
   * wired (production always wires one); null when listing failed, which callers
   * treat as "may be busy" (fail safe).
   */
  async envBlockersFor(hostId: string, opts: EnvGuardOptions): Promise<EnvBlocker[] | null> {
    if (!this.deps.listHostEnvironments) return [];
    try {
      return envBlockers(await this.deps.listHostEnvironments(hostId), this.deps.now(), opts);
    } catch (err) {
      this.log(`environment list for ${hostId} failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * T14: before stopping (suspend) or deleting (remove) the box, wait for
   * environments on the host to leave provisioning / teardown (and imminent
   * retirement), so no hook is cut mid-run. Bounded (default 3 min); then proceeds
   * with a warning, as the stop can't wait forever (core already drained threads).
   */
  async waitForEnvironments(hostId: string, report: Progress, signal: AbortSignal, verb: "stopping" | "deleting"): Promise<void> {
    if (!this.deps.listHostEnvironments) return;
    const start = this.deps.now();
    const maxMs = this.deps.envWaitMaxMs ?? 3 * 60_000;
    const interval = this.deps.envWaitIntervalMs ?? 10_000;
    let last = "";
    for (;;) {
      const blockers = await this.envBlockersFor(hostId, BEFORE_STOP);
      if (blockers !== null && blockers.length === 0) {
        if (last) report.log(`Environments on the machine are idle; ${verb} the box`);
        return;
      }
      const what = blockers === null ? "environment list unavailable" : describeBlockers(blockers);
      if (what !== last) {
        report.step(`Waiting for environments on the machine to finish before ${verb} the box: ${what}`);
        this.log(`env wait ${hostId}: ${what}`);
        last = what;
      }
      if (this.deps.now() - start >= maxMs) {
        const hint = blockers ? recoveryHint(blockers) : null;
        const msg = `Environments still busy after ${Math.round(maxMs / 60_000)} min (${what}); ${verb} the box anyway${hint ? `. Afterwards: ${hint}` : ""}`;
        report.log(msg);
        this.log(`env wait ${hostId}: ${msg}`);
        return;
      }
      await this.deps.sleep(interval, signal);
    }
  }

  /**
   * T13 "filesystem settled" gate: while Boat lazily restores /home, directory
   * renames fail with EIO and bb's daemon can't install skill trees. Probe renames
   * on the box until `requiredOk` in a row succeed (10 s apart), bounded.
   */
  async waitForFilesystem(executor: MachineExecutor, report: Progress, signal: AbortSignal, config: ProviderConfig): Promise<void> {
    const opts = {
      requiredOk: config.renameProbeOk ?? DEFAULT_RENAME_GATE.requiredOk,
      timeoutMs: config.renameProbeTimeoutMs ?? DEFAULT_RENAME_GATE.timeoutMs,
    };
    const interval = this.deps.renameProbeIntervalMs ?? 10_000;
    const start = this.deps.now();
    let state = { consecutive: 0, lastKio: null as number | null };
    let lastErr = "";
    let failures = 0;
    let firstKio: number | null = null;
    let lastProbe: ReturnType<typeof parseRenameProbe> | null = null;
    const script = renameProbeScript();
    const kioText = (p: ReturnType<typeof parseRenameProbe>) =>
      p.kio === null ? "kernel I/O errors: unknown" : `kernel I/O errors since boot: ${p.kio}${p.kioVda !== null ? ` (vda ${p.kioVda})` : ""}`;
    for (;;) {
      const r = await runScript(executor, script, signal, 60_000);
      const probe = parseRenameProbe(r.out, r.exitCode);
      lastProbe = probe;
      if (firstKio === null) firstKio = probe.kio;
      const step = renameGateStep(state, probe, opts);
      state = { consecutive: step.consecutive, lastKio: step.lastKio };
      if (!probe.ok || step.kioGrew) {
        failures++;
        const label = !probe.ok ? `${probe.err} at ${probe.step} in ${probe.where}` : "kernel I/O errors still increasing";
        if (label !== lastErr) {
          report.step(
            !probe.ok
              ? `Waiting for Boat to finish restoring the disk (directory renames still fail: ${probe.err}; ${kioText(probe)})`
              : `Waiting for Boat to finish restoring the disk (renames work, but ${kioText(probe)} and still increasing)`,
          );
          this.log(`fs gate: ${label}; ${kioText(probe)}`);
          lastErr = label;
        }
      }
      if (step.done) {
        const s = Math.round((this.deps.now() - start) / 1000);
        await runScript(executor, renameProbeCleanupScript(), signal).catch(() => undefined);
        const kio = lastProbe ? kioText(lastProbe) : "kernel I/O errors: unknown";
        report.log(
          `Disk settled: directory renames work in the daemon's ${lastProbe?.where === "runtime" ? "data dir" : "~/.bb-machines"} (${opts.requiredOk} in a row, no new kernel I/O errors) after ${s} s; ${kio}${failures ? `; ${failures} unsettled probe(s) before` : ""}`,
        );
        this.log(`fs gate passed after ${s} s (${failures} unsettled; ${kio}; first sample ${firstKio ?? "unknown"})`);
        return;
      }
      if (this.deps.now() - start >= opts.timeoutMs) {
        await runScript(executor, renameProbeCleanupScript(), signal).catch(() => undefined);
        throw new Error(
          `Boat is still restoring the disk after ${Math.round(opts.timeoutMs / 60_000)} min: ${lastErr ? `last problem: ${lastErr}` : `renames did not succeed ${opts.requiredOk} times in a row`}${lastProbe ? `; ${kioText(lastProbe)}` : ""}; bb can't install skill trees until this settles`,
        );
      }
      await this.deps.sleep(interval, signal);
    }
  }

  /**
   * T11 hard gate before bootstrap: Tailscale Running, hub name resolves, hub
   * /health answers 2xx, checked on the box every 10 s for up to 6 min. Fails
   * naming the check that never passed.
   */
  async waitForHub(executor: MachineExecutor, report: Progress, signal: AbortSignal): Promise<void> {
    if (!this.deps.hubUrl) {
      this.log("hub gate skipped: no hub URL source wired");
      return;
    }
    const url = await this.deps.hubUrl();
    if (!url) {
      throw new Error("bb has no machine server URL, so boxes can't enroll (Settings → Machines, or `bb settings general machineServerUrl`)");
    }
    const target = parseHubUrl(url);
    const script = hubGateScript(target);
    const start = this.deps.now();
    const maxMs = this.deps.hubGateMaxMs ?? 6 * 60_000;
    const interval = this.deps.hubGateIntervalMs ?? 10_000;
    report.step(`Waiting for the box to reach the bb hub over Tailscale (${target.host})`);
    let last = "";
    for (;;) {
      const { out } = await runScript(executor, script, signal, 60_000);
      const d = hubGateDecision(parseHubGate(out), target);
      if (d.ok) {
        const s = Math.round((this.deps.now() - start) / 1000);
        report.log(`The box reaches the bb hub (Tailscale up, ${target.host} resolves, /health ok) after ${s} s`);
        this.log(`hub gate passed after ${s} s`);
        return;
      }
      if (d.message !== last) {
        report.step(`Waiting for the box to reach the bb hub over Tailscale: ${d.message}`);
        last = d.message;
      }
      if (this.deps.now() - start >= maxMs) {
        throw new Error(`The box can't reach the bb hub after ${Math.round(maxMs / 60_000)} min: ${d.message} [check: ${d.check}]`);
      }
      await this.deps.sleep(interval, signal);
    }
  }

  /**
   * Executor for a box with the T9 "not ready yet" retry wired to this provider's
   * clock. Progress says what is happening: first refusal, then at most once a minute.
   */
  executorFor(api: BoatApi, boxId: string, report?: Progress): BoatExecutor {
    let lastReport = -Infinity;
    const describe: Record<string, string> = {
      box_restoring: "Boat is still restoring the disk (commands refused: box_restoring)",
      box_starting: "Boat is still starting the box (box_starting)",
      machine_not_running: "Boat says the machine is not running yet",
    };
    return new BoatExecutor(api, boxId, {
      now: () => this.deps.now(),
      sleep: (ms, signal) => this.deps.sleep(ms, signal),
      maxWaitMs: this.settleOpts.timeoutMs,
      onNotReady: (reason, waited) => {
        if (waited - lastReport < 60_000) return;
        lastReport = waited;
        const text = `${describe[reason] ?? reason}; retrying every 10 s (${Math.round(waited / 1000)} s so far)`;
        report?.step(text);
        this.log(`${boxId}: ${text}`);
      },
    });
  }

  /** T6 runner conversion (src/conversion.ts) as root; throws with the script's reason. */
  async convert(executor: MachineExecutor, report: Progress, signal: AbortSignal): Promise<void> {
    report.step("Converting the box to a bb runner (own bb server off, runner-ensure on)");
    let out = "";
    const { exitCode } = await executor.exec({
      command: runnerConversionCommand(),
      stdin: "",
      timeoutMs: CONVERSION_TIMEOUT_MS,
      signal,
      onOutput: (chunk) => {
        out += chunk;
      },
    });
    const result = parseConversionResult(out, exitCode);
    if (!result.ok) throw new Error(`Runner conversion failed: ${result.reason}`);
    report.log(result.summary);
  }

  async create(
    key: string,
    inputs: BoatInputs | null,
    checkpoint: (r: BoatResource) => Promise<void>,
    report: Progress,
    signal: AbortSignal,
  ): Promise<{ hostId: string; name: string; resource: BoatResource }> {
    const { config, api } = await this.configured();
    const source = resolveSource(config, inputs);
    let projectDef: Project | null = null;
    if (inputs?.project) {
      projectDef = this.deps.getProject ? await this.deps.getProject(inputs.project) : null;
      if (!projectDef) throw new Error(`Unknown project "${inputs.project}" (Boat page → Projects lists the defined ones)`);
      if (projectDef.repos.length === 0) throw new Error(`Project "${projectDef.name}" has no repos yet (Boat page → Projects)`);
    }
    const project = projectDef?.name ?? null;
    report.step(source.kind === "fork" ? `Forking Boat box ${source.boxId}` : `Creating a Boat box from ${source.from}`);
    // No name in the body: Boat ignores it on fork (live 2026-10-04); we rename after.
    const request: CreateBoxRequest = {
      source,
      org: config.org,
      ttlSeconds: config.ttlSeconds,
      type: inputs?.type ?? config.type,
      idempotencyKey: idempotencyKey(key),
    };
    // Record the intent BEFORE calling Boat: if we crash between Boat's answer and
    // the checkpoint, reconcileCleanup replays this exact request to find the box.
    const prior = await this.deps.intents.get(key);
    await this.deps.intents.set(key, { request: prior?.request ?? request, boxId: prior?.boxId ?? null });
    const created = await api.createBox(prior?.request ?? request, signal);
    await this.deps.intents.set(key, { request: prior?.request ?? request, boxId: created.id });
    // The base box is never touched: everything below runs on the new box only.
    if (source.kind === "fork" && created.id === source.boxId) {
      throw new Error(`Boat returned the source box ${created.id} instead of a fork; refusing to convert it`);
    }
    const box = created;
    const resource: BoatResource = { boxId: box.id, key, dirtyAtSuspend: {}, project };
    await checkpoint(resource);
    await this.rename(api, box.id, key, signal);
    report.step(`Waiting for ${box.id} to be ready`);
    const live = await this.waitForState(api, box.id, LIVE_STATES, signal);
    const problem = restoreProblem(live.error);
    if (problem) throw new Error(problem);
    const executor = this.executorFor(api, box.id, report);
    // Copied checkouts are wiped with the identity, so only wait for Boat's unit
    // start (reboot semantics) and runner-ensure if the source already had it.
    const settled = await this.settle(executor, report, signal, {}, false);
    await this.convert(executor, report, signal);
    const markerSeen = await this.agentUpdates(api, executor, box.id, settled, config.waitForAgentUpdates ?? false, report, signal);
    const guard = await runScript(executor, identityGuardScript(box.id), signal);
    if (guard.exitCode !== 0) throw new Error("identity guard failed on the box");
    report.log(guard.out.includes("identity=wiped") ? "Removed a runner identity copied from the source box" : "No copied runner identity");
    await this.waitForFilesystem(executor, report, signal, config);
    await this.waitForHub(executor, report, signal);
    const env = await this.prepareForBootstrap(executor, report, signal);
    const { hostId } = await this.deps.bootstrap({ key, executor, report, signal });
    if (projectDef) {
      // Before returning `created`: core's thread launch waits while the machine is
      // `creating` and only then checks for a project source on it (T18, DESIGN.md).
      await this.provisionProject(executor, box.id, hostId, projectDef, config, report, signal);
    }
    this.startAfterEnrollWatch(api, box.id, hostId, { markerSeen, envSettled: env.bws });
    return { hostId, name: machineName(box.id), resource };
  }

  async suspend(
    resource: BoatResource,
    checkpoint: (r: BoatResource) => Promise<void>,
    report: Progress,
    signal: AbortSignal,
    hostId?: string,
  ): Promise<BoatResource> {
    const { api } = await this.configured();
    const box = await api.getBox(resource.boxId, signal);
    if (!box) throw new Error(`Boat box ${resource.boxId} is gone; its saved state is lost`);
    let next = resource;
    if (LIVE_STATES.has(box.state)) {
      if (hostId) await this.waitForEnvironments(hostId, report, signal, "stopping");
      // Record what is legitimately dirty, so resume can tell it from restore noise.
      const { out } = await runScript(this.executorFor(api, box.id), SETTLE_PROBE_SCRIPT, signal);
      next = { ...resource, dirtyAtSuspend: parseSettleProbe(out, this.deps.now()).repos };
      await checkpoint(next);
      report.step(`Stopping ${box.id} (Boat snapshots the disk first)`);
      await api.stop(box.id, signal);
    }
    const stopped = await this.waitForState(api, box.id, STOPPED_STATES, signal);
    if (stopped.lastSnapshotStatus && stopped.lastSnapshotStatus !== "completed") {
      throw new Error(`Boat snapshot for ${box.id} is ${stopped.lastSnapshotStatus}`);
    }
    return next;
  }

  async resume(
    hostId: string,
    resource: BoatResource,
    checkpoint: (r: BoatResource) => Promise<void>,
    report: Progress,
    signal: AbortSignal,
  ): Promise<BoatResource> {
    const { config, api } = await this.configured();
    const box = await api.getBox(resource.boxId, signal);
    if (!box) throw new Error(`Boat box ${resource.boxId} is gone; it cannot be resumed`);
    let state = box.state;
    if (STOPPING_STATES.has(state)) {
      // POST /resume during a stop is expected to 409; let the snapshot finish first.
      report.step(`Waiting for ${box.id} to finish stopping`);
      state = (await this.waitForState(api, box.id, STOPPED_STATES, signal)).state;
    }
    if (STOPPED_STATES.has(state)) {
      report.step(`Resuming ${box.id}`);
      await api.resume(box.id, config.ttlSeconds, signal);
    }
    // Otherwise it is live or already starting (provisioning/resuming/cloning): just wait.
    const live = await this.waitForState(api, box.id, LIVE_STATES, signal);
    await checkpoint(resource);
    const problem = restoreProblem(live.error);
    if (problem) throw new Error(problem);
    const executor = this.executorFor(api, box.id, report);
    const settled = await this.settle(executor, report, signal, resource.dirtyAtSuspend ?? {}, true);
    // Idempotent re-check: restores have lost files before (T2), and agents-update
    // restarts bb-app. Cheap insurance that the box's own bb server stays off.
    await this.convert(executor, report, signal);
    const markerSeen = await this.agentUpdates(api, executor, box.id, settled, config.waitForAgentUpdates ?? false, report, signal);
    const guard = await runScript(executor, identityGuardScript(box.id), signal);
    if (guard.exitCode !== 0 || !guard.out.includes("identity=kept")) {
      throw new Error(`runner identity on ${box.id} does not belong to it; refusing to restart ${hostId}`);
    }
    await this.waitForFilesystem(executor, report, signal, config);
    await this.waitForHub(executor, report, signal);
    const env = await this.prepareForBootstrap(executor, report, signal);
    await this.deps.bootstrap({ key: resource.key, executor, report, signal });
    if (resource.project) {
      // Nothing to clone again (the sync would also delete repos dropped from the
      // manifest); verify what is on the box and re-register missing sources.
      await this.verifyProject(executor, box.id, hostId, resource.project, config, report, signal);
    }
    this.startAfterEnrollWatch(api, box.id, hostId, { markerSeen, envSettled: env.bws });
    // T19: reset the idle clock now that resume is done, or the sweep sees the
    // pre-suspend lastActive and suspends the box on its next tick.
    await this.deps.markActive?.(hostId);
    return resource;
  }

  /**
   * T18 create step (after enrollment, before `created`): write the project's
   * manifest to ~/.project-repos.txt, start the base's sync
   * (project-repos.service → project-repos-sync.sh), wait for every repo's clone,
   * then register them as bb project sources on this host.
   */
  async provisionProject(
    executor: MachineExecutor,
    boxId: string,
    hostId: string,
    project: Project,
    config: ProviderConfig,
    report: Progress,
    signal: AbortSignal,
  ): Promise<void> {
    report.step(`Provisioning project ${project.name}: writing ~/.project-repos.txt (${project.repos.length} repos)`);
    const w = await runScript(executor, writeManifestScript(project), signal);
    if (w.exitCode !== 0 || !/manifest-written=\d+/.test(w.out)) throw new Error(`Could not write ~/.project-repos.txt on ${boxId} (exit ${w.exitCode})`);
    const r = await executor.exec({
      command: ["sudo", "-n", "systemctl", "start", "--no-block", "project-repos.service"],
      stdin: "",
      timeoutMs: 60_000,
      signal,
      onOutput: () => {},
    });
    if (r.exitCode !== 0) throw new Error(`Could not start project-repos.service (sudo -n systemctl exit ${r.exitCode})`);
    this.log(`project ${boxId}: manifest for ${project.name} written; project-repos.service started`);
    const t0 = this.deps.now();
    const maxMs = this.deps.cloneWaitMaxMs ?? 10 * 60_000;
    const interval = this.deps.cloneWaitIntervalMs ?? 10_000;
    let lastProgress = "";
    for (;;) {
      const probe = parseRepoProbe((await runScript(executor, repoProbeScript(), signal)).out);
      const d = cloneWaitDecision(probe, project, this.deps.now() - t0, maxMs);
      if (d.status === "done") {
        report.log(`${project.name}: ${d.repos.length} repo(s) cloned under ${REPOS_DIR}: ${d.repos.map((x) => x.name).join(", ")}`);
        await this.registerProjectSources(d.repos, hostId, config, report);
        return;
      }
      if (d.status === "timeout") throw new Error(`Cloning ${project.name} repos did not finish in ${Math.round(maxMs / 60_000)} min: ${d.reason}`);
      if (d.progress !== lastProgress) {
        report.step(d.progress);
        lastProgress = d.progress;
      }
      await this.deps.sleep(interval, signal);
    }
  }

  /** T18 resume: no clone; the manifest on the box is the truth. Re-register sources. */
  async verifyProject(executor: MachineExecutor, boxId: string, hostId: string, projectName: string, config: ProviderConfig, report: Progress, signal: AbortSignal): Promise<void> {
    const probe = parseRepoProbe((await runScript(executor, repoProbeScript(), signal)).out);
    const missing = probe.repos.filter((x) => !x.cloned).map((x) => x.name);
    if (!probe.manifest) throw new Error(`Project ${projectName}: ~/.project-repos.txt is missing on ${boxId} after resume`);
    if (missing.length > 0) throw new Error(`Project ${projectName}: repos missing on ${boxId} after resume: ${missing.join(", ")}`);
    report.log(`${projectName}: ${probe.repos.length} repo(s) present after resume`);
    await this.registerProjectSources(probe.repos, hostId, config, report);
  }

  /** T18: one bb project source per cloned repo on this host (no clone). */
  async registerProjectSources(repos: RepoState[], hostId: string, config: ProviderConfig, report: Progress): Promise<SourceAction[]> {
    if (!this.deps.listProjects || !this.deps.addProjectSource) {
      report.log("bb project sources: not available in this build; repos are on the box but not registered");
      return [];
    }
    const plan = planSources(repos, await this.deps.listProjects(), hostId, config.createMissingProjects ?? false);
    for (const a of plan) {
      switch (a.kind) {
        case "add":
          await this.deps.addProjectSource({ projectId: a.projectId, hostId, path: a.path });
          report.log(`bb project ${a.projectName}: source added on this machine at ${a.path}`);
          break;
        case "present":
          report.log(`bb project ${a.projectName}: already has a source on this machine (${a.path})`);
          break;
        case "create":
          if (this.deps.createProject) {
            const p = await this.deps.createProject({ name: a.repo, hostId, path: a.path });
            report.log(`bb project ${a.repo} created (${p.id}) from ${a.path}`);
          }
          break;
        case "unmatched":
          report.log(`repo ${a.repo}: no bb project with remote ${a.url}; left unregistered (setting createMissingProjects creates one)`);
          break;
        case "ambiguous":
          report.log(`repo ${a.repo}: several bb projects share its remote (${a.projectNames.join(", ")}); left unregistered`);
          break;
      }
    }
    this.log(`project sources on ${hostId}: ${plan.map((a) => `${a.repo}=${a.kind}`).join(" ")}`);
    return plan;
  }

  /** Best effort: give the fork a recognisable Boat name (PATCH name is documented). */
  async rename(api: BoatApi, boxId: string, key: string, signal: AbortSignal): Promise<void> {
    const name = runnerBoxName(key);
    try {
      await api.setName(boxId, name, signal);
      this.log(`create ${boxId}: renamed to "${name}"`);
    } catch (err) {
      this.log(`create ${boxId}: rename to "${name}" failed (kept Boat's name): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private log(message: string): void {
    this.deps.log?.(message);
  }

  private deleteOpts(signal: AbortSignal) {
    return {
      signal,
      maxMs: this.deps.removeMaxMs ?? 180_000,
      pollMs: this.pollMs,
      now: () => this.deps.now(),
      sleep: (ms: number) => this.deps.sleep(ms, signal),
      log: (m: string) => this.log(m),
    };
  }

  async remove(resource: BoatResource, signal: AbortSignal, hostId?: string, report?: Progress): Promise<void> {
    const { config, api } = await this.configured();
    if (config.source === "fork" && resource.boxId === config.from) {
      throw new Error(`refusing to delete ${resource.boxId}: it is the base box runners are forked from`);
    }
    if (hostId) await this.waitForEnvironments(hostId, report ?? { step() {}, log() {} }, signal, "deleting");
    this.log(`remove ${resource.boxId}: start`);
    await api.deleteBox(resource.boxId, this.deleteOpts(signal));
    await this.deps.intents.delete(resource.key);
    this.log(`remove ${resource.boxId}: done`);
  }

  /**
   * Cleanup of a create that crashed before its checkpoint. Never relies on box
   * names. Order: no recorded intent → nothing was sent → removed. Recorded box id
   * → delete it. Otherwise replay the identical request with the same
   * Idempotency-Key (Boat returns the same box within 24 h; UNVERIFIED live) to
   * learn the id, then delete it. A 4xx on replay means Boat created nothing.
   */
  async reconcileCleanup(key: string, signal: AbortSignal): Promise<void> {
    const { api } = await this.configured();
    const intent = await this.deps.intents.get(key);
    if (!intent) {
      this.log(`cleanup ${key}: no allocation was ever requested; nothing to remove`);
      return;
    }
    let boxId = intent.boxId;
    if (boxId === null) {
      this.log(`cleanup ${key}: box id unknown; replaying the create with the same Idempotency-Key`);
      try {
        boxId = (await api.createBox(intent.request, signal)).id;
        this.log(`cleanup ${key}: replay returned ${boxId}`);
      } catch (err) {
        if (err instanceof BoatApiError && err.status >= 400 && err.status < 500 && !RETRYABLE_REPLAY_CODES.has(canonicalCode(err.code))) {
          this.log(`cleanup ${key}: Boat created nothing (${err.code}); removed`);
          await this.deps.intents.delete(key);
          return;
        }
        this.log(`cleanup ${key}: replay failed, will retry: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    }
    if (intent.request.source.kind === "fork" && boxId === intent.request.source.boxId) {
      throw new Error(`cleanup ${key}: refusing to delete the source box ${boxId}`);
    }
    await api.deleteBox(boxId, this.deleteOpts(signal));
    await this.deps.intents.delete(key);
    this.log(`cleanup ${key}: removed ${boxId}`);
  }
}
