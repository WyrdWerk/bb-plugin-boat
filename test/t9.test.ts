import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { BoatApi, BoatApiError, type FetchLike, notReadyYet } from "../src/boat-api.ts";
import { BoatExecutor } from "../src/executor.ts";
import { BoatMachineOps } from "../src/provider.ts";
import { memIntents, withPrep } from "./helpers.ts";

// Live 2026-10-04 (bx_fce9gbpz, state `idle`): "Boat API 502 box_direct_failed: box_restoring".
const restoring = () => new BoatApiError(502, "box_direct_failed", "box_restoring");
const otherDirectFail = () => new BoatApiError(502, "box_direct_failed", "EISDIR: illegal operation on a directory");

describe("which Boat errors mean 'not ready yet' (T9)", () => {
  it("parses message and details from Boat's error body", async () => {
    const bodies: [number, unknown][] = [
      [502, { ok: false, type: "box.error", code: "box_direct_failed", message: "box_restoring" }],
      [502, { ok: false, code: "box_direct_failed", message: "Direct request failed", error: { details: { reason: "box_restoring" } } }],
      [409, { ok: false, code: "box_starting", message: "Box is starting" }],
      [409, { ok: false, code: "machine_not_running", message: "Machine not running" }],
      [502, { ok: false, code: "box_direct_failed", message: "EISDIR" }],
      [500, { ok: false, code: "internal", message: "box_restoring" }],
    ];
    const got: (string | null)[] = [];
    for (const [status, body] of bodies) {
      const fetch: FetchLike = async () => ({ status, text: async () => JSON.stringify(body) });
      try {
        await new BoatApi("k", fetch, "https://b").runCommand("bx_1", "true", 30);
      } catch (err) {
        got.push(notReadyYet(err));
      }
    }
    assert.deepEqual(got, ["box_restoring", "box_restoring", "box_starting", "machine_not_running", null, null]);
  });
  it("never treats other errors as retryable", () => {
    assert.equal(notReadyYet(otherDirectFail()), null);
    assert.equal(notReadyYet(new Error("box_restoring")), null);
    assert.equal(notReadyYet(new BoatApiError(502, "gateway_error", "box_restoring?")), null);
  });
});

function fakeApi(script: (n: number) => "ok" | Error, writeScript?: (n: number) => "ok" | Error) {
  let runs = 0;
  let writes = 0;
  const api = {
    runCommand: async () => {
      const r = script(++runs);
      if (r instanceof Error) throw r;
      return { exitCode: 0, stdout: "out\n", stderr: "" };
    },
    writeFile: async () => {
      const r = writeScript?.(++writes) ?? "ok";
      if (r instanceof Error) throw r;
    },
  };
  return { api: api as unknown as BoatApi, runs: () => runs, writes: () => writes };
}
function clock() {
  let t = 0;
  const sleeps: number[] = [];
  return { now: () => t, sleep: async (ms: number) => void (sleeps.push(ms), (t += ms)), sleeps };
}
const req = (stdin = "") => ({ command: ["true"], stdin, timeoutMs: 30_000, signal: new AbortController().signal, onOutput: () => {} });

