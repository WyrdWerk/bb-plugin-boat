import { strict as assert } from "node:assert";
import { memIntents, withPrep } from "./helpers.ts";
import { describe, it } from "node:test";
import { BoatApi, BoatApiError, type FetchLike } from "../src/boat-api.ts";
import { lifecycleSweep, type SweepDeps } from "../src/lifecycle.ts";
import { BoatMachineOps } from "../src/provider.ts";

type Call = { url: string; method: string; headers: Record<string, string> };
function fakeFetch(handler: (c: Call, n: number) => { status?: number; json: unknown }) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call = { url, method: init.method, headers: init.headers };
    calls.push(call);
    const r = handler(call, calls.length);
    return { status: r.status ?? 200, text: async () => JSON.stringify(r.json) };
  };
  return { fetch, calls };
}
const noSleep = async () => {};

describe("deleteBox (review must-fix 1; T7 live fixes)", () => {
  /** Fake Boat: DELETE answer, op status per poll, box visible for `boxPolls` GETs then 404. */
  function boat(opts: { del?: { status: number; json: unknown }; opStatus?: (n: number) => string; boxPolls?: number }) {
    let boxGets = 0;
    let opGets = 0;
    const { fetch, calls } = fakeFetch((c) => {
      if (c.method === "DELETE") return opts.del ?? { status: 202, json: { ok: true, type: "box.deleting", deletionOperationId: "op_1" } };
      if (c.url.includes("/deletion-operations/")) return { json: { ok: true, operation: { id: "op_1", status: opts.opStatus?.(++opGets) ?? "running" } } };
      if (++boxGets <= (opts.boxPolls ?? Infinity)) return { json: { ok: true, box: { id: "bx_del1", state: "archiving" } } };
      return { status: 404, json: { ok: false, code: "not_found", message: "Box not found" } };
    });
    return { fetch, calls };
  }
  const clock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  };

  it("sends X-Ascii-Confirm-Delete and resolves when the box is gone", async () => {
    const { fetch, calls } = boat({ boxPolls: 2 });
    const logs: string[] = [];
    await new BoatApi("k-secret", fetch, "https://b").deleteBox("bx_del1", { ...clock(), log: (m) => void logs.push(m) });
    assert.equal(calls[0]!.headers["X-Ascii-Confirm-Delete"], "bx_del1");
    assert.equal(calls[0]!.url, "https://b/boxes/bx_del1");
    assert.match(logs.at(-1)!, /box not found after 3 poll\(s\); removed/);
    assert.ok(!logs.join("\n").includes("k-secret"));
  });
  it("op status unknown but box 404 → removed (the first live remove's case)", async () => {
    const { fetch } = boat({ opStatus: () => "box_deleted_v2", boxPolls: 1 });
    const logs: string[] = [];
    await new BoatApi("k", fetch, "https://b").deleteBox("bx_del1", { ...clock(), log: (m) => void logs.push(m) });
    assert.match(logs.at(-1)!, /removed \(operation status was "box_deleted_v2"\)/);
  });
  it("a 'done' op status alone is not enough; waits for the box 404", async () => {
    const { fetch, calls } = boat({ opStatus: () => "completed", boxPolls: 3 });
    await new BoatApi("k", fetch, "https://b").deleteBox("bx_del1", clock());
    assert.equal(calls.filter((c) => c.url.endsWith("/boxes/bx_del1") && c.method === "GET").length, 4);
  });
  it("fails fast when the operation reports failure", async () => {
    const { fetch } = boat({ opStatus: () => "failed" });
    await assert.rejects(new BoatApi("k", fetch, "https://b").deleteBox("bx_del1", clock()), /deletion_failed.*op_1: failed/);
  });
  it("is bounded overall and says why it gave up", async () => {
    const { fetch, calls } = boat({ opStatus: () => "running" });
    await assert.rejects(
      new BoatApi("k", fetch, "https://b").deleteBox("bx_del1", { ...clock(), maxMs: 60_000, pollMs: 5_000 }),
      (e: unknown) => e instanceof BoatApiError && e.code === "deletion_timeout" && /still exists 60 s after DELETE.*last status "running"/.test(e.message),
    );
    assert.ok(calls.length <= 1 + 2 * 13, `bounded: ${calls.length} calls`);
  });
  it("without an operation id, still waits for the box 404", async () => {
    const { fetch } = boat({ del: { status: 202, json: { ok: true } }, boxPolls: 1 });
    await new BoatApi("k", fetch, "https://b").deleteBox("bx_del1", clock());
  });
  it("surfaces Boat's confirmation error if the gate ever changes", async () => {
    const { fetch } = fakeFetch(() => ({ status: 409, json: { ok: false, code: "delete_confirmation_required", message: "x" } }));
    await assert.rejects(new BoatApi("k", fetch, "https://b").deleteBox("bx_del4"), /delete_confirmation_required/);
  });
  it("treats an already-missing box as removed", async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 404, json: { ok: false, code: "not_found", message: "x" } }));
    await new BoatApi("k", fetch, "https://b").deleteBox("bx_gone1");
    assert.equal(calls.length, 1);
  });
});

