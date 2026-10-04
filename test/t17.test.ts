import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { BoatApi, type FetchLike } from "../src/boat-api.ts";
import { createDashboardHandlers, forkRunnerKey } from "../src/dashboard.ts";
import { ACTIONS, actionsFor } from "../ui/actions.ts";

/** Fake Boat with two boxes; records calls (a plain fork must still go to Boat directly). */
function boat() {
  const calls: { method: string; url: string; headers: Record<string, string> }[] = [];
  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    calls.push({ method: init.method, url: u.pathname, headers: init.headers });
    const json = (status: number, body: unknown) => ({ status, text: async () => JSON.stringify(body) });
    const id = u.pathname.split("/")[2];
    if (init.method === "GET" && (id === "bx_base0001" || id === "bx_c8rfa8gs")) return json(200, { ok: true, box: { id, state: "archived" } });
    if (init.method === "POST" && u.pathname.endsWith("/fork")) return json(202, { ok: true, box: { id: "bx_plain1", state: "provisioning" } });
    return json(404, { ok: false, code: "not_found", message: u.pathname });
  };
  return { api: new BoatApi("k", fetch, "https://b"), calls };
}

function handlers(withCreate = true) {
  const b = boat();
  const created: { key: string; inputs: unknown }[] = [];
  const h = createDashboardHandlers({
    client: async () => ({ api: b.api, org: "o", ttlSeconds: 3600, baseBoxId: "bx_base0001" }),
    hosts: async () => [],
    getResource: async () => null,
    publish: () => {},
    now: () => 0,
    ...(withCreate
      ? {
          createMachine: async (args: { key: string; inputs: unknown }) => {
            created.push(args);
            return { hostId: "host_new1", name: "Boat new1" };
          },
        }
      : {}),
  });
  return { h, created, calls: b.calls };
}
const REQ = "3f1c9a52-8a6e-4c1e-9d0b-1a2b3c4d5e6f";

describe("Fork as bb runner (T17)", () => {
  it("creates a bb machine via bb core: provider inputs {source: fork, from: <box>}, stable key per click", async () => {
    const t = handlers();
    const r = await t.h.boat_fork_runner({ boxId: "bx_c8rfa8gs", requestId: REQ });
    assert.deepEqual(t.created, [{ key: `boat-page-fork-${REQ}`, inputs: { source: "fork", from: "bx_c8rfa8gs" } }]);
    assert.equal(r.hostId, "host_new1");
    assert.match(r.message, /^Creating bb machine Boat new1 from a fork of bx_c8rfa8gs: fork → disk check → conversion → hub check → enrollment/);
    assert.ok(!t.calls.some((c) => c.method === "POST"), "no direct Boat fork: core runs the provider's create");
  });
  it("is allowed for the base box (the normal source)", async () => {
    const t = handlers();
    await t.h.boat_fork_runner({ boxId: "bx_base0001", requestId: REQ });
    assert.deepEqual(t.created[0]!.inputs, { source: "fork", from: "bx_base0001" });
  });
  it("the same click retried reuses the key; a new click gets a new one", async () => {
    const t = handlers();
    await t.h.boat_fork_runner({ boxId: "bx_c8rfa8gs", requestId: REQ });
    await t.h.boat_fork_runner({ boxId: "bx_c8rfa8gs", requestId: REQ });
    await t.h.boat_fork_runner({ boxId: "bx_c8rfa8gs", requestId: "0b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b" });
    assert.deepEqual(t.created.map((c) => c.key), [forkRunnerKey(REQ), forkRunnerKey(REQ), forkRunnerKey("0b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b")]);
  });
  it("refuses an unknown box, and a build without machine creation", async () => {
    await assert.rejects(handlers().h.boat_fork_runner({ boxId: "bx_nope1", requestId: REQ }), /not found/);
    await assert.rejects(handlers(false).h.boat_fork_runner({ boxId: "bx_c8rfa8gs", requestId: REQ }), /bb machine creation is not available/);
  });
  it("Plain fork is unchanged: a direct Boat fork with the click's Idempotency-Key, no bb machine", async () => {
    const t = handlers();
    const r = await t.h.boat_fork({ boxId: "bx_c8rfa8gs", ttlHours: 1, requestId: REQ });
    const post = t.calls.find((c) => c.method === "POST")!;
    assert.equal(post.url, "/boxes/bx_c8rfa8gs/fork");
    assert.equal(post.headers["Idempotency-Key"], REQ);
    assert.equal(r.newBoxId, "bx_plain1");
    assert.deepEqual(t.created, []);
  });
});

