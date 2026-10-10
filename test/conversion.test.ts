import { strict as assert } from "node:assert";
import { memIntents, withPrep } from "./helpers.ts";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { BoatApi } from "../src/boat-api.ts";
import { parseConversionResult, runnerConversionCommand, runnerConversionScript, unpublishServeScript } from "../src/conversion.ts";
import { createDashboardHandlers } from "../src/dashboard.ts";
import { BoatMachineOps, type ProviderConfig } from "../src/provider.ts";
import { BB_RUNNER_GUARD_SH, RUNNER_ENSURE_SH } from "../src/runner-files.generated.ts";
import { actionsFor } from "../ui/actions.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoScripts = join(here, "..", "runner");

describe("runner conversion script (T6)", () => {
  const script = runnerConversionScript();

  it("embeds exactly the repo's runner-ensure files (run `npm run gen` after editing them)", () => {
    assert.equal(RUNNER_ENSURE_SH, readFileSync(join(repoScripts, "runner-ensure.sh"), "utf8"));
    assert.equal(BB_RUNNER_GUARD_SH, readFileSync(join(repoScripts, "bb-runner-guard.sh"), "utf8"));
  });

  it("is valid bash", () => {
    const f = join(mkdtempSync(join(tmpdir(), "conv-")), "c.sh");
    writeFileSync(f, script);
    execFileSync("bash", ["-n", f]); // throws on a syntax error
  });

  it("runs as root through passwordless sudo, as one bash -c argument", () => {
    const argv = runnerConversionCommand();
    assert.deepEqual(argv.slice(0, 4), ["sudo", "-n", "bash", "-c"]);
    assert.equal(argv.length, 5);
    assert.equal(argv[4], script);
  });

  it("orders the steps: block bb-app, neuter bb-ensure, serve off, runner-ensure, verify", () => {
    const at = (needle: string) => {
      const i = script.indexOf(needle);
      assert.ok(i >= 0, `missing: ${needle}`);
      return i;
    };
    const order = [
      "touch /etc/bb-runner-mode",
      "ConditionPathExists=!/etc/bb-runner-mode",
      "uctl disable --now bb-app.service",
      'chmod -x "$B"',
      "tailscale serve --https=443 off",
      "cat >/usr/local/sbin/runner-ensure.sh",
      "ExecStartPre=/usr/local/sbin/bb-runner-guard.sh",
      "systemctl enable bb-runner-ensure.service",
      "systemctl restart bb-runner-ensure.service",
      "fail port-38886-still-listening",
      "fail bb-app-still-enabled",
      "fail bb-server-still-on-tailnet",
      "fail runner-ensure-not-verified",
      'echo "runner-conversion=ok',
    ];
    const idx = order.map(at);
    assert.deepEqual([...idx].sort((a, b) => a - b), idx, "steps out of order");
  });

  it("never stamps the box itself (runner-ensure decides) and never dumps env or secrets", () => {
    // Outside the embedded runner-ensure.sh, nothing writes the stamp.
    assert.ok(!/boat-id/.test(script.replace(RUNNER_ENSURE_SH, "")));
    for (const bad of [/^\s*env\s*$/m, /^\s*export\s*$/m, /printenv/, /cat \/run\/ascii-secrets/, /tailscale status/, /set -x/]) {
      assert.ok(!bad.test(script.replace(RUNNER_ENSURE_SH, "")), `forbidden: ${bad}`);
    }
  });

  it("makes bb-ensure.sh a no-op in runner mode, idempotently", () => {
    const line = script.split("\n").find((l) => l.includes("sed -i '1a"));
    assert.ok(line);
    const dir = mkdtempSync(join(tmpdir(), "bbensure-"));
    const f = join(dir, "bb-ensure.sh");
    writeFileSync(f, "#!/usr/bin/env bash\necho starting bb-app\n");
    const run = () => execFileSync("bash", ["-c", `B=${f}\n${line}`]);
    run();
    run();
    const out = readFileSync(f, "utf8").split("\n");
    assert.equal(out[0], "#!/usr/bin/env bash");
    assert.equal(out[1], "[ -e /etc/bb-runner-mode ] && exit 0  # bb runner: own bb server stays off");
    assert.equal(out.filter((l) => l.includes("bb-runner-mode")).length, 1, "guard inserted once");
    // With the marker absent the original script still runs (reversible).
    assert.equal(execFileSync("bash", [f], { encoding: "utf8" }).trim(), "starting bb-app");
  });

  it("parses the one-line verdict", () => {
    assert.deepEqual(parseConversionResult("noise\nrunner-conversion=ok bb-app=inactive/disabled port38886=free serve=off runner-ensure=ok\n", 0), {
      ok: true,
      summary: "runner-conversion=ok bb-app=inactive/disabled port38886=free serve=off runner-ensure=ok",
    });
    assert.deepEqual(parseConversionResult("runner-conversion=failed reason=port-38886-still-listening\n", 1), {
      ok: false,
      reason: "port-38886-still-listening",
    });
    assert.equal(parseConversionResult("sudo: a password is required\n", 1).ok, false);
    assert.match((parseConversionResult("", 1) as { reason: string }).reason, /sudo -n refused/);
    assert.equal(parseConversionResult("runner-conversion=ok\n", 1).ok, false, "ok line with a nonzero exit is a failure");
  });
});

