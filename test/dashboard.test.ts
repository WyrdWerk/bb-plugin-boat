import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { BoatApi, type FetchLike } from "../src/boat-api.ts";
import { createDashboardHandlers, type DashboardDeps, overviewDto } from "../src/dashboard.ts";
import { ACTIONS, actionsFor, parseFields } from "../ui/actions.ts";
import { ago, bytes, healthLabel, stateBadge, ttlLabel } from "../ui/format.ts";
import plugin from "../server.ts";

const KEY = "boat-secret-key-123"; // gitleaks:allow (fake test value)
const SECRET_BITS = { url: "https://secret-host.example", ip: "10.9.8.7", sshEndpoint: "ssh://secret", subdomain: "secret-sub", desktopUrl: "https://d?_token=tok" };

/** Mocked Boat HTTP API (shapes from the 2026-09 reference), with secret fields mixed in. */
function boatServer(overrides: Partial<Record<string, (req: { method: string; url: string; body: unknown; headers: Record<string, string> }) => { status?: number; json: unknown }>> = {}) {
  const calls: { method: string; url: string; body: unknown; headers: Record<string, string> }[] = [];
  const routes: Record<string, (req: (typeof calls)[number]) => { status?: number; json: unknown }> = {
    "GET /boxes": () => ({
      json: {
        ok: true,
        type: "box.list",
        boxes: [
          { id: "bx_run1", name: "runner", state: "idle", type: "default", archiveAfter: "2026-10-04T12:00:00.000Z", health: "ok", error: null, lastSnapshotStatus: "completed", snapshotCompletedAt: "2026-10-04T09:00:00.000Z", createdAt: "2026-10-03T17:00:00.000Z", ...SECRET_BITS },
          { id: "bx_old1", name: "old", state: "archived", type: "small", archiveAfter: null, health: "ok", error: "Restore incomplete: restore handed over with 0/0 image file(s) missing", lastSnapshotStatus: "completed", ...SECRET_BITS },
        ],
        pageInfo: { hasMore: false, nextCursor: null },
      },
    }),
    "GET /limits": () => ({
      json: { ok: true, type: "limits.info", teamId: "team_1", canStart: true, accessTier: "standard", activeBoxes: 1, maxActiveBoxes: 100, creditBalanceSeconds: 1_935_288, starts: { minute: { remaining: 12 }, hour: { remaining: 58 }, day: { remaining: 196 } } },
    }),
    "GET /named-snapshots": () => ({
      json: { ok: true, namedSnapshots: [{ name: "bb-boat-base-pilot-v4", status: "ready", sourceBoxId: "bx_src1", type: "default", sizeBytes: 12_000_000_000, createdAt: "2026-09-24T10:00:00.000Z", signedUrl: "https://s3?sig=x" }] },
    }),
    ...overrides,
  } as never;
  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const req = { method: init.method, url: u.pathname + u.search, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers };
    calls.push(req);
    const key = `${init.method} ${u.pathname.replace(/^\/api\/box\/v1/, "")}`;
    const route = routes[key] ?? routes[`${init.method} ${u.pathname.replace(/^\/api\/box\/v1/, "").replace(/\/bx_[a-z0-9]+/, "/{id}")}`];
    const r = route ? route(req) : { status: 404, json: { ok: false, code: "not_found", message: key } };
    return { status: r.status ?? 200, text: async () => JSON.stringify(r.json) };
  };
  return { fetch, calls };
}

function deps(fetch: FetchLike, extra: Partial<DashboardDeps> = {}): DashboardDeps & { published: number } {
  const d = {
    published: 0,
    client: async () => ({ api: new BoatApi(KEY, fetch, "https://boat.test/api/box/v1"), org: "team_1", ttlSeconds: 14_400 }),
    hosts: async () => [
      { id: "host_k58", name: "bx-run1", status: "connected", machineProviderId: "manual" },
      { id: "host_srv", name: "hub", status: "connected", machineProviderId: null },
    ],
    getResource: async () => null,
    publish: () => void d.published++,
    now: () => Date.parse("2026-10-04T10:00:00.000Z"),
    cacheMs: 0,
    ...extra,
  };
  return d;
}

