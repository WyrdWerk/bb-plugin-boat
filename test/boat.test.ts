import { strict as assert } from "node:assert";
import { memIntents, withPrep } from "./helpers.ts";
import { describe, it } from "node:test";
import { BoatApi, BoatApiError, type FetchLike } from "../src/boat-api.ts";
import { BoatExecutor, buildCommand, shellQuote } from "../src/executor.ts";
import { BoatMachineOps, type BoatResource, type ProviderConfig } from "../src/provider.ts";
import { idempotencyKey } from "../src/policy.ts";

type Call = { url: string; method: string; headers: Record<string, string>; body?: unknown };

function fakeFetch(handler: (c: Call) => { status?: number; json: unknown }) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call: Call = { url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const r = handler(call);
    return { status: r.status ?? 200, text: async () => JSON.stringify(r.json) };
  };
  return { fetch, calls };
}

const SECRET_BOX = {
  id: "bx_new1",
  name: "bb-x",
  state: "ready",
  url: "https://secret.example",
  ip: "10.0.0.1",
  sshEndpoint: "ssh://secret",
  subdomain: "s",
  desktopUrl: "https://d?_token=t",
};

describe("BoatApi", () => {
  it("sends auth and the idempotency key, forks by source id, drops secret fields", async () => {
    const { fetch, calls } = fakeFetch(() => ({ json: { ok: true, type: "box.forking", box: SECRET_BOX } }));
    const api = new BoatApi("k-123", fetch, "https://b/api");
    const box = await api.createBox({
      source: { kind: "fork", boxId: "bx_src1" },
      name: "bb-x",
      org: "Example Org",
      ttlSeconds: 7200,
      idempotencyKey: "idem-1",
    });
    assert.equal(calls[0]!.url, "https://b/api/boxes/bx_src1/fork");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.headers.Authorization, "Bearer k-123");
    assert.equal(calls[0]!.headers["Idempotency-Key"], "idem-1");
    assert.deepEqual(calls[0]!.body, { name: "bb-x", ttlSeconds: 7200 });
    assert.deepEqual(Object.keys(box).sort(), ["id", "name", "state"]);
    assert.ok(!JSON.stringify(box).includes("secret"));
  });
  it("creates from a named snapshot on the team org", async () => {
    const { fetch, calls } = fakeFetch(() => ({ json: { ok: true, box: SECRET_BOX } }));
    await new BoatApi("k", fetch, "https://b").createBox({
      source: { kind: "snapshot", from: "bb-runner-template" },
      name: "bb-x",
      org: "team_1",
      ttlSeconds: 3600,
      type: "default",
      idempotencyKey: "i",
    });
    assert.equal(calls[0]!.url, "https://b/boxes");
    assert.deepEqual(calls[0]!.body, { name: "bb-x", ttlSeconds: 3600, type: "default", from: "bb-runner-template", org: "team_1" });
  });
  it("maps errors and treats 404 as gone", async () => {
    const { fetch } = fakeFetch((c) =>
      c.method === "POST"
        ? { status: 402, json: { ok: false, code: "billing_required", message: "Start the plan" } }
        : { status: 404, json: { ok: false, code: "not_found", message: "no" } },
    );
    const api = new BoatApi("k", fetch, "https://b");
    assert.equal(await api.getBox("bx_x"), null);
    await api.deleteBox("bx_x");
    await assert.rejects(api.stop("bx_x"), (e: unknown) => e instanceof BoatApiError && e.code === "billing_required");
  });
});

describe("executor", () => {
  it("quotes argv for one shell string", () => {
    assert.equal(shellQuote(["echo", "a b", "it's", "plain-1.2"]), `echo 'a b' 'it'\\''s' plain-1.2`);
  });
  it("sets HOME and closes stdin when there is none", () => {
    assert.match(buildCommand(["node", "-v"], null), /^export HOME=\/home\/user .*node -v <\/dev\/null$/);
  });
  it("passes stdin through a private temp file it deletes", async () => {
    const writes: { path: string; content: string }[] = [];
    const commands: { command: string; timeout: number }[] = [];
    const api = {
      writeFile: async (_id: string, path: string, content: string) => void writes.push({ path, content }),
      runCommand: async (_id: string, command: string, timeout: number) => {
        commands.push({ command, timeout });
        return { exitCode: 3, stdout: "out", stderr: "", timedOut: false };
      },
    } as unknown as BoatApi;
    const output: string[] = [];
    const res = await new BoatExecutor(api, "bx_1").exec({
      command: ["sh", "install.sh"],
      stdin: "BOOTSTRAP-SECRET",
      timeoutMs: 3_600_000,
      signal: new AbortController().signal,
      onOutput: (c) => output.push(c),
    });
    assert.equal(res.exitCode, 3);
    assert.equal(writes[0]!.content, "BOOTSTRAP-SECRET");
    assert.match(writes[0]!.path, /^\/tmp\/bb-stdin-/);
    assert.ok(commands[0]!.command.includes(`<${writes[0]!.path}`));
    assert.ok(commands[0]!.command.includes(`rm -f ${writes[0]!.path}`));
    assert.ok(!commands[0]!.command.includes("BOOTSTRAP-SECRET"));
    assert.equal(commands[0]!.timeout, 600);
    assert.deepEqual(output, ["out"]);
  });
});

