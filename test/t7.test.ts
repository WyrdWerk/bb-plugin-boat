import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { BoatApiError, type BoatApi, type CreateBoxRequest } from "../src/boat-api.ts";
import { runnerConversionCommand, runnerConversionScript } from "../src/conversion.ts";
import { buildCommand } from "../src/executor.ts";
import { identityGuardScript, idempotencyKey, runnerBoxName, SETTLE_PROBE_SCRIPT } from "../src/policy.ts";
import { BoatMachineOps, type ProviderConfig } from "../src/provider.ts";
import { BB_RUNNER_GUARD_SH, RUNNER_ENSURE_SH } from "../src/runner-files.generated.ts";
import { memIntents, withPrep } from "./helpers.ts";

// ---------------------------------------------------------------------------
// Fix 1: pkill/pgrep -f must never match the shell that carries the script.
// Live 2026-10-04: `sudo -n bash -c '<conversion>'` ran inside a user shell whose
// command line held the whole script, so `pkill -u user -f 'bin/bb-app
// --server-bind-host'` killed it: exit 143 after a successful conversion.

const SCRIPTS: Record<string, string> = {
  conversion: runnerConversionScript(),
  identityGuard: identityGuardScript("bx_abc123"),
  runnerEnsure: RUNNER_ENSURE_SH,
  guard: BB_RUNNER_GUARD_SH,
  settleProbe: SETTLE_PROBE_SCRIPT,
};
/** Command lines these scripts appear in on a box: raw, and as the executor sends them. */
const CMDLINES: Record<string, string> = {
  ...SCRIPTS,
  conversionAsSent: buildCommand(runnerConversionCommand(), null),
  identityGuardAsSent: buildCommand(["sh", "-c", SCRIPTS.identityGuard!], null),
};

function pkillPatterns(script: string): string[] {
  const out: string[] = [];
  for (const m of script.matchAll(/\bp(?:kill|grep)\b[^\n]*?\s-[a-zA-Z]*f[a-zA-Z]*\s+(?:-[^\s]+\s+)*'([^']+)'/g)) out.push(m[1]!);
  return out;
}

describe("self-safe pkill/pgrep patterns (T7 fix 1)", () => {
  const patterns = Object.entries(SCRIPTS).flatMap(([name, s]) => pkillPatterns(s).map((p) => ({ name, p })));

  it("finds the patterns it must check", () => {
    assert.deepEqual(patterns.map((x) => x.p).sort(), ["[b]b-app[ /]host-daemon", "[b]b-app[ /]host-daemon", "[b]b-app[ /]host-daemon", "[b]in/bb-app --server-bind-host"].sort());
  });

  it("no pattern matches any generated script's own text or command line", () => {
    for (const { name, p } of patterns) {
      const re = new RegExp(p, "s"); // POSIX ERE subset; `.` crosses newlines in /proc cmdline
      for (const [where, text] of Object.entries(CMDLINES)) {
        assert.ok(!re.test(text), `pattern '${p}' from ${name} matches ${where}`);
      }
    }
  });

  it("control: the old patterns DID match (so the check above can catch it)", () => {
    // The live bug: the conversion's own kill pattern vs. its own command line.
    assert.ok(new RegExp("bin/bb-app --server-bind-host", "s").test(CMDLINES.conversionAsSent!.replace("[b]in", "bin")));
    // The latent one found by this test: `.*` bridged bb-app.service … ' host-daemon'.
    // The script as it was before T7 embedded runner-ensure with that pattern.
    const before = CMDLINES.conversion!.replaceAll("[b]b-app[ /]host-daemon", "[b]b-app.* host-daemon");
    assert.ok(new RegExp("[b]b-app.* host-daemon", "s").test(before));
  });

  it("the new runner-daemon pattern still matches the real daemon command line", () => {
    const daemon = '/home/user/.nvm/versions/node/v24.19.0/bin/node /home/user/.bb-machines/hub.example-tailnet.ts.net-3888/npm/bin/bb-app host-daemon --auto-update --host-daemon-port 38888 --server-url https://hub.example-tailnet.ts.net:3888';
    assert.ok(new RegExp("[b]b-app[ /]host-daemon").test(daemon), "launcher");
    assert.ok(new RegExp("[b]b-app[ /]host-daemon").test("node /home/user/.bb-machines/hub.example-tailnet.ts.net-3888/npm/lib/node_modules/bb-app/host-daemon/dist/daemon-bundle.mjs"), "daemon bundle");
    assert.ok(new RegExp("[b]in/bb-app --server-bind-host").test("node /home/user/.nvm/versions/node/v24.19.0/bin/bb-app --server-bind-host 0.0.0.0"));
  });

  it("real pgrep: the bracket pattern does not find its own shell, the plain one does", () => {
    // Read-only (pgrep, not pkill) and a unique marker, so nothing else can match.
    const marker = `t7-selfmatch-${process.pid}`;
    // The shell's own command line contains only `pattern` (as text), like the live case.
    const run = (pattern: string) => execFileSync("bash", ["-c", `echo "self=$$"; pgrep -f '${pattern}' || true`], { encoding: "utf8" });
    const plain = run(`${marker}`);
    const self = /self=(\d+)/.exec(plain)![1]!;
    assert.ok(plain.split("\n").includes(self), "plain pattern matches its own shell (the live bug)");
    const safe = run(`[${marker[0]}]${marker.slice(1)}`);
    const selfSafe = /self=(\d+)/.exec(safe)![1]!;
    assert.ok(!safe.split("\n").includes(selfSafe), "bracket pattern does not");
  });
});