describe("boat_overview", () => {
  it("returns boxes, wallet and snapshots with machine mapping and no secrets", async () => {
    const { fetch, calls } = boatServer();
    const h = createDashboardHandlers(deps(fetch));
    const o = await h.boat_overview();
    overviewDto.parse(o);
    const json = JSON.stringify(o);
    for (const v of [KEY, ...Object.values(SECRET_BITS), "sig=x"]) assert.ok(!json.includes(v), `leaked ${v}`);
    assert.equal(o.boxes.items!.length, 2);
    assert.deepEqual(o.boxes.items![0]!.machine, { hostId: "host_k58", name: "bx-run1", status: "connected", viaPlugin: false, phase: "active" });
    assert.equal(o.boxes.items![1]!.machine, null);
    assert.equal(o.wallet.items!.creditHours, 537.58);
    assert.deepEqual(o.wallet.items!.startsRemaining, { minute: 12, hour: 58, day: 196 });
    assert.equal(o.snapshots.items![0]!.name, "bb-boat-base-pilot-v4");
    assert.ok(calls.some((c) => c.url === "/api/box/v1/limits?org=team_1"), "limits read for the team org");
    assert.ok(calls.every((c) => c.headers.Authorization === `Bearer ${KEY}`));
  });
  it("maps plugin-created machines through their provider resource", async () => {
    const { fetch } = boatServer();
    const h = createDashboardHandlers(
      deps(fetch, {
        hosts: async () => [{ id: "host_p1", name: "bx-whatever", status: "suspended", machineProviderId: "boat" }],
        getResource: async () => ({ boxId: "bx_old1", key: "k", dirtyAtSuspend: {} }),
      }),
    );
    const o = await h.boat_overview();
    assert.equal(o.boxes.items!.find((b) => b.id === "bx_old1")!.machine!.viaPlugin, true);
  });
  it("shows partial data when one Boat call fails", async () => {
    const { fetch } = boatServer({ "GET /limits": () => ({ status: 403, json: { ok: false, code: "api_key_action_forbidden", message: "nope" } }) });
    const o = await createDashboardHandlers(deps(fetch)).boat_overview();
    assert.match(o.wallet.error!, /api_key_action_forbidden/);
    assert.equal(o.boxes.items!.length, 2);
  });
  it("reports setup instead of calling Boat when unconfigured", async () => {
    const { fetch, calls } = boatServer();
    const o = await createDashboardHandlers(deps(fetch, { client: async () => ({ error: "Set the Boat API key" }) })).boat_overview();
    assert.equal(o.configured, false);
    assert.equal(o.setupMessage, "Set the Boat API key");
    assert.equal(calls.length, 0);
  });
  it("caches within cacheMs (sidebar polling doesn't hammer Boat)", async () => {
    const { fetch, calls } = boatServer();
    const h = createDashboardHandlers(deps(fetch, { cacheMs: 15_000 }));
    await h.boat_overview();
    const n = calls.length;
    assert.deepEqual(await h.boat_summary(), { running: 1, total: 2 });
    assert.equal(calls.length, n);
  });
});

describe("box actions", () => {
  const box = (state: string) => () => ({ json: { ok: true, box: { id: "bx_run1", state, ...SECRET_BITS } } });

  it("resume: POSTs with the TTL and publishes a change", async () => {
    const { fetch, calls } = boatServer({ "GET /boxes/{id}": box("archived"), "POST /boxes/{id}/resume": () => ({ status: 202, json: { ok: true } }) });
    const d = deps(fetch);
    const r = await createDashboardHandlers(d).boat_resume({ boxId: "bx_run1", ttlHours: 2 });
    assert.equal(r.ok, true);
    assert.deepEqual(calls.at(-1)!.body, { ttlSeconds: 7200 });
    assert.equal(d.published, 1);
  });
  it("resume: refuses while stopping and when already live", async () => {
    for (const [state, re] of [["stopping", /still stopping/], ["idle", /already idle/]] as const) {
      const { fetch, calls } = boatServer({ "GET /boxes/{id}": box(state) });
      await assert.rejects(createDashboardHandlers(deps(fetch)).boat_resume({ boxId: "bx_run1" }), re);
      assert.ok(!calls.some((c) => c.method === "POST"));
    }
  });
  it("stop: only for live boxes", async () => {
    const { fetch, calls } = boatServer({ "GET /boxes/{id}": box("idle"), "POST /boxes/{id}/stop": () => ({ status: 202, json: { ok: true } }) });
    await createDashboardHandlers(deps(fetch)).boat_stop({ boxId: "bx_run1" });
    assert.equal(calls.at(-1)!.url, "/api/box/v1/boxes/bx_run1/stop");
    const s2 = boatServer({ "GET /boxes/{id}": box("archived") });
    await assert.rejects(createDashboardHandlers(deps(s2.fetch)).boat_stop({ boxId: "bx_run1" }), /not running/);
  });
  it("fork: uses the page's requestId as Idempotency-Key and returns only the new id", async () => {
    const { fetch, calls } = boatServer({
      "GET /boxes/{id}": box("idle"),
      "POST /boxes/{id}/fork": () => ({ status: 202, json: { ok: true, type: "box.forking", box: { id: "bx_new9", state: "provisioning", ...SECRET_BITS } } }),
    });
    const r = await createDashboardHandlers(deps(fetch)).boat_fork({ boxId: "bx_run1", ttlHours: 1, requestId: "3f1c9a52-8a6e-4c1e-9d0b-1a2b3c4d5e6f" });
    assert.equal(r.newBoxId, "bx_new9");
    const post = calls.at(-1)!;
    assert.equal(post.headers["Idempotency-Key"], "3f1c9a52-8a6e-4c1e-9d0b-1a2b3c4d5e6f");
    assert.deepEqual(post.body, { ttlSeconds: 3600 });
    assert.ok(!JSON.stringify(r).includes("10.9.8.7"));
  });
  it("set TTL: PATCHes ttlSeconds and returns the new deadline", async () => {
    const { fetch, calls } = boatServer({
      "PATCH /boxes/{id}": () => ({ json: { ok: true, box: { id: "bx_run1", state: "idle", archiveAfter: "2026-10-04T14:00:00.000Z" } } }),
    });
    const r = await createDashboardHandlers(deps(fetch)).boat_set_ttl({ boxId: "bx_run1", hours: 4 });
    assert.deepEqual(calls.at(-1)!.body, { ttlSeconds: 14_400 });
    assert.equal(r.archiveAfter, "2026-10-04T14:00:00.000Z");
  });
  it("save snapshot: POST /named-snapshots with box and name", async () => {
    const { fetch, calls } = boatServer({ "GET /boxes/{id}": box("idle"), "POST /named-snapshots": () => ({ status: 202, json: { ok: true } }) });
    await createDashboardHandlers(deps(fetch)).boat_save_snapshot({ boxId: "bx_run1", name: "bb-runner-template" });
    assert.deepEqual(calls.at(-1)!.body, { boxId: "bx_run1", name: "bb-runner-template" });
  });
});

