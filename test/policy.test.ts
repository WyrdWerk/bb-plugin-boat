import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import {
  runnerBoxName,
  assertBoxId,
  identityGuardScript,
  idempotencyKey,
  lifecycleDecision,
  machineName,
  parseSettleProbe,
  restoreProblem,
  type SettleSample,
  settleDecision,
} from "../src/policy.ts";

describe("naming", () => {
  it("is deterministic per creation key", () => {
    assert.equal(runnerBoxName("k1"), runnerBoxName("k1"));
    assert.notEqual(runnerBoxName("k1"), runnerBoxName("k2"));
    assert.match(runnerBoxName("k1"), /^bb-runner [0-9a-f]{12}$/);
  });
  it("derives a stable UUID-shaped idempotency key", () => {
    assert.equal(idempotencyKey("k1"), idempotencyKey("k1"));
    assert.match(idempotencyKey("k1"), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it("names machines like the Tailscale node", () => {
    assert.equal(machineName("bx_hngwmb8t"), "bx-hngwmb8t");
  });
  it("rejects anything that is not a box id", () => {
    assert.equal(assertBoxId("bx_abc123"), "bx_abc123");
    assert.throws(() => assertBoxId("bx_abc; rm -rf /"));
    assert.throws(() => identityGuardScript("$(id)"));
  });
});

describe("identity guard script (T1)", () => {
  /** `legacy`: stamp in the pre-T8 place (~/.bb-machines/.boat-id, broke bb's bootstrap). */
  function fakeHome(stamp: string | null, legacy = false) {
    const home = mkdtempSync(join(tmpdir(), "boat-guard-"));
    const server = join(home, ".bb-machines", "hub-3888");
    mkdirSync(server, { recursive: true });
    writeFileSync(join(server, "auth.json"), "{}");
    const stampPath = join(home, ".config", "bb-runner", "boat-id");
    const legacyPath = join(home, ".bb-machines", ".boat-id");
    if (stamp !== null) {
      if (legacy) writeFileSync(legacyPath, `${stamp}\n`);
      else {
        mkdirSync(dirname(stampPath), { recursive: true });
        writeFileSync(stampPath, `${stamp}\n`);
      }
    }
    return { home, auth: join(server, "auth.json"), stamp: stampPath, legacy: legacyPath };
  }
  /** bb core opens <entry>/auth.json for every entry: only directories may live there. */
  const onlyDirs = (home: string) =>
    readdirSync(join(home, ".bb-machines"), { withFileTypes: true }).every((e) => e.isDirectory());
  // Safety: this runs on the live bb hub. The script calls `systemctl --user` and
  // `pkill -f 'bb-app.* host-daemon'`, which would hit the hub's own daemon. PATH
  // holds only no-op stubs for those plus the coreutils the script needs.
  const bin = mkdtempSync(join(tmpdir(), "boat-guard-bin-"));
  for (const stub of ["systemctl", "pkill"]) {
    writeFileSync(join(bin, stub), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  for (const tool of ["cat", "find", "rm", "mkdir", "ls", "grep", "mv"]) {
    const real = execFileSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim();
    symlinkSync(real, join(bin, tool));
  }
  const run = (home: string, id: string) =>
    execFileSync("/bin/sh", ["-c", identityGuardScript(id)], {
      env: { HOME: home, PATH: bin },
      encoding: "utf8",
    }).trim();

  it("wipes an identity copied from another box and stamps this one", () => {
    const h = fakeHome("bx_source1");
    assert.match(run(h.home, "bx_fork1"), /identity=wiped/);
    assert.equal(existsSync(h.auth), false);
    assert.equal(readFileSync(h.stamp, "utf8").trim(), "bx_fork1");
    assert.ok(onlyDirs(h.home));
  });
  it("treats a missing stamp as foreign", () => {
    const h = fakeHome(null);
    assert.match(run(h.home, "bx_fork1"), /identity=wiped/);
    assert.equal(existsSync(h.auth), false);
  });
  it("keeps the identity on the box that made it (resume, retried create)", () => {
    const h = fakeHome("bx_same1");
    assert.match(run(h.home, "bx_same1"), /identity=kept/);
    assert.equal(existsSync(h.auth), true);
    assert.ok(onlyDirs(h.home));
  });
  it("migrates a legacy stamp out of ~/.bb-machines and keeps a matching identity (T8 resume bug)", () => {
    const h = fakeHome("bx_same1", true);
    assert.match(run(h.home, "bx_same1"), /identity=kept/);
    assert.equal(existsSync(h.legacy), false, "legacy stamp file removed");
    assert.equal(readFileSync(h.stamp, "utf8").trim(), "bx_same1");
    assert.equal(existsSync(h.auth), true);
    assert.ok(onlyDirs(h.home), "only directories under ~/.bb-machines");
  });
  it("migrates a foreign legacy stamp and still wipes the copied identity", () => {
    const h = fakeHome("bx_source1", true);
    assert.match(run(h.home, "bx_fork1"), /identity=wiped/);
    assert.equal(existsSync(h.legacy), false);
    assert.equal(readFileSync(h.stamp, "utf8").trim(), "bx_fork1");
    assert.ok(onlyDirs(h.home));
  });
});

describe("settle rule (T2)", () => {
  const s = (at: number, repos: Record<string, string[]>, verified = true, ensureInstalled = true): SettleSample => ({
    at,
    verified,
    ensureInstalled,
    ensureRunning: false,
    bootPending: false,
    bootUnits: {},
    agentsMarker: null,
    repos,
  });
  const opts = { stableForMs: 10_000, timeoutMs: 300_000 };

  it("parses the probe output", () => {
    const p = parseSettleProbe("verified=yes\nensure=yes\nrepo /h/c/repo 1 logs/a.log \nrepo /h/w/t/repo 0 \n", 5);
    assert.deepEqual(p, { at: 5, verified: true, ensureInstalled: true, ensureRunning: false, bootPending: false, bootUnits: {}, agentsMarker: null, repos: { "/h/c/repo": ["logs/a.log"], "/h/w/t/repo": [] } });
  });
  it("waits while Boat has not started the snapshot's units (boot=pending)", () => {
    const pending = { ...s(0, {}, false, false), bootPending: true };
    assert.equal(settleDecision([pending, { ...pending, at: 20_000 }], 0, opts).status, "wait");
    assert.equal(parseSettleProbe("boot=pending\n", 0).bootPending, true);
    assert.equal(parseSettleProbe("boot=done\n", 0).bootPending, false);
  });
  it("waits for Boat's reboot semantics (runner-ensure) first", () => {
    const d = settleDecision([s(0, {}, false)], 0, opts);
    assert.equal(d.status, "wait");
  });
  it("does not wait for runner-ensure where it is not installed", () => {
    const d = settleDecision([s(0, {}, false, false), s(10_000, {}, false, false)], 0, opts);
    assert.equal(d.status, "settled");
  });
  it("waits while a repo is dirty (the T2 case: one file for ~20 s)", () => {
    const d = settleDecision([s(0, { r: ["logs/notion-sync-latest.log"] })], 0, opts);
    assert.equal(d.status, "wait");
  });
  it("needs two clean samples at least stableForMs apart", () => {
    assert.equal(settleDecision([s(0, { r: [] })], 0, opts).status, "wait");
    assert.equal(settleDecision([s(0, { r: [] }), s(5_000, { r: [] })], 0, opts).status, "wait");
    assert.equal(settleDecision([s(0, { r: [] }), s(10_000, { r: [] })], 0, opts).status, "settled");
  });
  it("accepts the dirty set recorded at suspend", () => {
    const expected = { r: ["wip.txt"] };
    const d = settleDecision([s(0, { r: ["wip.txt"] }), s(12_000, { r: ["wip.txt"] })], 0, opts, expected);
    assert.equal(d.status, "settled");
  });
  it("reports a timeout instead of pretending", () => {
    const d = settleDecision([s(300_000, { r: ["x"] })], 0, opts);
    assert.equal(d.status, "timeout");
  });
  it("flags Boat's incomplete restores", () => {
    assert.match(
      restoreProblem("Restore incomplete: restore handed over with 0/0 image file(s) missing on machine x (GET failed: status code 504)") ?? "",
      /incomplete restore/,
    );
    assert.equal(restoreProblem(null), null);
    assert.equal(restoreProblem("something else"), null);
  });
});

describe("idle and pre-TTL policy", () => {
  const base = { now: 1_000_000_000, lastActiveAt: 1_000_000_000, idleMs: 15 * 60_000, archiveAfter: null, preTtlMarginMs: 15 * 60_000, busy: false };
  const iso = (ms: number) => new Date(ms).toISOString();
  it("does nothing for an active machine far from its TTL", () => {
    assert.equal(lifecycleDecision({ ...base, busy: true }), "none");
  });
  it("suspends after the idle window", () => {
    assert.equal(lifecycleDecision({ ...base, now: base.now + 16 * 60_000 }), "suspend-idle");
  });
  it("never idle-suspends when disabled", () => {
    assert.equal(lifecycleDecision({ ...base, idleMs: null, now: base.now + 10 * 3600_000 }), "none");
  });
  it("suspends before Boat's auto-stop when idle", () => {
    assert.equal(lifecycleDecision({ ...base, archiveAfter: iso(base.now + 10 * 60_000) }), "suspend-before-ttl");
  });
  it("extends the TTL instead when work is running", () => {
    assert.equal(lifecycleDecision({ ...base, busy: true, archiveAfter: iso(base.now + 10 * 60_000) }), "extend-ttl");
  });
});