// ---------------------------------------------------------------------------
// Fix 2: cleanup without names (Boat ignored the fork name live) via replay.

const config: ProviderConfig = { apiKey: "k", org: "team_1", source: "fork", from: "bx_base0001", type: "default", ttlSeconds: 3600 };
const request: CreateBoxRequest = {
  source: { kind: "fork", boxId: "bx_base0001" },
  org: "team_1",
  ttlSeconds: 3600,
  type: "default",
  idempotencyKey: idempotencyKey("key-x"),
};

function fakeApi(over: Partial<Record<string, (...a: never[]) => unknown>> = {}) {
  const calls: { fn: string; args: unknown[] }[] = [];
  const api = new Proxy(
    {},
    {
      get: (_t, fn: string) => (...args: unknown[]) => {
        calls.push({ fn, args });
        const impl = (over as Record<string, (...a: unknown[]) => unknown>)[fn];
        if (impl) return impl(...args);
        if (fn === "deleteBox") return Promise.resolve();
        throw new Error(`unexpected ${fn}`);
      },
    },
  );
  return { api: api as unknown as BoatApi, calls };
}

function ops(api: BoatApi, intents = memIntents(), logs: string[] = []) {
  let t = 0;
  return new BoatMachineOps({
    config: async () => config,
    api: () => withPrep(api),
    bootstrap: async () => ({ hostId: "h" }),
    now: () => t,
    sleep: async (ms) => void (t += ms),
    intents,
    log: (m) => void logs.push(m),
  });
}
const signal = new AbortController().signal;

describe("reconcileCleanup without names (T7 fix 2)", () => {
  it("no recorded intent → nothing was ever requested → removed, no Boat calls", async () => {
    const { api, calls } = fakeApi();
    await ops(api).reconcileCleanup("key-x", signal);
    assert.deepEqual(calls, []);
  });

  it("recorded box id → deletes it directly", async () => {
    const intents = memIntents({ "key-x": { request, boxId: "bx_known1" } });
    const { api, calls } = fakeApi();
    await ops(api, intents).reconcileCleanup("key-x", signal);
    assert.deepEqual(calls.map((c) => [c.fn, c.args[0]]), [["deleteBox", "bx_known1"]]);
    assert.equal(intents.map.size, 0);
  });

  it("box id unknown → replays the SAME request (same key and body), deletes the returned box", async () => {
    const intents = memIntents({ "key-x": { request, boxId: null } });
    const { api, calls } = fakeApi({ createBox: (async () => ({ id: "bx_lost1", state: "provisioning" })) as never });
    await ops(api, intents).reconcileCleanup("key-x", signal);
    assert.deepEqual(calls[0]!.args[0], request, "identical replay");
    assert.deepEqual(calls.map((c) => c.fn), ["createBox", "deleteBox"]);
    assert.equal(calls[1]!.args[0], "bx_lost1");
    assert.equal(intents.map.size, 0);
  });

  it("replay answered 4xx (nothing was created) → removed", async () => {
    const intents = memIntents({ "key-x": { request, boxId: null } });
    const { api, calls } = fakeApi({
      createBox: (async () => {
        throw new BoatApiError(402, "billing_required", "Start the plan");
      }) as never,
    });
    const logs: string[] = [];
    await ops(api, intents, logs).reconcileCleanup("key-x", signal);
    assert.deepEqual(calls.map((c) => c.fn), ["createBox"]);
    assert.match(logs.at(-1)!, /Boat created nothing \(billing_required\)/);
    assert.equal(intents.map.size, 0);
  });

  it("replay still in progress → fails so core retries (intent kept)", async () => {
    const intents = memIntents({ "key-x": { request, boxId: null } });
    const { api } = fakeApi({
      createBox: (async () => {
        throw new BoatApiError(409, "idempotency_in_progress", "retry");
      }) as never,
    });
    await assert.rejects(ops(api, intents).reconcileCleanup("key-x", signal), /idempotency_in_progress/);
    assert.equal(intents.map.size, 1);
  });

  it("never deletes the source box, even if a replay returned it", async () => {
    const intents = memIntents({ "key-x": { request, boxId: null } });
    const { api, calls } = fakeApi({ createBox: (async () => ({ id: "bx_base0001", state: "archived" })) as never });
    await assert.rejects(ops(api, intents).reconcileCleanup("key-x", signal), /refusing to delete the source box/);
    assert.ok(!calls.some((c) => c.fn === "deleteBox"));
  });

  it("remove refuses the base box and clears the intent after a normal remove", async () => {
    const intents = memIntents({ "key-x": { request, boxId: "bx_r1" } });
    const { api } = fakeApi();
    const o = ops(api, intents);
    await assert.rejects(o.remove({ boxId: "bx_base0001", key: "k0", dirtyAtSuspend: {} }, signal), /base box/);
    await o.remove({ boxId: "bx_r1", key: "key-x", dirtyAtSuspend: {} }, signal);
    assert.equal(intents.map.size, 0);
  });
});

