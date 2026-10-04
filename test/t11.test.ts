import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { BoatApi } from "../src/boat-api.ts";
import { hubGateDecision, hubGateScript, parseHubGate, parseHubUrl } from "../src/hubgate.ts";
import { bootUnitState, parseSettleProbe, SETTLE_PROBE_SCRIPT } from "../src/policy.ts";
import { BoatMachineOps } from "../src/provider.ts";
import { memIntents, withPrep } from "./helpers.ts";

const HUB = "https://hub.example-tailnet.ts.net:3888";

describe("why T8's settle let enrollment run before Tailscale (T11 root cause)", () => {
  // systemd 255 on the boxes prints Service properties before Unit ones (T1 saw
  // `-p DropInPaths -p ActiveState -p NRestarts` come back as NRestarts, ActiveState, …),
  // whatever the -p order. With --value the names were gone.
  const valuesIn255Order = ["success", "0", "loaded", "inactive"]; // Result, ExecMainStart…, LoadState, ActiveState
  it("the old positional parse read Result as LoadState → every unit 'absent' → never pending", () => {
    const [load, active, result, start] = valuesIn255Order; // what the T8 code assumed
    assert.equal(bootUnitState(load!, active!, result!, start!), "absent");
  });
  it("the probe no longer uses --value and the parser reads fields by name, any order", () => {
    assert.ok(!/systemctl show[^\n]*--value/.test(SETTLE_PROBE_SCRIPT));
    const order255 = "unit tailscale-rejoin Result=success ExecMainStartTimestampMonotonic=0 LoadState=loaded ActiveState=inactive";
    const order259 = "unit tailscale-rejoin LoadState=loaded ActiveState=inactive Result=success ExecMainStartTimestampMonotonic=0";
    for (const line of [order255, order259]) {
      const s = parseSettleProbe(`${line}\n`, 0);
      assert.equal(s.bootUnits["tailscale-rejoin"], "notstarted");
      assert.equal(s.bootPending, true);
    }
  });
  it("an unreadable unit line fails closed (pending)", () => {
    const s = parseSettleProbe("unit tailscale-rejoin \n", 0);
    assert.equal(s.bootUnits["tailscale-rejoin"], "unknown");
    assert.equal(s.bootPending, true);
  });
});

