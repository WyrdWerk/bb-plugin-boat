import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { BoatApi } from "../src/boat-api.ts";
import { BEFORE_STOP, DEFER_ACTIONS, describeBlockers, type EnvLite, envBlockers, recoveryHint } from "../src/envguard.ts";
import { lifecycleSweep, type SweepDeps } from "../src/lifecycle.ts";
import { BoatMachineOps } from "../src/provider.ts";
import { memIntents } from "./helpers.ts";

const NOW = 1_000_000_000;
const env = (id: string, status: string, phase: string, extra: Partial<EnvLite["lifecycle"]> = {}): EnvLite => ({
  id,
  status,
  lifecycle: { phase, retireAt: null, teardown: null, ...extra },
});
// The run-9 case: archived worktree environments stuck in teardown (failed, attempt 8).
const STUCK = env("env_wt1", "ready", "teardown", { teardown: { status: "failed", attempt: 8 } });

describe("environment guard rules (T14)", () => {
  it("classifies what blocks a restart / suspend request", () => {
    const envs = [
      env("env_ok", "ready", "active"),
      env("env_gone", "destroyed", "destroyed"),
      env("env_new", "provisioning", "active"),
      env("env_mk", "creating", "active"),
      env("env_td", "ready", "teardown", { teardown: { status: "running", attempt: 1 } }),
      STUCK,
      env("env_ret", "ready", "retiring", { retireAt: NOW + 4 * 60_000 }),
    ];
    assert.deepEqual(envBlockers(envs, NOW, DEFER_ACTIONS), [
      { id: "env_new", reason: "provisioning" },
      { id: "env_mk", reason: "provisioning" },
      { id: "env_td", reason: "teardown running" },
      { id: "env_wt1", reason: "teardown failed" },
      { id: "env_ret", reason: "retiring" },
    ]);
  });
  it("before stopping, only imminent retirements block (retireAt within ~2 min)", () => {
    const later = env("env_later", "ready", "retiring", { retireAt: NOW + 4 * 60_000 });
    const soon = env("env_soon", "ready", "retiring", { retireAt: NOW + 60_000 });
    assert.deepEqual(envBlockers([later, soon], NOW, BEFORE_STOP), [{ id: "env_soon", reason: "retiring" }]);
  });
  it("describes blockers and says there's no supported recovery for failed teardowns", () => {
    const b = envBlockers([STUCK, env("env_new", "provisioning", "active")], NOW, DEFER_ACTIONS);
    assert.equal(describeBlockers(b), "env_wt1 teardown failed, env_new provisioning");
    assert.equal(
      recoveryHint(b),
      "teardown failed for env_wt1: bb has no supported recovery for an interrupted hook (the record stays until bb fixes it); inspect the worktree so no work is lost, and tell the owner",
    );
    assert.ok(!recoveryHint(b)!.includes("bb environment cleanup"), "never suggests the cleanup that doesn't work");
    assert.equal(recoveryHint([{ id: "x", reason: "provisioning" }]), null);
  });
});

describe("agent-env daemon restart is deferred during environment hooks (T14)", () => {
  function ops(envs: () => EnvLite[] | Error) {
    const logs: string[] = [];
    const runs: boolean[] = [];
    const api = {
      writeFile: async () => {},
      runCommand: async (_id: string, cmd: string) => {
        const restart = cmd.includes("[ 1 = 1 ]");
        runs.push(restart);
        return { exitCode: 0, stdout: `agent-env=ok vars=25 hash=2222222222222222 changed=yes restarted=${restart ? 1 : 0} claude=yes bws=yes\n`, stderr: "" };
      },
    } as unknown as BoatApi;
    const o = new BoatMachineOps({
      config: async () => ({ apiKey: "k", org: "o", source: "fork", from: "bx_base0001", type: "default", ttlSeconds: 3600 }),
      api: () => api,
      bootstrap: async () => ({ hostId: "h" }),
      now: () => NOW,
      sleep: async () => {},
      intents: memIntents(),
      log: (m) => void logs.push(m),
      countBusyThreads: async () => 0,
      listHostEnvironments: async () => {
        const r = envs();
        if (r instanceof Error) throw r;
        return r;
      },
    });
    return { o, api, logs, runs };
  }
  const sig = new AbortController().signal;
  it("no thread running but an environment in teardown → no restart, logged", async () => {
    const t = ops(() => [STUCK]);
    const settled = await t.o.refreshAgentEnv(t.o.executorFor(t.api, "bx_r9"), "bx_r9", "host_r9", sig);
    assert.equal(settled, false);
    assert.deepEqual(t.runs, [false], "only the no-restart regeneration ran");
    assert.ok(t.logs.some((l) => l === "agent env bx_r9: changed (25 vars); daemon restart deferred (environment teardown running: env_wt1 teardown failed)"));
  });
  it("environments idle → restart goes ahead", async () => {
    const t = ops(() => [env("env_ok", "ready", "active")]);
    assert.equal(await t.o.refreshAgentEnv(t.o.executorFor(t.api, "bx_r9"), "bx_r9", "host_r9", sig), true);
    assert.deepEqual(t.runs, [false, true]);
  });
  it("environment list fails → deferred (fail safe)", async () => {
    const t = ops(() => new Error("bb unavailable"));
    assert.equal(await t.o.refreshAgentEnv(t.o.executorFor(t.api, "bx_r9"), "bx_r9", "host_r9", sig), false);
    assert.ok(t.logs.some((l) => l.includes("daemon restart deferred (environment list unavailable)")));
  });
});