describe("Fork actions on the page (T17)", () => {
  const box = (over: Record<string, unknown> = {}) => ({
    id: "bx_c8rfa8gs", name: null, state: "archived", type: null, archiveAfter: null, health: null, error: null,
    lastSnapshotStatus: null, snapshotCompletedAt: null, createdAt: null, machine: null, isBase: false, agentUpdates: null, ...over,
  });
  it("'Fork as bb runner' comes first; the plain fork is clearly labelled", () => {
    const a = actionsFor(box());
    assert.ok(a.indexOf("fork-runner") < a.indexOf("fork"));
    assert.equal(ACTIONS["fork-runner"].label, "Fork as bb runner");
    assert.equal(ACTIONS.fork.label, "Plain fork (no bb runner)");
    assert.deepEqual(actionsFor(box({ id: "bx_base0001", isBase: true })), ["fork-runner", "fork"]);
  });
  it("the runner dialog says what bb will do and that the source isn't changed", () => {
    assert.match(ACTIONS["fork-runner"].confirm(box()), /bb runs the full setup: fork, disk check, runner conversion, hub check and enrollment.*bx_c8rfa8gs itself is not changed/);
  });
});

// ---------------------------------------------------------------------------
// T17 addendum: environment compositions + machine inputs control.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { formFromValue, machineInputsChange } from "../ui/machine-inputs.ts";

describe("Boat sandbox environment compositions (T17 addendum)", () => {
  it("registers boat + git-worktree and boat-checkout + project-checkout, next to the machine provider", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "boat" });
    await plugin(bb);
    const regs = harness.registrations as unknown as {
      environmentCompositions: Map<string, { id: string; machineProviderId: string; environmentProviderId: string; displayName: string }>;
      machineProviders: Map<string, unknown>;
    };
    const comps = [...regs.environmentCompositions.values()].map((c) => [c.id, c.machineProviderId, c.environmentProviderId, c.displayName]);
    assert.deepEqual(comps, [
      ["boat", "boat", "git-worktree", "Boat sandbox"],
      ["boat-checkout", "boat", "project-checkout", "Boat sandbox (project checkout)"],
    ]);
    assert.ok(regs.machineProviders.has("boat"), "the composition points at a registered machine provider");
    await harness.lifecycle.dispose();
  });
  it("serves non-secret defaults for the inputs control", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "boat", settings: { apiKey: "k-secret", org: "o", from: "bx_base0001" } });
    await plugin(bb);
    const d = await harness.behavior.callRpc("boat_machine_defaults", null);
    assert.deepEqual(d, { from: "bx_base0001", type: "default", projects: [] });
    assert.ok(!JSON.stringify(d).includes("k-secret"));
    await harness.lifecycle.dispose();
  });
});

describe("machine inputs control logic (T17 addendum)", () => {
  it("blank = plugin defaults (empty inputs, which the provider schema accepts)", () => {
    assert.deepEqual(machineInputsChange({ from: "", type: "", project: "" }), { status: "ready", value: {} });
  });
  it("a fork source and size become provider inputs", () => {
    assert.deepEqual(machineInputsChange({ from: " bx_c8rfa8gs ", type: "large", project: "" }), {
      status: "ready",
      value: { source: "fork", from: "bx_c8rfa8gs", type: "large" },
    });
  });
  it("blocks a malformed box id with a visible reason", () => {
    assert.equal(machineInputsChange({ from: "c8rfa8gs", type: "", project: "" }).status, "blocked");
  });
  it("reads persisted values back", () => {
    assert.deepEqual(formFromValue({ source: "fork", from: "bx_a1", type: "small" }), { from: "bx_a1", type: "small", project: "" });
    assert.deepEqual(formFromValue(null), { from: "", type: "", project: "" });
    assert.deepEqual(formFromValue({ type: "huge" }), { from: "", type: "", project: "" });
  });
});