describe("hub gate pieces (T11 fix 1)", () => {
  it("parses and validates the hub URL from bb", () => {
    assert.deepEqual(parseHubUrl(HUB), { base: HUB, host: "hub.example-tailnet.ts.net", health: `${HUB}/health` });
    assert.equal(parseHubUrl(`${HUB}/`).health, `${HUB}/health`);
    for (const bad of ["not a url", "ftp://h/x", "https://h'$(id)'.x", "https://u:p@h.x", "https://h.x/?q=1", "https://h.x/#f"]) {
      assert.throws(() => parseHubUrl(bad), Error, bad);
    }
  });
  it("script: quoted host/URL, only BackendState leaves the box, bounded curl", () => {
    const s = hubGateScript(parseHubUrl(HUB));
    assert.match(s, /getent hosts 'hub\.example-tailnet\.ts\.net'/);
    assert.match(s, /curl -sS -m 8 -o \/dev\/null -w '%\{http_code\}' 'https:\/\/hub\.example-tailnet\.ts\.net:3888\/health'/);
    assert.match(s, /grep -o '"BackendState": \*"\[A-Za-z\]\*"'/);
    assert.ok(!/echo "\$\(.*tailscale status/.test(s), "never echoes the status JSON");
  });
  it("names the failing check", () => {
    const t = parseHubUrl(HUB);
    const d = (ts: string, dns: boolean, health: string) => hubGateDecision({ tailscale: ts, dns, health }, t);
    assert.deepEqual(d("NeedsLogin", true, "200"), { ok: false, check: "tailscale", message: "Tailscale is not running on the box (BackendState=NeedsLogin)" });
    assert.deepEqual(d("none", false, "000"), { ok: false, check: "tailscale", message: "Tailscale is not running on the box (BackendState=none)" });
    assert.deepEqual(d("Running", false, "000"), { ok: false, check: "dns", message: "the hub name hub.example-tailnet.ts.net does not resolve on the box (MagicDNS)" });
    assert.deepEqual(d("Running", true, "000"), { ok: false, check: "health", message: `GET ${HUB}/health answered nothing (no connection)` });
    assert.deepEqual(d("Running", true, "503"), { ok: false, check: "health", message: `GET ${HUB}/health answered 503` });
    assert.deepEqual(d("Running", true, "200"), { ok: true });
    assert.deepEqual(parseHubGate("ts=Running\ndns=yes\nhealth=204\n"), { tailscale: "Running", dns: true, health: "204" });
  });
});

/** Fake base fork: the hub gate answers per (fake) time; everything else is quick. */
function box(gate: (t: number) => string, hubUrl: string | null = HUB) {
  let t = 0;
  const events: string[] = [];
  const api = {
    createBox: async () => ({ id: "bx_age443hg", state: "provisioning" }),
    getBox: async () => ({ id: "bx_age443hg", state: "idle", error: null }),
    setName: async () => {},
    writeFile: async () => {},
    runCommand: async (_id: string, cmd: string) => {
      if (cmd.includes("BackendState")) {
        events.push("gate");
        return { exitCode: 0, stdout: gate(t), stderr: "" };
      }
      if (cmd.includes("runner-conversion=")) return events.push("convert"), { exitCode: 0, stdout: "runner-conversion=ok\n", stderr: "" };
      if (cmd.includes("identity=")) return events.push("guard"), { exitCode: 0, stdout: "identity=kept\n", stderr: "" };
      return { exitCode: 0, stdout: "unit tailscale-rejoin Result=success ExecMainStartTimestampMonotonic=99 LoadState=loaded ActiveState=active\nensure=no\n", stderr: "" };
    },
  };
  const progress: string[] = [];
  const ops = new BoatMachineOps({
    config: async () => ({ apiKey: "k", org: "o", source: "fork", from: "bx_base0001", type: "default", ttlSeconds: 3600, renameProbeOk: 1 }), // disk gate not under test here
    api: () => withPrep(api) as unknown as BoatApi,
    bootstrap: async () => (events.push(`bootstrap@${Math.round(t / 1000)}s`), { hostId: "h" }),
    now: () => t,
    sleep: async (ms) => void (t += ms),
    intents: memIntents(),
    hubUrl: async () => hubUrl,
  });
  const report = { step: (s: string) => void progress.push(`step: ${s}`), log: (s: string) => void progress.push(`log: ${s}`) };
  return { ops, events, progress, report, time: () => t };
}
const sig = new AbortController().signal;

describe("hard hub gate before bootstrap (T11 fix 1)", () => {
  it("fails until Tailscale is Running, then waits for /health 200, then bootstraps", async () => {
    // The live case: join ~50 s in; health a little later.
    const b = box((t) => (t < 50_000 ? "ts=NeedsLogin\ndns=no\nhealth=000\n" : t < 70_000 ? "ts=Running\ndns=yes\nhealth=000\n" : "ts=Running\ndns=yes\nhealth=200\n"));
    await b.ops.create("boat-live-test-5", null, async () => {}, b.report, sig);
    const boot = b.events.find((e) => e.startsWith("bootstrap@"))!;
    assert.ok(Number(/@(\d+)s/.exec(boot)![1]) >= 70, `bootstrap only after health ok: ${boot}`);
    assert.ok(b.events.indexOf("guard") < b.events.indexOf("gate"), "gate right before bootstrap");
    assert.ok(b.progress.includes("step: Waiting for the box to reach the bb hub over Tailscale (hub.example-tailnet.ts.net)"));
    assert.ok(b.progress.includes("step: Waiting for the box to reach the bb hub over Tailscale: Tailscale is not running on the box (BackendState=NeedsLogin)"));
    assert.ok(b.progress.some((p) => p.includes("answered nothing (no connection)")));
    assert.ok(b.progress.some((p) => /^log: The box reaches the bb hub \(Tailscale up, hub.example-tailnet.ts.net resolves, \/health ok\) after \d+ s$/.test(p)));
  });
  for (const [name, out, re] of [
    ["tailscale", "ts=NeedsLogin\ndns=no\nhealth=000\n", /can't reach the bb hub after 6 min: Tailscale is not running on the box \(BackendState=NeedsLogin\) \[check: tailscale\]/],
    ["dns", "ts=Running\ndns=no\nhealth=000\n", /does not resolve on the box \(MagicDNS\) \[check: dns\]/],
    ["health", "ts=Running\ndns=yes\nhealth=502\n", /\/health answered 502 \[check: health\]/],
  ] as const) {
    it(`fails after 6 min naming the ${name} check, without bootstrapping`, async () => {
      const b = box(() => out);
      await assert.rejects(b.ops.create(`k-${name}`, null, async () => {}, b.report, sig), re);
      assert.ok(!b.events.some((e) => e.startsWith("bootstrap")));
      assert.ok(b.time() >= 6 * 60_000 && b.time() < 7 * 60_000);
    });
  }
  it("fails clearly when bb has no machine server URL", async () => {
    const b = box(() => "ts=Running\ndns=yes\nhealth=200\n", null);
    await assert.rejects(b.ops.create("k-url", null, async () => {}, b.report, sig), /bb has no machine server URL/);
  });
  it("also gates resume", async () => {
    const b = box((t) => (t < 30_000 ? "ts=Stopped\ndns=no\nhealth=000\n" : "ts=Running\ndns=yes\nhealth=200\n"));
    await b.ops.resume("h", { boxId: "bx_age443hg", key: "k", dirtyAtSuspend: {} }, async () => {}, b.report, sig);
    assert.ok(b.events.at(-1)!.startsWith("bootstrap@"));
    assert.ok(Number(/@(\d+)s/.exec(b.events.at(-1)!)![1]) >= 30);
  });
});