describe("idle / pre-TTL suspend is deferred during environment hooks (T14)", () => {
  const MIN = 60_000;
  function sweep(envs: EnvLite[], archiveAfter: string | null) {
    const calls: string[] = [];
    const d: SweepDeps = {
      listHosts: async () => [{ id: "host_r9", machineProviderId: "boat", lifecycle: { phase: "active" } }],
      getResource: async () => ({ boxId: "bx_r9", key: "k", dirtyAtSuspend: {} }),
      countBusyThreads: async () => 0,
      getLastActive: async () => NOW - 60 * MIN,
      setLastActive: async () => {},
      getBox: async () => ({ id: "bx_r9", state: "idle", archiveAfter }),
      setTtl: async (id) => void calls.push(`ttl ${id}`),
      suspend: async (h) => void calls.push(`suspend ${h}`),
      listHostEnvironments: async () => envs,
      now: () => NOW,
      warn: () => {},
      info: (m) => void calls.push(`info ${m}`),
    };
    return { d, calls };
  }
  const s = { idleMs: 15 * MIN, preTtlMarginMs: 15 * MIN, ttlSeconds: 14_400 };
  it("idle suspend waits while an archived thread's environment is retiring", async () => {
    const t = sweep([env("env_ret", "ready", "retiring", { retireAt: NOW + 3 * MIN })], null);
    const [r] = await lifecycleSweep(t.d, s);
    assert.equal(r!.deferred, "environment teardown running: env_ret retiring");
    assert.ok(!t.calls.some((c) => c.startsWith("suspend")));
    assert.ok(t.calls.includes("info Idle suspend deferred for host_r9 (environment teardown running: env_ret retiring)"));
  });
  it("pre-TTL suspend deferred → extends Boat's TTL instead (no auto-stop mid-hook)", async () => {
    const t = sweep([STUCK], new Date(NOW + 5 * MIN).toISOString());
    await lifecycleSweep(t.d, s);
    assert.ok(t.calls.includes("ttl bx_r9"));
    assert.ok(!t.calls.some((c) => c.startsWith("suspend")));
  });
  it("no blockers → suspends as before", async () => {
    const t = sweep([env("env_ok", "ready", "active")], null);
    await lifecycleSweep(t.d, s);
    assert.ok(t.calls.includes("suspend host_r9"));
  });
});

describe("suspend and remove wait for environments before stopping the box (T14)", () => {
  function box(envs: (t: number) => EnvLite[]) {
    let t = 0;
    const events: string[] = [];
    const states = { cur: "idle" };
    const api = {
      getBox: async (id: string) => ({ id, state: states.cur, error: null, lastSnapshotStatus: "completed" }),
      stop: async () => (events.push(`stop@${t / 1000}s`), void (states.cur = "archived")),
      deleteBox: async (id: string) => void events.push(`delete ${id}@${t / 1000}s`),
      writeFile: async () => {},
      runCommand: async () => ({ exitCode: 0, stdout: "ensure=no\n", stderr: "" }),
    } as unknown as BoatApi;
    const progress: string[] = [];
    const o = new BoatMachineOps({
      config: async () => ({ apiKey: "k", org: "o", source: "fork", from: "bx_base0001", type: "default", ttlSeconds: 3600 }),
      api: () => api,
      bootstrap: async () => ({ hostId: "h" }),
      now: () => t,
      sleep: async (ms) => void (t += ms),
      intents: memIntents(),
      listHostEnvironments: async () => envs(t),
    });
    const report = { step: (s: string) => void progress.push(`step: ${s}`), log: (s: string) => void progress.push(`log: ${s}`) };
    return { o, events, progress, report };
  }
  const sig = new AbortController().signal;
  const res = { boxId: "bx_r9", key: "k", dirtyAtSuspend: {} };

  it("suspend: waits for a running teardown to finish, then stops", async () => {
    const b = box((t) => (t < 40_000 ? [env("env_td", "ready", "teardown", { teardown: { status: "running", attempt: 1 } })] : []));
    await b.o.suspend(res, async () => {}, b.report, sig, "host_r9");
    assert.deepEqual(b.events, ["stop@40s"]);
    assert.ok(b.progress.includes("step: Waiting for environments on the machine to finish before stopping the box: env_td teardown running"));
    assert.ok(b.progress.includes("log: Environments on the machine are idle; stopping the box"));
  });
  it("remove: a teardown stuck in 'failed' → bounded wait (3 min), then proceeds with a no-recovery warning", async () => {
    const b = box(() => [STUCK]);
    await b.o.remove(res, sig, "host_r9", b.report);
    assert.deepEqual(b.events, ["delete bx_r9@180s"]);
    assert.ok(
      b.progress.includes(
        "log: Environments still busy after 3 min (env_wt1 teardown failed); deleting the box anyway. Afterwards: teardown failed for env_wt1: bb has no supported recovery for an interrupted hook (the record stays until bb fixes it); inspect the worktree so no work is lost, and tell the owner",
      ),
    );
  });
  it("suspend with nothing pending stops at once", async () => {
    const b = box(() => [env("env_ok", "ready", "active")]);
    await b.o.suspend(res, async () => {}, b.report, sig, "host_r9");
    assert.deepEqual(b.events, ["stop@0s"]);
  });
});
