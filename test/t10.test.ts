import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { BoatApi, BoatApiError, canonicalCode, type FetchLike, notReadyYet } from "../src/boat-api.ts";
import { BoatExecutor } from "../src/executor.ts";

// T10: the API sent box_direct_failed/box_restoring; the boat CLI reports the same
// refusal as sandbox_direct_failed/sandbox_restoring (Boat is renaming box → sandbox).

async function errorFrom(status: number, body: unknown): Promise<unknown> {
  const fetch: FetchLike = async () => ({ status, text: async () => JSON.stringify(body) });
  try {
    await new BoatApi("k", fetch, "https://b").runCommand("bx_1", "true", 30);
  } catch (err) {
    return err;
  }
  throw new Error("expected an error");
}

describe("box → sandbox rename tolerance (T10)", () => {
  it("canonicalCode maps sandbox_* to box_* and nothing else", () => {
    assert.equal(canonicalCode("sandbox_direct_failed"), "box_direct_failed");
    assert.equal(canonicalCode("SANDBOX_STARTING"), "box_starting");
    assert.equal(canonicalCode("box_starting"), "box_starting");
    assert.equal(canonicalCode("machine_not_running"), "machine_not_running");
    assert.equal(canonicalCode("idempotency_in_progress"), "idempotency_in_progress");
  });

  it("restore refusal is retryable in both spellings and body shapes", async () => {
    const cases: [number, unknown][] = [
      [502, { ok: false, code: "box_direct_failed", message: "box_restoring" }], // API, seen live
      [502, { ok: false, code: "sandbox_direct_failed", error: "sandbox_restoring" }], // CLI shape
      [502, { ok: false, code: "sandbox_direct_failed", message: "sandbox_restoring" }],
      [502, { ok: false, code: "sandbox_direct_failed", message: "failed", error: { details: { reason: "sandbox_restoring" } } }],
      [502, { ok: false, error: { code: "sandbox_direct_failed", details: "sandbox_restoring" } }], // code nested
      [502, { ok: false, code: "box_direct_failed", message: "sandbox_restoring" }], // mixed
    ];
    for (const [status, body] of cases) assert.equal(notReadyYet(await errorFrom(status, body)), "box_restoring", JSON.stringify(body));
  });

  it("starting / not-running in both spellings", async () => {
    assert.equal(notReadyYet(await errorFrom(409, { ok: false, code: "sandbox_starting", message: "Sandbox is starting" })), "box_starting");
    assert.equal(notReadyYet(await errorFrom(409, { ok: false, code: "box_starting", message: "Box is starting" })), "box_starting");
    assert.equal(notReadyYet(await errorFrom(409, { ok: false, code: "machine_not_running", message: "x" })), "machine_not_running");
  });

  it("other direct failures stay non-retryable in both spellings", async () => {
    assert.equal(notReadyYet(await errorFrom(502, { ok: false, code: "sandbox_direct_failed", message: "EISDIR" })), null);
    assert.equal(notReadyYet(await errorFrom(502, { ok: false, code: "box_direct_failed", message: "EISDIR" })), null);
    assert.equal(notReadyYet(new BoatApiError(502, "sandbox_direct_failed", "sandbox_restoring_extra")), null, "whole word only");
  });

  it("executor retries the sandbox_* refusal like the box_* one", async () => {
    let runs = 0;
    const api = {
      runCommand: async () => {
        if (++runs <= 2) throw new BoatApiError(502, "sandbox_direct_failed", "failed", "sandbox_restoring");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    } as unknown as BoatApi;
    let t = 0;
    const reasons: string[] = [];
    const r = await new BoatExecutor(api, "bx_1", { now: () => t, sleep: async (ms) => void (t += ms), onNotReady: (why) => void reasons.push(why) }).exec({
      command: ["true"],
      stdin: "",
      timeoutMs: 30_000,
      signal: new AbortController().signal,
      onOutput: () => {},
    });
    assert.equal(r.exitCode, 0);
    assert.deepEqual(reasons, ["box_restoring", "box_restoring"]);
  });

  it("response wrappers accept sandbox/sandboxes", async () => {
    const fetch: FetchLike = async (url) => ({
      status: 200,
      text: async () =>
        JSON.stringify(
          url.includes("limit=")
            ? { ok: true, sandboxes: [{ id: "bx_a1", state: "idle" }], pageInfo: { hasMore: false } }
            : { ok: true, sandbox: { id: "bx_a1", state: "archived" } },
        ),
    });
    const api = new BoatApi("k", fetch, "https://b");
    assert.equal((await api.getBox("bx_a1"))?.state, "archived");
    assert.deepEqual((await api.listBoxes()).map((b) => b.id), ["bx_a1"]);
  });
});