describe("plugin wiring (fake host, global fetch stubbed)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  it("serves boat_overview over RPC with the configured key, without leaking it", async () => {
    const { fetch } = boatServer();
    globalThis.fetch = (async (url: string, init: never) => {
      const r = await fetch(url, init);
      return { status: r.status, text: r.text } as unknown as Response;
    }) as typeof globalThis.fetch;
    const { bb, harness } = createFakePluginHost({
      pluginId: "boat",
      settings: { apiKey: KEY, org: "team_1", from: "bb-template" },
      sdk: { hosts: { list: async () => [] } },
    });
    await plugin(bb);
    const o = (await harness.behavior.callRpc("boat_overview", null)) as { configured: boolean; boxes: { items: unknown[] } };
    assert.equal(o.configured, true);
    assert.equal(o.boxes.items.length, 2);
    const json = JSON.stringify(o);
    assert.ok(!json.includes(KEY) && !json.includes("10.9.8.7") && !json.includes("secret-sub"));
    await assert.rejects(harness.behavior.callRpc("boat_stop", { boxId: "bx_bad; rm -rf" }));
    await harness.lifecycle.dispose();
  });
});

describe("page helpers", () => {
  const now = Date.parse("2026-10-04T10:00:00.000Z");
  it("formats TTL, age, size, state and health", () => {
    assert.equal(ttlLabel("2026-10-04T11:05:00.000Z", now), "in 1h 05m");
    assert.equal(ttlLabel("2026-10-04T09:57:00.000Z", now), "overdue 3m");
    assert.equal(ttlLabel(null, now), "no auto-stop");
    assert.equal(ago("2026-10-04T09:30:00.000Z", now), "30m ago");
    assert.equal(bytes(12_000_000_000), "11 GB");
    assert.equal(stateBadge("archived").label, "stopped");
    assert.equal(stateBadge("archiving").tone, "busy");
    assert.equal(healthLabel("ok", "Restore incomplete: x").text, "restore incomplete");
  });
  it("offers actions by state (delete since T16, never while transitioning)", () => {
    const b = (state: string) => ({ id: "bx_1", name: null, state, type: null, archiveAfter: null, health: null, error: null, lastSnapshotStatus: null, snapshotCompletedAt: null, createdAt: null, machine: null, isBase: false, agentUpdates: null });
    assert.deepEqual(actionsFor(b("idle")), ["stop", "set-ttl", "fork-runner", "fork", "save-snapshot", "delete"]);
    assert.deepEqual(actionsFor(b("archived")), ["resume", "fork-runner", "fork", "set-ttl", "delete"]);
    assert.deepEqual(actionsFor(b("stopping")), []);
    assert.ok(ACTIONS.delete.destructiveTone);
  });
  it("warns about runner identity when forking a bb machine", () => {
    const withMachine = { id: "bx_1", name: "r", state: "idle", type: null, archiveAfter: null, health: null, error: null, lastSnapshotStatus: null, snapshotCompletedAt: null, createdAt: null, machine: { hostId: "h", name: "bx-1", status: "connected", viaPlugin: false, phase: "active" }, isBase: false, agentUpdates: null };
    assert.match(ACTIONS.fork.confirm(withMachine), /impersonate/);
  });
  it("validates dialog inputs", () => {
    assert.deepEqual(parseFields("set-ttl", { hours: "4" }), { hours: 4 });
    assert.match(parseFields("set-ttl", { hours: "0" }) as string, /0.25–720/);
    assert.match(parseFields("save-snapshot", { name: "Bad Name" }) as string, /lowercase/);
    assert.deepEqual(parseFields("stop", {}), {});
  });
});
