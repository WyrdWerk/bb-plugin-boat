import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { BoatApi } from "../src/boat-api.ts";
import { parseTmpCleanup, skillStoreCleanupScript } from "../src/boxprep.ts";
import { DEFAULT_RENAME_GATE, parseRenameProbe, renameGateStep, renameProbeCleanupScript, renameProbeScript } from "../src/fsgate.ts";
import { BoatMachineOps } from "../src/provider.ts";
import { memIntents } from "./helpers.ts";

const runIn = (home: string, script: string) =>
  execFileSync("bash", ["-c", script], { env: { HOME: home, PATH: process.env.PATH! }, encoding: "utf8" });
const onlyDirs = (home: string) => readdirSync(join(home, ".bb-machines"), { withFileTypes: true }).every((e) => e.isDirectory());

describe("rename probe script (T13), run for real", () => {
  it("create case: no data dir yet → probes ~/.bb-machines/.rename-probe; ok; cleanup removes it", () => {
    const home = mkdtempSync(join(tmpdir(), "fsprobe-"));
    const p = parseRenameProbe(runIn(home, renameProbeScript()));
    assert.equal(p.ok, true);
    assert.equal(p.where, "bb-machines");
    assert.ok(p.kio === null || Number.isInteger(p.kio), "count or unknown, never text");
    assert.deepEqual(readdirSync(join(home, ".bb-machines", ".rename-probe")), [], "attempt dirs removed");
    assert.ok(onlyDirs(home));
    runIn(home, renameProbeCleanupScript());
    assert.equal(existsSync(join(home, ".bb-machines", ".rename-probe")), false);
  });
  it("resume case: probes INSIDE the daemon's data dir (runtime/)", () => {
    const home = mkdtempSync(join(tmpdir(), "fsprobe-"));
    const runtime = join(home, ".bb-machines", "hub.example-tailnet.ts.net-3888", "runtime");
    mkdirSync(runtime, { recursive: true });
    const p = parseRenameProbe(runIn(home, renameProbeScript()));
    assert.equal(p.ok, true);
    assert.equal(p.where, "runtime");
    assert.ok(existsSync(join(runtime, ".bb-rename-probe")));
    runIn(home, renameProbeCleanupScript());
    assert.equal(existsSync(join(runtime, ".bb-rename-probe")), false);
  });
  it("reports a failing step as a code only", { skip: process.getuid?.() === 0 }, () => {
    const home = mkdtempSync(join(tmpdir(), "fsprobe-"));
    const area = join(home, ".bb-machines", ".rename-probe");
    mkdirSync(area, { recursive: true });
    chmodSync(area, 0o500); // can't create the attempt dir
    try {
      const out = runIn(home, renameProbeScript());
      const p = parseRenameProbe(out);
      assert.deepEqual([p.ok, p.err, p.step], [false, "EACCES", "mkdir"]);
      assert.ok(!out.includes(home), "no paths leave the box");
    } finally {
      chmodSync(area, 0o700);
    }
  });
});