describe("lifecycle sweep busy signal (review must-fix 2)", () => {
  const MIN = 60_000;
  function deps(busyThreads: number, lastActive: number | undefined, now: number, archiveAfter: string | null = null) {
    const suspended: string[] = [];
    const extended: string[] = [];
    let stored = lastActive;
    const d: SweepDeps = {
      listHosts: async () => [{ id: "host_1", machineProviderId: "boat", lifecycle: { phase: "active" } }],
      getResource: async () => ({ boxId: "bx_1", key: "k", dirtyAtSuspend: {} }),
      countBusyThreads: async () => busyThreads,
      getLastActive: async () => stored,
      setLastActive: async (_h, at) => void (stored = at),
      getBox: async () => ({ id: "bx_1", state: "idle", archiveAfter }),
      setTtl: async (id) => void extended.push(id),
      suspend: async (h) => void suspended.push(h),
      now: () => now,
      warn: () => {},
      info: () => {},
    };
    return { d, suspended, extended, last: () => stored };
  }
  const s = { idleMs: 15 * MIN, preTtlMarginMs: 15 * MIN, ttlSeconds: 14_400 };

  it("an active thread blocks idle suspend even with no events for an hour", async () => {
    const t = deps(1, 0, 60 * MIN);
    const [r] = await lifecycleSweep(t.d, s);
    assert.equal(r!.action, "none");
    assert.deepEqual(t.suspended, []);
    assert.equal(t.last(), 60 * MIN, "running work resets the idle clock");
  });
  it("suspends an idle machine with no running threads", async () => {
    const t = deps(0, 0, 60 * MIN);
    const [r] = await lifecycleSweep(t.d, s);
    assert.equal(r!.action, "suspend-idle");
    assert.deepEqual(t.suspended, ["host_1"]);
  });
  it("extends the TTL near Boat's auto-stop while a thread runs", async () => {
    const now = 10 * MIN;
    const t = deps(2, now, now, new Date(now + 5 * MIN).toISOString());
    const [r] = await lifecycleSweep(t.d, s);
    assert.equal(r!.action, "extend-ttl");
    assert.deepEqual(t.extended, ["bx_1"]);
    assert.deepEqual(t.suspended, []);
  });
  it("starts the idle clock on first sight instead of suspending", async () => {
    const t = deps(0, undefined, 60 * MIN);
    const [r] = await lifecycleSweep(t.d, s);
    assert.equal(r!.action, "none");
  });
  it("ignores other providers' machines and treats machine_busy as retry-later", async () => {
    const t = deps(0, 0, 60 * MIN);
    const err = Object.assign(new Error("busy"), { code: "machine_busy" });
    const warnings: string[] = [];
    t.d.listHosts = async () => [
      { id: "host_m", machineProviderId: "modal-sandbox", lifecycle: { phase: "active" } },
      { id: "host_1", machineProviderId: "boat", lifecycle: { phase: "active" } },
    ];
    t.d.suspend = async () => {
      throw err;
    };
    t.d.warn = (m) => void warnings.push(m);
    const res = await lifecycleSweep(t.d, s);
    assert.equal(res.length, 1);
    assert.deepEqual(warnings, []);
  });
});

describe("resume during a stop (review item 5)", () => {
  it("waits for a stopped state before POST /resume", async () => {
    const states = ["stopping", "archiving", "archived", "resuming", "idle"];
    let i = 0;
    const events: string[] = [];
    const api = {
      getBox: async () => {
        const state = states[Math.min(i++, states.length - 1)]!;
        events.push(`get:${state}`);
        return { id: "bx_1", state, error: null };
      },
      resume: async () => void events.push("POST resume"),
      writeFile: async () => {},
      runCommand: async (_id: string, cmd: string) =>
        cmd.includes("runner-conversion=")
          ? { exitCode: 0, stdout: "runner-conversion=ok\n", stderr: "" }
          : cmd.includes("identity=")
          ? { exitCode: 0, stdout: "identity=kept\n", stderr: "" }
          : { exitCode: 0, stdout: "verified=yes\nensure=yes\n", stderr: "" },
    };
    let t = 0;
    const ops = new BoatMachineOps({
      intents: memIntents(),
      config: async () => ({ apiKey: "k", org: "o", source: "fork", from: "bx_s", type: "default", ttlSeconds: 3600 }),
      api: () => withPrep(api) as unknown as BoatApi,
      bootstrap: async () => ({ hostId: "host_1" }),
      now: () => t,
      sleep: async (ms) => void (t += ms),
    });
    await ops.resume("host_1", { boxId: "bx_1", key: "k", dirtyAtSuspend: {} }, async () => {}, { step() {}, log() {} }, new AbortController().signal);
    const post = events.indexOf("POST resume");
    assert.ok(post > events.indexOf("get:archived"), events.join(" "));
    assert.equal(events.filter((e) => e === "POST resume").length, 1);
  });
  it("does not POST resume while Boat is already resuming", async () => {
    const states = ["resuming", "idle"];
    let i = 0;
    let posted = 0;
    const api = {
      getBox: async () => ({ id: "bx_1", state: states[Math.min(i++, 1)]!, error: null }),
      resume: async () => void posted++,
      writeFile: async () => {},
      runCommand: async (_id: string, cmd: string) =>
        cmd.includes("runner-conversion=")
          ? { exitCode: 0, stdout: "runner-conversion=ok\n", stderr: "" }
          : cmd.includes("identity=") ? { exitCode: 0, stdout: "identity=kept\n", stderr: "" } : { exitCode: 0, stdout: "verified=yes\nensure=yes\n", stderr: "" },
    };
    let t = 0;
    const ops = new BoatMachineOps({
      intents: memIntents(),
      config: async () => ({ apiKey: "k", org: "o", source: "fork", from: "bx_s", type: "default", ttlSeconds: 3600 }),
      api: () => withPrep(api) as unknown as BoatApi,
      bootstrap: async () => ({ hostId: "host_1" }),
      now: () => t,
      sleep: async (ms) => void (t += ms),
    });
    await ops.resume("host_1", { boxId: "bx_1", key: "k", dirtyAtSuspend: {} }, async () => {}, { step() {}, log() {} }, new AbortController().signal);
    assert.equal(posted, 0);
  });
});
