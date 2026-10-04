import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { BoatApi, type FetchLike, limitsSchema } from "../src/boat-api.ts";
import { createDashboardHandlers } from "../src/dashboard.ts";

// Exact `starts` shape from `boat limits --json` on 2026-10-04 (owner's live run),
// which broke the wallet card with zod invalid_type at ["starts","unlimited"].
const LIVE_LIMITS = {
  ok: true,
  type: "limits.info",
  teamId: "team_1",
  canStart: true,
  accessTier: "standard",
  activeBoxes: 1,
  maxActiveBoxes: 100,
  creditBalanceSeconds: 1_935_288,
  starts: {
    day: { limit: 200, remaining: 198, used: 2 },
    hour: { limit: 60, remaining: 58, used: 2 },
    minute: { limit: 12, remaining: 12, used: 0 },
    unlimited: false,
  },
};

describe("limits schema (live shape, 2026-10-04)", () => {
  it("parses starts with a boolean `unlimited` beside the windows", () => {
    const l = limitsSchema.parse(LIVE_LIMITS);
    assert.equal(l.starts?.unlimited, false);
    assert.deepEqual(
      [l.starts?.minute?.remaining, l.starts?.hour?.remaining, l.starts?.day?.remaining],
      [12, 58, 198],
    );
  });
  it("survives unexpected fields and wrong types without failing the whole card", () => {
    const l = limitsSchema.parse({
      ...LIVE_LIMITS,
      creditBalanceSeconds: "lots",
      newField: { nested: [1, 2] },
      starts: { day: "n/a", hour: { remaining: "x", limit: 60 }, minute: { remaining: 3 }, unlimited: "nope", weekly: { remaining: 9 } },
    });
    assert.equal(l.creditBalanceSeconds, null);
    assert.equal(l.starts?.day, null);
    assert.equal(l.starts?.hour?.remaining, null);
    assert.equal(l.starts?.minute?.remaining, 3);
    assert.equal(l.starts?.unlimited, null);
    assert.equal(l.canStart, true);
  });
  it("renders the wallet section from the live shape (no section error)", async () => {
    const fetch: FetchLike = async (url) => {
      const path = new URL(url).pathname;
      const json = path.endsWith("/limits")
        ? LIVE_LIMITS
        : path.endsWith("/named-snapshots")
          ? { ok: true, namedSnapshots: [] }
          : { ok: true, boxes: [], pageInfo: { hasMore: false } };
      return { status: 200, text: async () => JSON.stringify(json) };
    };
    const h = createDashboardHandlers({
      client: async () => ({ api: new BoatApi("k", fetch, "https://b"), org: "team_1", ttlSeconds: 3600 }),
      hosts: async () => [],
      getResource: async () => null,
      publish: () => {},
      now: () => 0,
      cacheMs: 0,
    });
    const o = await h.boat_overview();
    assert.equal(o.wallet.error, null);
    assert.deepEqual(o.wallet.items!.startsRemaining, { minute: 12, hour: 58, day: 198 });
    assert.equal(o.wallet.items!.startsUnlimited, false);
    assert.ok(!("used" in (o.wallet.items as object)), "only whitelisted wallet fields reach the page");
  });
});