describe("rename gate logic (T13)", () => {
  const ok = (kio: number | null) => ({ ok: true, err: null, step: null, where: "runtime" as const, kio, kioVda: kio });
  const fail = (kio: number | null) => ({ ok: false, err: "EIO", step: "rename", where: "runtime" as const, kio, kioVda: kio });
  const opts = { requiredOk: 3, timeoutMs: 60_000 };
  it("parses probe lines", () => {
    assert.deepEqual(parseRenameProbe("rename=fail err=EIO step=rename where=runtime kio=7 kio_vda=5\n"), {
      ok: false, err: "EIO", step: "rename", where: "runtime", kio: 7, kioVda: 5,
    });
    assert.deepEqual(parseRenameProbe("rename=ok where=bb-machines kio=unknown kio_vda=unknown\n"), {
      ok: true, err: null, step: null, where: "bb-machines", kio: null, kioVda: null,
    });
    assert.equal(parseRenameProbe("", 1).err, "NO_RESULT");
  });
  it("needs N consecutive OKs; a failure resets the streak", () => {
    let s = { consecutive: 0, lastKio: null as number | null };
    const seq = [ok(0), ok(0), fail(0), ok(0), ok(0), ok(0)];
    const done: boolean[] = [];
    for (const p of seq) {
      const r = renameGateStep(s, p, opts);
      s = r;
      done.push(r.done);
    }
    assert.deepEqual(done, [false, false, false, false, false, true]);
  });
  it("a growing kernel I/O error count resets the streak even if renames work", () => {
    let s = { consecutive: 0, lastKio: null as number | null };
    const out: [number, boolean][] = [];
    for (const p of [ok(4), ok(4), ok(6), ok(6), ok(6), ok(6)]) {
      const r = renameGateStep(s, p, opts);
      s = r;
      out.push([r.consecutive, r.kioGrew]);
    }
    assert.deepEqual(out, [[1, false], [2, false], [0, true], [1, false], [2, false], [3, false]]);
  });
  it("unknown kernel counts don't block", () => {
    let s = { consecutive: 0, lastKio: null as number | null };
    for (let i = 0; i < 3; i++) s = renameGateStep(s, ok(null), opts);
    assert.equal(s.consecutive, 3);
  });
  it("defaults: 6 in a row, 20 min", () => {
    assert.deepEqual(DEFAULT_RENAME_GATE, { requiredOk: 6, timeoutMs: 20 * 60_000 });
  });
});

describe("skill-store .tmp-* cleanup (T13 fix 2), run for real", () => {
  it("before bootstrap removes every .tmp-*; in the background only old ones", () => {
    const home = mkdtempSync(join(tmpdir(), "tmpclean-"));
    const store = join(home, ".bb-machines", "srv-3888", "runtime", "skill-store");
    const old = join(store, ".tmp-old");
    const fresh = join(store, ".tmp-fresh");
    mkdirSync(join(old, "content"), { recursive: true });
    mkdirSync(join(fresh, "content"), { recursive: true });
    const past = new Date(Date.now() - 30 * 60_000);
    utimesSync(old, past, past);
    assert.equal(parseTmpCleanup(runIn(home, skillStoreCleanupScript(10))), 1);
    assert.deepEqual([existsSync(old), existsSync(fresh)], [false, true]);
    assert.equal(parseTmpCleanup(runIn(home, skillStoreCleanupScript())), 1);
    assert.equal(existsSync(fresh), false);
  });
});

/** Fake box: the rename probe answers from a script of lines over calls. */
function box(probes: string[], cfg: Record<string, unknown> = {}) {
  let t = 0;
  let n = 0;
  const events: string[] = [];
  const api = {
    createBox: async () => ({ id: "bx_run8", state: "provisioning" }),
    getBox: async () => ({ id: "bx_run8", state: "idle", error: null }),
    setName: async () => {},
    writeFile: async () => {},
    runCommand: async (_id: string, cmd: string) => {
      const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" });
      if (cmd.includes("rename-probe-cleaned=")) return events.push("fs-clean"), ok("rename-probe-cleaned=1\n");
      if (cmd.includes('echo "rename=ok')) return events.push("fs"), ok(probes[Math.min(n++, probes.length - 1)]!);
      if (cmd.includes("BackendState")) return events.push("gate"), ok("ts=Running\ndns=yes\nhealth=200\n");
      if (cmd.includes("skill-store-cleaned=")) return events.push("clean"), ok("skill-store-cleaned=0 tmp-cleaned=2\n");
      if (cmd.includes("agent-env=")) return events.push("env"), ok("agent-env=ok vars=20 hash=aaaaaaaaaaaaaaaa changed=no restarted=0 claude=yes bws=yes\n");
      if (cmd.includes("runner-conversion=")) return ok("runner-conversion=ok\n");
      if (cmd.includes("identity=")) return ok("identity=kept\n");
      return ok("unit tailscale-rejoin Result=success ExecMainStartTimestampMonotonic=9 LoadState=loaded ActiveState=active\nensure=no\nagents=none\n");
    },
  };
  const progress: string[] = [];
  const ops = new BoatMachineOps({
    config: async () => ({ apiKey: "k", org: "o", source: "fork", from: "bx_base0001", type: "default", ttlSeconds: 3600, ...cfg }),
    api: () => api as unknown as BoatApi,
    bootstrap: async () => (events.push("bootstrap"), { hostId: "h" }),
    now: () => t,
    sleep: async (ms) => void (t += ms),
    intents: memIntents(),
    hubUrl: async () => "https://hub.example-tailnet.ts.net:3888",
  });
  const report = { step: (s: string) => void progress.push(`step: ${s}`), log: (s: string) => void progress.push(`log: ${s}`) };
  return { ops, events, progress, report, time: () => t };
}
const sig = new AbortController().signal;
const EIO = "rename=fail err=EIO step=rename where=runtime kio=5 kio_vda=5\n";
const OK = (kio: number) => `rename=ok where=runtime kio=${kio} kio_vda=${kio}\n`;