describe("conversion unpublishes the box's own bb server with a bounded retry (T19)", () => {
  // A concurrent pi-boot-init/bb-ensure.sh can re-publish between the off and the
  // verify. The unpublish must keep turning Serve off until `served` is false.
  function run(servedBody: string, attempts: number) {
    const dir = mkdtempSync(join(tmpdir(), "unpublish-"));
    const log = join(dir, "calls");
    const harness = [
      `servedCalls=0`,
      `served() { servedCalls=$((servedCalls+1)); ${servedBody}; }`,
      `timeout() { echo "$*" >>"${log}"; return 0; }`,
      "sleep() { :; }",
      unpublishServeScript(attempts),
      `echo "probes=$servedCalls"`,
    ].join("\n");
    const out = execFileSync("bash", ["-c", harness], { encoding: "utf8" });
    const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
    return { calls, probes: out.trim() };
  }

  it("retries serve off/reset until nothing is served, then stops", () => {
    // "still served" for the first two probes, then clear.
    const r = run("[ $servedCalls -le 2 ]", 15);
    assert.equal(r.probes, "probes=3", "stopped as soon as served was false");
    assert.equal(r.calls.length, 2, "one off and one reset");
    assert.match(r.calls[0]!, /tailscale serve --https=443 off/);
    assert.match(r.calls[1]!, /tailscale serve reset/);
  });

  it("is bounded: an unpublish that never clears stops after the attempt bound", () => {
    const r = run("true", 15);
    assert.equal(r.probes, "probes=30", "15 attempts × (off check + reset check)");
    assert.equal(r.calls.length, 30);
  });
});

