import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { runnerConversionScript } from "../src/conversion.ts";
import { renameProbeScript } from "../src/fsgate.ts";
import { identityGuardScript, SETTLE_PROBE_SCRIPT } from "../src/policy.ts";
import { BB_RUNNER_GUARD_SH, RUNNER_ENSURE_SH } from "../src/runner-files.generated.ts";

const here = dirname(fileURLToPath(import.meta.url));
const scriptsDir = join(here, "..", "runner");

/**
 * Write targets in a shell script (redirections, touch, mv/cp/ln/install
 * destinations), with simple `NAME=value` assignments expanded. Heuristic, but
 * enough for the plugin's own scripts.
 */
export function writeTargets(script: string): string[] {
  const vars: Record<string, string> = { HOME: "~", H: "~" };
  const expand = (s: string): string => {
    let out = s.replace(/"/g, "");
    for (let i = 0; i < 5; i++) out = out.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, n: string) => vars[n] ?? m);
    return out;
  };
  const targets: string[] = [];
  for (const raw of script.split("\n")) {
    const line = raw.replace(/^\s*#.*$/, "");
    for (const m of line.matchAll(/(?:^|[\s;])([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|[^\s;]+)/g)) {
      // `H=$(getent passwd user | cut …)` is the user's home: keep the preset `~`.
      if (!m[2]!.includes("$(")) vars[m[1]!] = expand(m[2]!);
    }
    for (const seg of line.split(/;|&&|\|\||\|/)) {
      for (const m of seg.matchAll(/(?<![<>&0-9])>>?\s*("[^"]+"|[^\s;&|)]+)/g)) targets.push(expand(m[1]!));
      const words = seg.trim().split(/\s+/).filter((w) => !w.startsWith("-"));
      const cmd = words[0];
      if (cmd === "touch") targets.push(...words.slice(1).map(expand));
      if ((cmd === "mv" || cmd === "cp" || cmd === "ln" || cmd === "install") && words.length >= 3) targets.push(expand(words.at(-1)!));
    }
  }
  return targets;
}

const directChildOfBbMachines = (t: string) => /(?:^|\/)\.bb-machines\/[^/\s]+\/?$/.test(t) && !t.endsWith("/");

const SCRIPTS: Record<string, string> = {
  conversion: runnerConversionScript(),
  identityGuard: identityGuardScript("bx_abc123"),
  runnerEnsure: RUNNER_ENSURE_SH,
  daemonGuard: BB_RUNNER_GUARD_SH,
  settleProbe: SETTLE_PROBE_SCRIPT,
  renameProbe: renameProbeScript(),
  installSh: readFileSync(join(scriptsDir, "install.sh"), "utf8"),
  runnerModeSh: readFileSync(join(scriptsDir, "runner-mode.sh"), "utf8"),
};

describe("nothing but directories directly under ~/.bb-machines (T8)", () => {
  it("no generated or shipped script writes a file entry there", () => {
    for (const [name, script] of Object.entries(SCRIPTS)) {
      const bad = writeTargets(script).filter(directChildOfBbMachines);
      assert.deepEqual(bad, [], `${name} writes ${bad.join(", ")}`);
    }
  });
  it("the stamp is written under ~/.config/bb-runner", () => {
    assert.ok(writeTargets(SCRIPTS.identityGuard!).includes("~/.config/bb-runner/boat-id"));
    assert.ok(writeTargets(SCRIPTS.runnerEnsure!).includes("~/.config/bb-runner/boat-id"));
  });
  it("control: the pre-T8 identity guard IS flagged", () => {
    const old = ['R="$HOME/.bb-machines"; S="$R/.boat-id"', 'mkdir -p "$R" && echo "$ID" >"$S"'].join("\n");
    assert.deepEqual(writeTargets(old).filter(directChildOfBbMachines), ["~/.bb-machines/.boat-id"]);
  });
});

// ---------------------------------------------------------------------------
// Fix 2 (boot units) and fix 3 (agents-update marker).
import { agentsSummary } from "../ui/format.ts";
import type { BoatApi } from "../src/boat-api.ts";
import { bootUnitState, parseSettleProbe, settleDecision, unstartedBootUnits } from "../src/policy.ts";
import { BoatMachineOps, type ProviderConfig } from "../src/provider.ts";
import { memIntents, withPrep } from "./helpers.ts";

type U = "notstarted" | "running" | "done" | "failed" | "absent";
// KEY=VALUE in systemd 255's order (Service properties before Unit ones), the
// order that broke the pre-T11 positional parser on the boxes.
const unitLine = (name: string, st: U) => {
  const [load, active, result, start] = {
    notstarted: ["loaded", "inactive", "success", "0"],
    running: ["loaded", "activating", "success", "123456"],
    done: ["loaded", "active", "success", "123456"],
    failed: ["loaded", "failed", "exit-code", "123456"],
    absent: ["not-found", "inactive", "success", "0"],
  }[st];
  return `unit ${name} Result=${result} ExecMainStartTimestampMonotonic=${start} LoadState=${load} ActiveState=${active}`;
};
const probe = (pi: U, ts: U, au: U, marker: string | null = null) =>
  ["verified=no", "ensure=no", unitLine("pi-boot-init", pi), unitLine("tailscale-rejoin", ts), unitLine("agents-update", au), `agents=${marker ?? "none"}`].join("\n") + "\n";

describe("boot units: probe and decision (T8 fix 2)", () => {
  it("classifies systemctl show fields", () => {
    assert.equal(bootUnitState("loaded", "inactive", "success", "0"), "notstarted");
    assert.equal(bootUnitState("loaded", "activating", "success", "99"), "running");
    assert.equal(bootUnitState("loaded", "active", "success", "99"), "done");
    assert.equal(bootUnitState("loaded", "inactive", "success", "99"), "done", "oneshot without RemainAfterExit, finished");
    assert.equal(bootUnitState("loaded", "failed", "exit-code", "99"), "failed");
    assert.equal(bootUnitState("not-found", "inactive", "success", "0"), "absent");
  });
  it("probe script reports each boot unit and a sanitized agents marker", () => {
    assert.match(SETTLE_PROBE_SCRIPT, /for u in pi-boot-init tailscale-rejoin agents-update; do/);
    assert.match(SETTLE_PROBE_SCRIPT, /ExecMainStartTimestampMonotonic/);
    assert.match(SETTLE_PROBE_SCRIPT, /\/run\/user\/\$\(id -u\)\/agents-update\.done/);
    assert.match(SETTLE_PROBE_SCRIPT, /tr -cd "A-Za-z0-9=:._ \+-"/);
  });
  it("only tailscale-rejoin gates settling (T11); pi-boot-init and agents-update never do", () => {
    const s = parseSettleProbe(probe("done", "done", "notstarted"), 0);
    assert.equal(s.bootPending, false);
    assert.deepEqual(unstartedBootUnits(s), ["agents-update"]);
    assert.equal(parseSettleProbe(probe("running", "done", "done"), 0).bootPending, false, "pi-boot-init activating for minutes (live) doesn't block");
    assert.equal(parseSettleProbe(probe("done", "notstarted", "done"), 0).bootPending, true);
    assert.equal(parseSettleProbe(probe("done", "running", "done"), 0).bootPending, true);
    assert.equal(parseSettleProbe(probe("absent", "absent", "absent"), 0).bootPending, false, "boxes without these units");
  });
  it("a failed tailscale-rejoin fails settle with a clear reason; a failed pi-boot-init doesn't", () => {
    const d = settleDecision([parseSettleProbe(probe("done", "failed", "done"), 0)], 0);
    assert.equal(d.status, "failed");
    assert.match((d as { reason: string }).reason, /tailscale-rejoin\.service failed: without it the box has no Tailscale and can't reach the bb hub/);
    assert.notEqual(settleDecision([parseSettleProbe(probe("failed", "done", "done"), 0)], 0).status, "failed");
  });
  it("reads the agents marker", () => {
    assert.equal(parseSettleProbe(probe("done", "done", "done", "2026-10-04T11:40:00Z pi=ok codex=ok"), 0).agentsMarker, "2026-10-04T11:40:00Z pi=ok codex=ok");
    assert.equal(parseSettleProbe(probe("done", "done", "done"), 0).agentsMarker, null);
  });
});

/** Fake box whose probe output follows a script of states over (fake) time. */
function bootBox(opts: { timeline: (t: number, kicked: boolean) => string; kickExit?: number; conversion?: boolean }) {
  const events: string[] = [];
  let t = 0;
  let kicked = false;
  const api = {
    createBox: async () => ({ id: "bx_new1", state: "provisioning" }),
    getBox: async () => ({ id: "bx_new1", state: "ready", error: null }),
    setName: async () => {},
    writeFile: async () => {},
    runCommand: async (_id: string, cmd: string) => {
      if (cmd.includes("systemctl start --no-block")) {
        kicked = true;
        events.push(`kick@${Math.round(t / 1000)}s ${cmd.slice(cmd.indexOf("sudo"), cmd.indexOf(" </dev/null"))}`);
        return { exitCode: opts.kickExit ?? 0, stdout: "", stderr: "" };
      }
      if (cmd.includes("runner-conversion=")) {
        events.push("convert");
        return { exitCode: 0, stdout: "runner-conversion=ok\n", stderr: "" };
      }
      if (cmd.includes("identity=")) {
        events.push("guard");
        return { exitCode: 0, stdout: "identity=kept\n", stderr: "" };
      }
      events.push("probe");
      return { exitCode: 0, stdout: opts.timeline(t, kicked), stderr: "" };
    },
  };
  const logs: string[] = [];
  const seen: string[] = [];
  const make = (cfg: Partial<ProviderConfig> = {}, extra: Record<string, unknown> = {}) =>
    new BoatMachineOps({
      config: async () => ({ apiKey: "k", org: "o", source: "fork", from: "bx_base0001", type: "default", ttlSeconds: 3600, renameProbeOk: 1, ...cfg }),
      api: () => withPrep(api) as unknown as BoatApi,
      bootstrap: async () => {
        events.push("bootstrap");
        return { hostId: "h" };
      },
      now: () => t,
      sleep: async (ms) => void (t += ms),
      intents: memIntents(),
      log: (m) => void logs.push(m),
      onAgentUpdates: (_b, line) => void seen.push(line),
      ...extra,
    });
  return { make, events, logs, seen, time: () => t };
}
const reportInto = (lines: string[]) => ({ step: (s: string) => void lines.push(`step: ${s}`), log: (s: string) => void lines.push(`log: ${s}`) });
const sig = new AbortController().signal;

describe("settle starts boot units Boat skipped (T8 fix 2)", () => {
  it("waits ~2 min, starts all three once with sudo -n --no-block, waits for completion, then converts", async () => {
    const box = bootBox({
      timeline: (t, kicked) => (!kicked ? probe("notstarted", "notstarted", "notstarted") : t < 240_000 ? probe("running", "notstarted", "running") : probe("done", "done", "running")),
    });
    const progress: string[] = [];
    await box.make().create("k1", null, async () => {}, reportInto(progress), sig);
    const kicks = box.events.filter((e) => e.startsWith("kick@"));
    assert.equal(kicks.length, 1, "started once");
    assert.match(kicks[0]!, /^kick@12\ds sudo -n systemctl start --no-block pi-boot-init\.service tailscale-rejoin\.service agents-update\.service$/);
    assert.ok(box.events.indexOf(kicks[0]!) < box.events.indexOf("convert"));
    assert.deepEqual(box.events.slice(-3), ["convert", "guard", "bootstrap"]);
    assert.ok(progress.some((p) => /Boat had not started pi-boot-init\.service, tailscale-rejoin\.service, agents-update\.service 12\d s after ready; starting them/.test(p)));
  });
  it("does not start anything when Boat starts the units in time (~80 s, as on the base)", async () => {
    const box = bootBox({ timeline: (t) => (t < 80_000 ? probe("notstarted", "notstarted", "notstarted") : probe("done", "done", "running")) });
    await box.make().create("k2", null, async () => {}, reportInto([]), sig);
    assert.ok(!box.events.some((e) => e.startsWith("kick@")));
  });
  it("fails create clearly when a boot unit fails", async () => {
    const box = bootBox({ timeline: (_t, kicked) => (kicked ? probe("running", "failed", "done") : probe("notstarted", "notstarted", "notstarted")) });
    await assert.rejects(box.make().create("k3", null, async () => {}, reportInto([]), sig), /Box setup failed: boot unit tailscale-rejoin\.service failed/);
    assert.ok(!box.events.includes("convert"));
  });
  it("fails create clearly when the units can't be started", async () => {
    const box = bootBox({ kickExit: 1, timeline: () => probe("notstarted", "notstarted", "notstarted") });
    await assert.rejects(box.make().create("k4", null, async () => {}, reportInto([]), sig), /could not start pi-boot-init\.service, tailscale-rejoin\.service, agents-update\.service \(sudo -n systemctl exit 1\)/);
  });
  it("gives up with a timeout if they never finish", async () => {
    const box = bootBox({ timeline: () => probe("running", "running", "running") });
    await assert.rejects(box.make().create("k5", null, async () => {}, reportInto([]), sig), /Box did not settle: boot units not finished/);
  });
});

describe("agents-update marker (T8 fix 3)", () => {
  const MARK = "2026-10-04T11:40:00Z pi=ok codex=ok grok=ok hermes=ok opencode=ok bb=skipped";
  it("reports the marker when it is already there, without waiting", async () => {
    const box = bootBox({ timeline: () => probe("done", "done", "done", MARK) });
    const progress: string[] = [];
    await box.make().create("k6", null, async () => {}, reportInto(progress), sig);
    assert.ok(progress.includes(`log: Agent updates: ${MARK}`));
    assert.deepEqual(box.seen, [MARK]);
  });
  it("default (waitForAgentUpdates off): never blocks create on the marker", async () => {
    const box = bootBox({ timeline: () => probe("done", "done", "running") });
    const progress: string[] = [];
    await box.make().create("k7", null, async () => {}, reportInto(progress), sig);
    assert.ok(box.time() < 60_000, `create took ${box.time()} ms of fake time`);
    assert.ok(progress.some((p) => /Agent updates still running on the box/.test(p)));
  });
  it("waitForAgentUpdates on: waits for the marker before bootstrap", async () => {
    const box = bootBox({ timeline: (t) => probe("done", "done", t < 540_000 ? "running" : "done", t < 540_000 ? null : MARK) });
    const progress: string[] = [];
    await box.make({ waitForAgentUpdates: true }).create("k8", null, async () => {}, reportInto(progress), sig);
    const i = progress.findIndex((p) => p === `log: Agent updates: ${MARK}`);
    assert.ok(i >= 0);
    assert.ok(box.time() >= 540_000 && box.time() < 15 * 60_000 + 120_000);
    assert.equal(box.events.at(-1), "bootstrap");
  });
  it("waitForAgentUpdates on: bounded at 15 min, then continues (logged)", async () => {
    const box = bootBox({ timeline: () => probe("done", "done", "running") });
    const progress: string[] = [];
    await box.make({ waitForAgentUpdates: true }).create("k9", null, async () => {}, reportInto(progress), sig);
    assert.ok(progress.some((p) => /Agent updates not finished after 15 min; continuing/.test(p)));
    assert.equal(box.events.at(-1), "bootstrap");
  });
  it("background watch hands the marker to onAgentUpdates once it lands", async () => {
    let calls = 0;
    const box = bootBox({ timeline: () => (++calls > 6 ? probe("done", "done", "done", MARK) : probe("done", "done", "running")) });
    const bg = new AbortController();
    await box.make({}, { backgroundSignal: bg.signal }).create("k10", null, async () => {}, reportInto([]), sig);
    for (let i = 0; i < 50 && box.seen.length === 0; i++) await new Promise((r) => setImmediate(r));
    bg.abort();
    assert.deepEqual(box.seen, [MARK]);
    assert.ok(box.logs.some((l) => l === `agents bx_new1: ${MARK}`));
  });
  it("page summary", () => {
    assert.deepEqual(agentsSummary(MARK), { tone: "ok", text: "all ok (6)" });
    assert.deepEqual(agentsSummary("2026-10-04T11:40:00Z pi=ok codex=failed grok=ok"), { tone: "warn", text: "codex=failed" });
    assert.deepEqual(agentsSummary(null), { tone: "idle", text: "—" });
  });
});