describe("disk-settled gate in create/resume (T13)", () => {
  it("waits through EIO, needs 6 OKs in a row, then fs → hub gate → cleanup → env → bootstrap", async () => {
    const b = box([EIO, EIO, OK(5), OK(5), OK(5), OK(5), OK(5), OK(5)]);
    await b.ops.create("run8", null, async () => {}, b.report, sig);
    const fsCount = b.events.filter((e) => e === "fs").length;
    assert.equal(fsCount, 8);
    const tail = b.events.slice(b.events.lastIndexOf("fs"));
    assert.deepEqual(tail, ["fs", "fs-clean", "gate", "clean", "env", "bootstrap"]);
    assert.ok(b.progress.includes("step: Waiting for Boat to finish restoring the disk (directory renames still fail: EIO; kernel I/O errors since boot: 5 (vda 5))"));
    assert.ok(b.progress.some((p) => /^log: Disk settled: directory renames work in the daemon's data dir \(6 in a row, no new kernel I\/O errors\) after 70 s; kernel I\/O errors since boot: 5 \(vda 5\); 2 unsettled probe\(s\) before$/.test(p)), b.progress.join("\n"));
    assert.ok(b.progress.includes("log: Removed 2 half-installed skill trees (.tmp-*) left by a failed rename"));
  });
  it("growing kernel I/O errors keep it waiting even when renames work", async () => {
    const b = box([OK(1), OK(2), OK(3), OK(3), OK(3), OK(3), OK(3), OK(3)]);
    await b.ops.create("run8b", null, async () => {}, b.report, sig);
    // kio 1 → 2 → 3 resets the streak twice; six clean samples then end at the 9th probe.
    assert.equal(b.events.filter((e) => e === "fs").length, 9);
    assert.ok(b.progress.some((p) => p.includes("renames work, but kernel I/O errors since boot: 2 (vda 2) and still increasing")));
  });
  it("times out with the last problem and never bootstraps", async () => {
    const b = box([EIO], { renameProbeTimeoutMs: 5 * 60_000 });
    await assert.rejects(
      b.ops.create("run8c", null, async () => {}, b.report, sig),
      /Boat is still restoring the disk after 5 min: last problem: EIO at rename in runtime; kernel I\/O errors since boot: 5 \(vda 5\); bb can't install skill trees until this settles/,
    );
    assert.ok(!b.events.includes("bootstrap"));
    assert.ok(b.events.includes("fs-clean"), "probe area cleaned on timeout too");
  });
  it("resume pays the same gate, in the same order", async () => {
    const b = box([EIO, OK(5), OK(5), OK(5), OK(5), OK(5), OK(5)]);
    await b.ops.resume("h", { boxId: "bx_run8", key: "run8", dirtyAtSuspend: {} }, async () => {}, b.report, sig);
    assert.deepEqual(b.events.slice(b.events.lastIndexOf("fs")), ["fs", "fs-clean", "gate", "clean", "env", "bootstrap"]);
    assert.equal(b.events.filter((e) => e === "fs").length, 7);
  });
});