describe("executor retries only 'not ready yet' (T9)", () => {
  it("restoring → accepted: retries every 10 s, reports each wait, returns the result", async () => {
    const f = fakeApi((n) => (n <= 3 ? restoring() : "ok"));
    const c = clock();
    const waits: string[] = [];
    const r = await new BoatExecutor(f.api, "bx_1", { ...c, onNotReady: (why, ms) => void waits.push(`${why}@${ms}`) }).exec(req());
    assert.equal(r.exitCode, 0);
    assert.equal(f.runs(), 4);
    assert.deepEqual(c.sleeps, [10_000, 10_000, 10_000]);
    assert.deepEqual(waits, ["box_restoring@0", "box_restoring@10000", "box_restoring@20000"]);
  });
  it("a non-restoring 502 fails fast: one attempt, no sleep (it may already have run)", async () => {
    const f = fakeApi(() => otherDirectFail());
    const c = clock();
    await assert.rejects(new BoatExecutor(f.api, "bx_1", c).exec(req()), /502 box_direct_failed: EISDIR/);
    assert.equal(f.runs(), 1);
    assert.deepEqual(c.sleeps, []);
  });
  it("is bounded and says why", async () => {
    const f = fakeApi(() => restoring());
    const c = clock();
    await assert.rejects(
      new BoatExecutor(f.api, "bx_1", { ...c, maxWaitMs: 60_000 }).exec(req()),
      /Boat still refuses commands on bx_1 \(box_restoring\) after 60 s/,
    );
    assert.equal(f.runs(), 7);
  });
  it("also waits before writing the private stdin file", async () => {
    const f = fakeApi(() => "ok", (n) => (n <= 2 ? new BoatApiError(409, "box_starting", "starting") : "ok"));
    const c = clock();
    await new BoatExecutor(f.api, "bx_1", c).exec(req("secret-bundle"));
    assert.equal(f.writes(), 3);
    assert.equal(f.runs(), 1);
  });
});

describe("settle: 'commands accepted' is the first condition (T9)", () => {
  function box(refuseUntilMs: number, failWith?: () => Error) {
    let t = 0;
    const events: string[] = [];
    const api = {
      createBox: async () => ({ id: "bx_fce9gbpz", state: "provisioning" }),
      getBox: async () => ({ id: "bx_fce9gbpz", state: "idle", error: null }),
      setName: async () => {},
      writeFile: async () => {},
      runCommand: async (_id: string, cmd: string) => {
        if (failWith) {
          events.push("fail");
          throw failWith();
        }
        if (t < refuseUntilMs) {
          events.push("refused");
          throw restoring();
        }
        if (cmd.includes("runner-conversion=")) return events.push("convert"), { exitCode: 0, stdout: "runner-conversion=ok\n", stderr: "" };
        if (cmd.includes("identity=")) return events.push("guard"), { exitCode: 0, stdout: "identity=kept\n", stderr: "" };
        events.push("cmd");
        return { exitCode: 0, stdout: "boot=done\nensure=no\n", stderr: "" };
      },
    };
    const logs: string[] = [];
    const ops = new BoatMachineOps({
      config: async () => ({ apiKey: "k", org: "o", source: "fork", from: "bx_hngwmb8t", type: "default", ttlSeconds: 3600 }),
      api: () => withPrep(api) as unknown as BoatApi,
      bootstrap: async () => (events.push("bootstrap"), { hostId: "h" }),
      now: () => t,
      sleep: async (ms) => void (t += ms),
      intents: memIntents(),
      log: (m) => void logs.push(m),
    });
    return { ops, events, logs };
  }
  const progressInto = (p: string[]) => ({ step: (s: string) => void p.push(`step: ${s}`), log: (s: string) => void p.push(`log: ${s}`) });
  const sig = new AbortController().signal;

  it("restoring for ~2.5 min → waits, says so, then continues to conversion and bootstrap", async () => {
    const b = box(150_000);
    const progress: string[] = [];
    await b.ops.create("boat-live-test-3", null, async () => {}, progressInto(progress), sig);
    assert.equal(b.events.filter((e) => e === "refused").length, 15);
    assert.deepEqual(b.events.slice(-3), ["convert", "guard", "bootstrap"]);
    const restoringLines = progress.filter((p) => p.includes("Boat is still restoring the disk"));
    assert.equal(restoringLines.length, 3, "first refusal, then once a minute");
    assert.match(restoringLines[0]!, /commands refused: box_restoring\); retrying every 10 s \(0 s so far\)/);
    assert.ok(progress.includes("log: Boat accepts commands on the box (restore signal) after 150 s"));
    assert.ok(b.logs.includes("settle: commands accepted after 150 s"));
  });
  it("a non-restoring 502 fails create at once (no retries)", async () => {
    const b = box(0, otherDirectFail);
    await assert.rejects(b.ops.create("k2", null, async () => {}, progressInto([]), sig), /502 box_direct_failed: EISDIR/);
    assert.deepEqual(b.events, ["fail"]);
  });
});