describe("provider flow with conversion", () => {
  const config: ProviderConfig = { apiKey: "k", org: "o", source: "fork", from: "bx_base0001", type: "default", ttlSeconds: 3600 };
  function fake(opts: { forkId?: string; probes?: string[]; conversion?: { stdout: string; exitCode: number } }) {
    const events: string[] = [];
    const targets = new Set<string>();
    const markActive: string[] = [];
    let probe = 0;
    const api = {
      createBox: async () => ({ id: opts.forkId ?? "bx_new1", state: "provisioning" }),
      getBox: async (id: string) => ({ id, state: "ready", error: null }),
      writeFile: async () => {},
      runCommand: async (id: string, cmd: string) => {
        targets.add(id);
        if (cmd.includes("runner-conversion=")) {
          events.push("convert");
          return { exitCode: opts.conversion?.exitCode ?? 0, stdout: opts.conversion?.stdout ?? "runner-conversion=ok x\n", stderr: "" };
        }
        if (cmd.includes("identity=")) {
          events.push("guard");
          return { exitCode: 0, stdout: "identity=kept\n", stderr: "" };
        }
        const p = opts.probes ?? ["boot=done\nverified=no\nensure=no\n"];
        events.push(p[Math.min(probe++, p.length - 1)]!.startsWith("boot=pending") ? "probe:pending" : "probe");
        return { exitCode: 0, stdout: p[Math.min(probe - 1, p.length - 1)]!, stderr: "" };
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
      sleep: async (ms) => void (t += ms),
      markActive: async (hostId) => void markActive.push(hostId),
    });
    return { ops, events, targets, markActive };
  }
  const report = { step() {}, log() {} };
  const signal = new AbortController().signal;

  it("forks the base, waits for Boat's unit start, converts, then guard and bootstrap; never touches the base", async () => {
    const f = fake({ probes: ["boot=pending\nensure=no\n", "boot=pending\nensure=no\n", "boot=done\nensure=no\n", "boot=done\nensure=no\n", "boot=done\nensure=no\n"] });
    await f.ops.create("key-1", null, async () => {}, report, signal);
    const firstConvert = f.events.indexOf("convert");
    assert.ok(f.events.slice(0, firstConvert).includes("probe:pending"));
    assert.ok(f.events.slice(0, firstConvert).filter((e) => e === "probe").length >= 2, "two settled samples before converting");
    assert.deepEqual(f.events.slice(firstConvert), ["convert", "guard", "bootstrap"]);
    assert.deepEqual([...f.targets], ["bx_new1"], "only the new box receives commands");
  });

  it("fails create with the script's reason and skips guard and bootstrap", async () => {
    const f = fake({ conversion: { stdout: "runner-conversion=failed reason=port-38886-still-listening\n", exitCode: 1 } });
    await assert.rejects(f.ops.create("key-2", null, async () => {}, report, signal), /Runner conversion failed: port-38886-still-listening/);
    assert.ok(!f.events.includes("guard") && !f.events.includes("bootstrap"));
  });

  it("refuses to convert if Boat hands back the base box itself", async () => {
    const f = fake({ forkId: "bx_base0001" });
    await assert.rejects(f.ops.create("key-3", null, async () => {}, report, signal), /refusing to convert/);
    assert.equal(f.targets.size, 0);
  });

  it("re-runs the conversion on resume before guard and bootstrap", async () => {
    const f = fake({ probes: ["boot=done\nverified=yes\nensure=yes\n"] });
    await f.ops.resume("host_1", { boxId: "bx_new1", key: "k", dirtyAtSuspend: {} }, async () => {}, report, signal);
    assert.deepEqual(f.events.slice(-3), ["convert", "guard", "bootstrap"]);
  });

  it("marks the host active when resume completes, so the idle sweep does not suspend it at once", async () => {
    const f = fake({ probes: ["boot=done\nverified=yes\nensure=yes\n"] });
    await f.ops.resume("host_1", { boxId: "bx_new1", key: "k", dirtyAtSuspend: {} }, async () => {}, report, signal);
    assert.deepEqual(f.markActive, ["host_1"], "resume resets the idle clock exactly once, for this host");
  });
});

describe("base box protection on the Boat page", () => {
  function handlers(onCall: (method: string, path: string) => void) {
    const api = {
      getBox: async (id: string) => ({ id, state: "archived" }),
      resume: async () => onCall("POST", "resume"),
      stop: async () => onCall("POST", "stop"),
      setTtl: async () => (onCall("PATCH", "ttl"), { id: "x", state: "archived" }),
      saveNamedSnapshot: async () => onCall("POST", "snap"),
      createBox: async () => (onCall("POST", "fork"), { id: "bx_fork9", state: "provisioning" }),
    };
    return createDashboardHandlers({
      client: async () => ({ api: api as unknown as BoatApi, org: "o", ttlSeconds: 3600, baseBoxId: "bx_base0001" }),
      hosts: async () => [],
      getResource: async () => null,
      publish: () => {},
      now: () => 0,
    });
  }

  it("refuses resume, stop, set TTL and save snapshot on the base; allows fork", async () => {
    const calls: string[] = [];
    const h = handlers((m, p) => calls.push(`${m} ${p}`));
    await assert.rejects(h.boat_resume({ boxId: "bx_base0001" }), /base box/);
    await assert.rejects(h.boat_stop({ boxId: "bx_base0001" }), /base box/);
    await assert.rejects(h.boat_set_ttl({ boxId: "bx_base0001", hours: 2 }), /base box/);
    await assert.rejects(h.boat_save_snapshot({ boxId: "bx_base0001", name: "x-y" }), /base box/);
    assert.deepEqual(calls, []);
    const r = await h.boat_fork({ boxId: "bx_base0001", ttlHours: 1, requestId: "3f1c9a52-8a6e-4c1e-9d0b-1a2b3c4d5e6f" });
    assert.equal(r.newBoxId, "bx_fork9");
    await h.boat_resume({ boxId: "bx_other1" }); // other boxes unaffected
  });

  it("offers only the fork actions for the base in the UI", () => {
    const b = { id: "bx_base0001", name: "base-box", state: "archived", type: null, archiveAfter: null, health: null, error: null, lastSnapshotStatus: null, snapshotCompletedAt: null, createdAt: null, machine: null, isBase: true, agentUpdates: null };
    assert.deepEqual(actionsFor(b), ["fork-runner", "fork"]);
    assert.deepEqual(actionsFor({ ...b, state: "stopping" }), []);
  });
});
