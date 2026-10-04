import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { BoatApi, type FetchLike } from "../src/boat-api.ts";
import { createDashboardHandlers, type DashboardHost, pendingBoxDeleteSweep } from "../src/dashboard.ts";
import { machineStuck } from "../src/machine-state.ts";
import { ACTIONS, actionsFor, parseFields } from "../ui/actions.ts";

type Call = { method: string; url: string; headers: Record<string, string> };

/** Fake Boat: the box exists until DELETE, then GET returns 404 (live behaviour, T7/T8). */
function boat() {
  const calls: Call[] = [];
  let deleted = false;
  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    calls.push({ method: init.method, url: u.pathname, headers: init.headers });
    const json = (status: number, body: unknown) => ({ status, text: async () => JSON.stringify(body) });
    if (init.method === "DELETE") return (deleted = true), json(202, { ok: true, deletionOperationId: "bdop_1" });
    if (u.pathname.includes("/deletion-operations/")) return json(200, { ok: true, status: "running" });
    if (u.pathname.startsWith("/boxes/")) {
      return deleted ? json(404, { ok: false, code: "not_found", message: "Box not found" }) : json(200, { ok: true, box: { id: u.pathname.split("/")[2], state: "archived" } });
    }
    return json(404, { ok: false, code: "not_found", message: u.pathname });
  };
  return { api: new BoatApi("k", fetch, "https://b"), calls };
}

function handlers(hosts: DashboardHost[], resource: Record<string, unknown> = {}) {
  const b = boat();
  const removed: string[] = [];
  const pending: [string, string][] = [];
  const h = createDashboardHandlers({
    client: async () => ({ api: b.api, org: "o", ttlSeconds: 3600, baseBoxId: "bx_base0001" }),
    hosts: async () => hosts,
    getResource: async (hostId) => resource[hostId] ?? null,
    publish: () => {},
    now: () => 0,
    removeHost: async (hostId) => void removed.push(hostId),
    setPendingBoxDelete: async (hostId, boxId) => void pending.push([hostId, boxId]),
  });
  return { h, calls: b.calls, removed, pending };
}

const PLUGIN_HOST: DashboardHost = { id: "host_hptz", name: "bx-hptzr6kt", status: "connected", machineProviderId: "boat", phase: "active" };
const MANUAL_HOST: DashboardHost = { id: "host_k58u", name: "bx-hngwmb8t", status: "connected", machineProviderId: "manual", phase: "active" };

describe("boat_delete (T16)", () => {
  it("refuses the base box even with a correct confirmation, before any call", async () => {
    const t = handlers([]);
    await assert.rejects(t.h.boat_delete({ boxId: "bx_base0001", confirmBoxId: "bx_base0001", mode: "box-only" }), /base box/);
    assert.deepEqual([t.calls.length, t.removed.length], [0, 0]);
  });
  it("refuses a confirmation that doesn't match exactly", async () => {
    const t = handlers([]);
    for (const typed of ["bx_hptzr6k", "BX_HPTZR6KT", "", "bx_other1"]) {
      await assert.rejects(t.h.boat_delete({ boxId: "bx_hptzr6kt", confirmBoxId: typed, mode: "box-only" }), /Confirmation does not match: type bx_hptzr6kt exactly/);
    }
    assert.deepEqual([t.calls.length, t.removed.length], [0, 0]);
  });
  it("machine-linked default (plugin machine): bb removes the machine; the provider deletes the box", async () => {
    const t = handlers([PLUGIN_HOST], { host_hptz: { boxId: "bx_hptzr6kt", key: "k", dirtyAtSuspend: {} } });
    const r = await t.h.boat_delete({ boxId: "bx_hptzr6kt", confirmBoxId: "bx_hptzr6kt", mode: "machine-and-box" });
    assert.deepEqual(t.removed, ["host_hptz"]);
    assert.ok(!t.calls.some((c) => c.method === "DELETE"), "no direct box delete: bb tears down environments first");
    assert.deepEqual(t.pending, []);
    assert.match(r.message, /bb tears down its environments, then this plugin deletes bx_hptzr6kt/);
  });
  it("machine-linked default (manual machine): bb removes the machine; box delete is queued until it's gone", async () => {
    const t = handlers([MANUAL_HOST]);
    const r = await t.h.boat_delete({ boxId: "bx_hngwmb8t", confirmBoxId: "bx_hngwmb8t", mode: "machine-and-box" });
    assert.deepEqual(t.removed, ["host_k58u"]);
    assert.deepEqual(t.pending, [["host_k58u", "bx_hngwmb8t"]]);
    assert.ok(!t.calls.some((c) => c.method === "DELETE"));
    assert.match(r.message, /bx_hngwmb8t is deleted once the machine is gone/);
  });
  it("box-only on an unlinked box: DELETE with the confirm header, done when the box 404s", async () => {
    const t = handlers([]);
    const r = await t.h.boat_delete({ boxId: "bx_lone1", confirmBoxId: "bx_lone1", mode: "box-only" });
    const del = t.calls.find((c) => c.method === "DELETE")!;
    assert.equal(del.url, "/boxes/bx_lone1");
    assert.equal(del.headers["X-Ascii-Confirm-Delete"], "bx_lone1");
    assert.equal(r.message, "Deleted bx_lone1");
    assert.deepEqual(t.removed, []);
  });
  it("box-only is refused while the linked machine is connected and healthy", async () => {
    const t = handlers([MANUAL_HOST]);
    await assert.rejects(t.h.boat_delete({ boxId: "bx_hngwmb8t", confirmBoxId: "bx_hngwmb8t", mode: "box-only" }), /which is connected: use "Remove machine and box"/);
    assert.ok(!t.calls.some((c) => c.method === "DELETE"));
  });
  it("box-only on a stuck machine (live: removing, Host is not connected): deletes the box, says the record stays", async () => {
    const stuck = { ...PLUGIN_HOST, status: "disconnected", phase: "removing" };
    const t = handlers([stuck], { host_hptz: { boxId: "bx_hptzr6kt", key: "k", dirtyAtSuspend: {} } });
    const r = await t.h.boat_delete({ boxId: "bx_hptzr6kt", confirmBoxId: "bx_hptzr6kt", mode: "box-only" });
    assert.ok(t.calls.some((c) => c.method === "DELETE" && c.url === "/boxes/bx_hptzr6kt"));
    assert.deepEqual(t.removed, []);
    assert.equal(r.message, "Deleted bx_hptzr6kt. bb machine bx-hptzr6kt stays (disconnected, removing) until bb can clean it up");
  });
});