describe("create records the intent before Boat and renames after (T7 fixes 2, 3)", () => {
  function createApi(onCreate: () => void, rename: (id: string, name: string) => Promise<void>) {
    return fakeApi({
      createBox: (async () => {
        onCreate();
        return { id: "bx_new1", state: "provisioning" };
      }) as never,
      setName: rename as never,
      getBox: (async () => ({ id: "bx_new1", state: "ready", error: null })) as never,
      writeFile: (async () => {}) as never,
      runCommand: (async (_id: string, cmd: string) =>
        cmd.includes("runner-conversion=")
          ? { exitCode: 0, stdout: "runner-conversion=ok\n", stderr: "" }
          : cmd.includes("identity=")
            ? { exitCode: 0, stdout: "identity=kept\n", stderr: "" }
            : { exitCode: 0, stdout: "boot=done\nensure=no\n", stderr: "" }) as never,
    });
  }

  it("intent (without a name) is stored before createBox; box id right after; then renamed", async () => {
    const intents = memIntents();
    let atCreate: unknown;
    const renames: string[] = [];
    const { api, calls } = createApi(
      () => (atCreate = structuredClone(intents.map.get("key-x"))),
      async (id, name) => void renames.push(`${id}=${name}`),
    );
    const checkpoints: string[] = [];
    await ops(api, intents).create("key-x", null, async (r) => void checkpoints.push(r.boxId), { step() {}, log() {} }, signal);
    assert.deepEqual(atCreate, { request, boxId: null });
    assert.equal("name" in (calls.find((c) => c.fn === "createBox")!.args[0] as object), false, "no name sent; Boat ignores it");
    assert.deepEqual(intents.map.get("key-x"), { request, boxId: "bx_new1" });
    assert.deepEqual(checkpoints, ["bx_new1"]);
    assert.deepEqual(renames, [`bx_new1=${runnerBoxName("key-x")}`]);
    assert.ok(calls.findIndex((c) => c.fn === "setName") > calls.findIndex((c) => c.fn === "createBox"));
  });

  it("a failed rename does not fail create", async () => {
    const logs: string[] = [];
    const { api } = createApi(
      () => {},
      async () => {
        throw new BoatApiError(400, "invalid_name", "nope");
      },
    );
    await ops(api, memIntents(), logs).create("key-y", null, async () => {}, { step() {}, log() {} }, signal);
    assert.ok(logs.some((l) => /rename to .* failed \(kept Boat's name\)/.test(l)));
  });

  it("a retried create reuses the recorded request (same body for the same key)", async () => {
    const intents = memIntents({ "key-x": { request: { ...request, ttlSeconds: 1234 }, boxId: null } });
    const { api, calls } = createApi(() => {}, async () => {});
    await ops(api, intents).create("key-x", null, async () => {}, { step() {}, log() {} }, signal);
    assert.equal((calls.find((c) => c.fn === "createBox")!.args[0] as CreateBoxRequest).ttlSeconds, 1234);
  });
});