describe("BoatMachineOps", () => {
  const config: ProviderConfig = { apiKey: "k", org: "team_1", source: "fork", from: "bx_tmpl1", type: "default", ttlSeconds: 7200 };

  /** Scripted fake Boat: box state sequence + canned on-box script output. */
  function fakeBoat(opts: { states: string[]; error?: string; guard: string; probe?: string[] }) {
    const events: string[] = [];
    let polls = 0;
    let probes = 0;
    const api = {
      createBox: async (req: { name?: string; idempotencyKey: string }) => {
        events.push(`create ${req.name ?? "(no name)"} ${req.idempotencyKey}`);
        return { id: "bx_new1", state: "provisioning" };
      },
      getBox: async () => {
        const state = opts.states[Math.min(polls++, opts.states.length - 1)]!;
        return { id: "bx_new1", state, error: opts.error ?? null, lastSnapshotStatus: "completed" };
      },
      resume: async () => void events.push("resume"),
      stop: async () => void events.push("stop"),
      writeFile: async () => {},
      runCommand: async (_id: string, command: string) => {
        if (command.includes("runner-conversion=")) {
          events.push("convert");
          return { exitCode: 0, stdout: "runner-conversion=ok bb-app=inactive/disabled port38886=free serve=off runner-ensure=ok\n", stderr: "" };
        }
        if (command.includes("identity=")) {
          events.push("guard");
          return { exitCode: 0, stdout: opts.guard, stderr: "" };
        }
        const probe = opts.probe ?? ["verified=yes\nensure=yes\n"];
        events.push("probe");
        return { exitCode: 0, stdout: probe[Math.min(probes++, probe.length - 1)]!, stderr: "" };
      },
    };
    let t = 0;
    const ops = new BoatMachineOps({
      intents: memIntents(),
      config: async () => config,
      api: () => withPrep(api) as unknown as BoatApi,
      bootstrap: async () => {
        events.push("bootstrap");
        return { hostId: "host_1" };
      },
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      pollMs: 5_000,
    });
    return { ops, events };
  }
  const report = { step() {}, log() {} };
  const signal = new AbortController().signal;

  it("create: idempotent allocation, checkpoint, settle, identity guard, then bootstrap", async () => {
    const { ops, events } = fakeBoat({ states: ["provisioning", "cloning", "ready"], guard: "identity=wiped\n" });
    const checkpoints: BoatResource[] = [];
    const out = await ops.create("key-1", null, async (r) => void checkpoints.push(r), report, signal);
    assert.equal(events[0], `create (no name) ${idempotencyKey("key-1")}`, "Boat ignores fork names; none sent");
    assert.deepEqual(checkpoints, [{ boxId: "bx_new1", key: "key-1", dirtyAtSuspend: {}, project: null }]);
    assert.ok(events.indexOf("probe") < events.indexOf("convert"), "settle before conversion");
    assert.ok(events.indexOf("convert") < events.indexOf("guard"), "conversion before identity guard");
    assert.ok(events.indexOf("guard") < events.indexOf("bootstrap"), "guard runs before bootstrap");
    assert.equal(events.at(-1), "bootstrap");
    assert.equal(out.name, "bx-new1");
  });
  it("create: refuses a box whose restore was incomplete", async () => {
    const { ops, events } = fakeBoat({
      states: ["ready"],
      error: "Restore incomplete: restore handed over with 0/0 image file(s) missing",
      guard: "identity=wiped\n",
    });
    await assert.rejects(ops.create("key-2", null, async () => {}, report, signal), /incomplete restore/);
    assert.ok(!events.includes("bootstrap"));
  });
  it("resume: waits for runner-ensure and clean repos before bootstrap", async () => {
    const { ops, events } = fakeBoat({
      states: ["archived", "resuming", "idle"],
      guard: "identity=kept\n",
      probe: [
        "verified=no\nensure=yes\n",
        "verified=yes\nensure=yes\nrepo /r 1 logs/notion-sync-latest.log\n",
        "verified=yes\nensure=yes\nrepo /r 0\n",
        "verified=yes\nensure=yes\nrepo /r 0\n",
        "verified=yes\nensure=yes\nrepo /r 0\n",
      ],
    });
    const resource = { boxId: "bx_new1", key: "key-1", dirtyAtSuspend: {} };
    await ops.resume("host_1", resource, async () => {}, report, signal);
    assert.equal(events[0], "resume");
    assert.equal(events.filter((e) => e === "probe").length, 5);
    assert.deepEqual(events.slice(-3), ["convert", "guard", "bootstrap"]);
  });
  it("resume: refuses to restart a host whose identity is not this box's", async () => {
    const { ops, events } = fakeBoat({ states: ["idle"], guard: "identity=wiped\n" });
    await assert.rejects(
      ops.resume("host_1", { boxId: "bx_new1", key: "k", dirtyAtSuspend: {} }, async () => {}, report, signal),
      /does not belong/,
    );
    assert.ok(!events.includes("bootstrap"));
  });
  it("suspend: records the dirty set, then stops (Boat snapshots first)", async () => {
    const { ops, events } = fakeBoat({
      states: ["idle", "archived"],
      guard: "",
      probe: ["verified=yes\nensure=yes\nrepo /r 1 wip.txt\n"],
    });
    const checkpoints: BoatResource[] = [];
    const out = await ops.suspend({ boxId: "bx_new1", key: "k", dirtyAtSuspend: {} }, async (r) => void checkpoints.push(r), report, signal);
    assert.deepEqual(out.dirtyAtSuspend, { "/r": ["wip.txt"] });
    assert.deepEqual(checkpoints.map((c) => c.dirtyAtSuspend), [{ "/r": ["wip.txt"] }]);
    assert.deepEqual(events, ["probe", "stop"]);
  });
});