describe("pending box deletes for manual machines (T16)", () => {
  function deps(gone: boolean, fail = false) {
    const log: string[] = [];
    const deleted: string[] = [];
    const cleared: string[] = [];
    return {
      log,
      deleted,
      cleared,
      d: {
        list: async () => [{ hostId: "host_k58u", boxId: "bx_hngwmb8t" }],
        hostGone: async () => gone,
        deleteBox: async (id: string) => {
          if (fail) throw new Error("boom");
          deleted.push(id);
        },
        clear: async (h: string) => void cleared.push(h),
        log: (m: string) => void log.push(m),
      },
    };
  }
  it("waits while bb is still removing the machine", async () => {
    const t = deps(false);
    assert.deepEqual(await pendingBoxDeleteSweep(t.d), []);
    assert.deepEqual(t.deleted, []);
  });
  it("deletes the box once the machine is gone, and clears the entry", async () => {
    const t = deps(true);
    assert.deepEqual(await pendingBoxDeleteSweep(t.d), ["bx_hngwmb8t"]);
    assert.deepEqual(t.cleared, ["host_k58u"]);
  });
  it("keeps the entry for the next minute if the delete fails", async () => {
    const t = deps(true, true);
    await pendingBoxDeleteSweep(t.d);
    assert.deepEqual(t.cleared, []);
    assert.match(t.log[0]!, /retrying next minute/);
  });
});

describe("Boat page delete actions (T16)", () => {
  const box = (over: Record<string, unknown> = {}) => ({
    id: "bx_hptzr6kt", name: "bb-runner abc", state: "archived", type: null, archiveAfter: null, health: null, error: null,
    lastSnapshotStatus: null, snapshotCompletedAt: null, createdAt: null, machine: null, isBase: false, agentUpdates: null, ...over,
  });
  const machine = (status: string, phase: string) => ({ hostId: "host_hptz", name: "bx-hptzr6kt", status, viaPlugin: true, phase });
  it("hides delete on the base box", () => {
    assert.ok(!actionsFor(box({ id: "bx_base0001", isBase: true })).some((a) => a.startsWith("delete")));
  });
  it("offers 'Delete box only' only when the linked machine is stuck", () => {
    assert.deepEqual(actionsFor(box({ machine: machine("connected", "active") })).filter((a) => a.startsWith("delete")), ["delete"]);
    assert.deepEqual(actionsFor(box({ machine: machine("disconnected", "removing") })).filter((a) => a.startsWith("delete")), ["delete", "delete-box-only"]);
    assert.equal(machineStuck({ status: "connected", phase: "cleanup-failed" }), true);
  });
  it("requires the exact box id to be typed", () => {
    const b = box();
    assert.equal(parseFields("delete", { confirm: "bx_hptzr6k" }, b), "Type bx_hptzr6kt exactly to confirm");
    assert.deepEqual(parseFields("delete", { confirm: " bx_hptzr6kt " }, b), { confirm: "bx_hptzr6kt" });
  });
  it("dialog copy: permanent, and names the machine when linked", () => {
    assert.match(ACTIONS.delete.confirm(box()), /^PERMANENT\. Deletes bx_hptzr6kt .*disk and its snapshots are gone for good/);
    assert.match(ACTIONS.delete.confirm(box({ machine: machine("connected", "active") })), /is bb machine bx-hptzr6kt\. This removes the machine in bb first/);
    assert.match(ACTIONS["delete-box-only"].confirm(box({ machine: machine("disconnected", "removing") })), /WITHOUT bb's cleanup.*record stays in bb/);
  });
});
