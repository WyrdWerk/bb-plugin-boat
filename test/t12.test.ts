import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { BoatApi } from "../src/boat-api.ts";
import { AGENT_ENV_FILE, agentEnvScript, parseAgentEnv, parseSkillStoreCleanup, skillStoreCleanupScript } from "../src/boxprep.ts";
import { BoatMachineOps } from "../src/provider.ts";
import { RUNNER_ENSURE_SH } from "../src/runner-files.generated.ts";
import { memIntents } from "./helpers.ts";

describe("skill-store cleanup (T12 fix 1)", () => {
  it("deletes only EMPTY <hash> dirs, in every bb data dir, and reports the count", () => {
    const home = mkdtempSync(join(tmpdir(), "skillstore-"));
    const store = (server: string) => join(home, ".bb-machines", server, "runtime", "skill-store");
    const mk = (p: string) => mkdirSync(p, { recursive: true });
    mk(join(store("hub.example-tailnet.ts.net-3888"), "aaa-empty"));
    mk(join(store("hub.example-tailnet.ts.net-3888"), "bbb-healthy", "content"));
    writeFileSync(join(store("hub.example-tailnet.ts.net-3888"), "bbb-healthy", ".complete"), "");
    writeFileSync(join(store("hub.example-tailnet.ts.net-3888"), "bbb-healthy", ".last-used"), "");
    mk(join(store("other-host-443"), "ccc-empty"));
    const out = execFileSync("sh", ["-c", skillStoreCleanupScript()], { env: { HOME: home, PATH: process.env.PATH! }, encoding: "utf8" });
    assert.equal(parseSkillStoreCleanup(out), 2);
    assert.equal(existsSync(join(store("hub.example-tailnet.ts.net-3888"), "aaa-empty")), false);
    assert.equal(existsSync(join(store("other-host-443"), "ccc-empty")), false);
    assert.equal(existsSync(join(store("hub.example-tailnet.ts.net-3888"), "bbb-healthy", ".complete")), true, "healthy entry kept");
  });
  it("is a no-op on a fresh box", () => {
    const home = mkdtempSync(join(tmpdir(), "skillstore-"));
    assert.equal(parseSkillStoreCleanup(execFileSync("sh", ["-c", skillStoreCleanupScript()], { env: { HOME: home, PATH: process.env.PATH! }, encoding: "utf8" })), 0);
  });
});

describe("agent env script (T12 fix 2)", () => {
  const script = agentEnvScript(true);
  it("builds KEY=value lines without `export`, dropping unit-managed vars (real pipeline run)", () => {
    const dir = mkdtempSync(join(tmpdir(), "agentenv-"));
    const envSh = join(dir, "env.sh");
    const bws = join(dir, "bws-providers.sh");
    writeFileSync(envSh, ['export BOAT_ID="bx_abc123"', "# comment", 'export CLAUDE_CODE_OAUTH_TOKEN="placeholder-value-0"', 'export PATH="$PATH:/x"', "  export HOME=/home/user", "not an assignment"].join("\n"));
    writeFileSync(bws, ["OPENAI_API_KEY=placeholder-value-1", "export TS_AUTHKEY='placeholder-value-2'"].join("\n"));
    // The script's own loop + filter, pointed at the temp files.
    const start = script.indexOf("for s in ");
    const end = script.indexOf('>"$T"');
    const pipeline = script.slice(start, end).replace("/run/ascii-secrets/env.sh", envSh).replace("/run/ascii-secrets/bws-providers.sh", bws);
    const out = execFileSync("bash", ["-c", pipeline], { encoding: "utf8" });
    assert.deepEqual(out.trim().split("\n"), ['BOAT_ID="bx_abc123"', 'CLAUDE_CODE_OAUTH_TOKEN="placeholder-value-0"', "OPENAI_API_KEY=placeholder-value-1", "TS_AUTHKEY='placeholder-value-2'"]);
  });
  it("writes the file privately and atomically, installs the prefix drop-in, restarts only if changed", () => {
    for (const needle of [
      'install -d -m 0700 -o "$U" -g "$U" "$RUN"',
      'T=$(mktemp "$RUN/.agent-env.XXXXXX")',
      'chmod 600 "$T"',
      'chown "$U:$U" "$T"',
      'mv -f "$T" "$F"',
      `F=${AGENT_ENV_FILE}`,
      'D="$H/.config/systemd/user/bb-host-daemon-.service.d"',
      `printf '[Service]\\nEnvironmentFile=-%s\\n' "$F" >"$D/20-agent-env.conf"`,
      "uctl daemon-reload",
      'changed=$([ "$applied" = "$hash" ] && echo no || echo yes)',
      'if [ "$changed" = yes ] && [ 1 = 1 ]; then',
    ]) {
      assert.ok(script.includes(needle), `missing: ${needle}`);
    }
    assert.ok(script.indexOf('chmod 600 "$T"') < script.indexOf('>"$T"'), "private before any secret is written");
    assert.ok(agentEnvScript(false).includes('if [ "$changed" = yes ] && [ 0 = 1 ]; then'), "no-restart mode");
  });
  it("never prints values", () => {
    const echoes = script.split("\n").filter((l) => /\becho\b|printf/.test(l));
    for (const l of echoes) assert.ok(!/\$F"?\s*$|cat\s+"?\$F|\$\(cat "\$F"\)/.test(l), l);
    assert.ok(!/\bset -x\b|^\s*env\s*$|printenv/m.test(script));
    assert.match(script.split("\n").at(-1)!, /^echo "agent-env=ok vars=\$vars hash=\$hash changed=\$changed restarted=\$restarted claude=\$claude bws=\$bws"$/);
  });
  it("parses the result line", () => {
    assert.deepEqual(parseAgentEnv("agent-env=ok vars=31 hash=deadbeefdeadbeef changed=yes restarted=1 claude=yes bws=no\n", 0), {
      ok: true, vars: 31, hash: "deadbeefdeadbeef", changed: true, restarted: 1, claude: true, bws: false,
    });
    assert.equal(parseAgentEnv("sudo: a password is required\n", 1).ok, false);
    assert.match(parseAgentEnv("", 1).reason!, /sudo -n refused/);
  });
  it("runner-ensure keeps /run/bb-runner user-owned 0700 (it holds the agent env)", () => {
    assert.ok(RUNNER_ENSURE_SH.includes('install -d -m 0700 -o "$U" -g "$U" "$RUN"'));
    assert.ok(!RUNNER_ENSURE_SH.includes('chmod 755 "$RUN"'));
  });
});

/** Fake runner box recording the order of steps; prep answers configurable. */
function box(opts: { env?: (restart: boolean, n: number) => string; envExit?: number; busy?: () => number } = {}) {
  let t = 0;
  let envRuns = 0;
  const events: string[] = [];
  const api = {
    createBox: async () => ({ id: "bx_run6", state: "provisioning" }),
    getBox: async () => ({ id: "bx_run6", state: "idle", error: null }),
    setName: async () => {},
    writeFile: async () => {},
    runCommand: async (_id: string, cmd: string) => {
      const ok = (stdout: string, exitCode = 0) => ({ exitCode, stdout, stderr: "" });
      if (cmd.includes("rename-probe-cleaned=")) return ok("rename-probe-cleaned=1\n");
      if (cmd.includes('echo "rename=ok')) return events.push("fs"), ok("rename=ok where=runtime kio=3 kio_vda=3\n");
      if (cmd.includes("BackendState")) return events.push("gate"), ok("ts=Running\ndns=yes\nhealth=200\n");
      if (cmd.includes("skill-store-cleaned=")) return events.push("clean"), ok("skill-store-cleaned=1\n");
      if (cmd.includes("agent-env=")) {
        const restart = cmd.includes("[ 1 = 1 ]");
        events.push(`env(restart=${restart})`);
        return ok(opts.env?.(restart, ++envRuns) ?? "agent-env=ok vars=20 hash=aaaaaaaaaaaaaaaa changed=yes restarted=0 claude=yes bws=yes\n", opts.envExit ?? 0);
      }
      if (cmd.includes("runner-conversion=")) return events.push("convert"), ok("runner-conversion=ok\n");
      if (cmd.includes("identity=")) return events.push("guard"), ok("identity=kept\n");
      return ok("unit tailscale-rejoin Result=success ExecMainStartTimestampMonotonic=9 LoadState=loaded ActiveState=active\nensure=no\nagents=none\n");
    },
  };
  const logs: string[] = [];
  const progress: string[] = [];
  const bg = new AbortController();
  const ops = new BoatMachineOps({
    config: async () => ({ apiKey: "k", org: "o", source: "fork", from: "bx_base0001", type: "default", ttlSeconds: 3600 }),
    api: () => api as unknown as BoatApi,
    bootstrap: async () => (events.push("bootstrap"), { hostId: "host_run6" }),
    now: () => t,
    sleep: async (ms) => void (t += ms),
    intents: memIntents(),
    hubUrl: async () => "https://hub.example-tailnet.ts.net:3888",
    log: (m) => void logs.push(m),
    backgroundSignal: bg.signal,
    countBusyThreads: async () => opts.busy?.() ?? 0,
  });
  const report = { step: (s: string) => void progress.push(`step: ${s}`), log: (s: string) => void progress.push(`log: ${s}`) };
  return { ops, events, logs, progress, report, stop: () => bg.abort() };
}
const sig = new AbortController().signal;
const settle = async () => {
  for (let i = 0; i < 100; i++) await new Promise((r) => setImmediate(r));
};

describe("order before bootstrap (T12 fix 3)", () => {
  it("create: hub gate → skill-store cleanup → agent env (restart allowed) → bootstrap", async () => {
    const b = box();
    await b.ops.create("run6", null, async () => {}, b.report, sig);
    b.stop();
    const i = (e: string) => b.events.indexOf(e);
    assert.ok(i("gate") < i("clean") && i("clean") < i("env(restart=true)") && i("env(restart=true)") < i("bootstrap"), b.events.join(" "));
    assert.ok(b.progress.includes("log: Removed 1 empty skill-store entry left by a failed skill pull"));
    assert.ok(b.progress.includes("log: agent env: 20 vars, Claude token present, provider keys file present"));
  });
  it("resume: the same order", async () => {
    const b = box();
    await b.ops.resume("host_run6", { boxId: "bx_run6", key: "run6", dirtyAtSuspend: {} }, async () => {}, b.report, sig);
    b.stop();
    const tail = b.events.slice(b.events.indexOf("gate"));
    assert.deepEqual(tail.slice(0, 4), ["gate", "clean", "env(restart=true)", "bootstrap"]);
  });
  it("a failed agent env fails create before bootstrap, with the reason", async () => {
    const b = box({ env: () => "", envExit: 1 });
    await assert.rejects(b.ops.create("run6b", null, async () => {}, b.report, sig), /Agent env setup failed: exit 1 without a result line \(sudo -n refused\?\)/);
    assert.ok(!b.events.includes("bootstrap"));
    b.stop();
  });
});

describe("agent env refresh after enrollment (T12 fix 2, background)", () => {
  it("bws-providers.sh appears later: regenerates; restart deferred while a thread runs, then done when idle", async () => {
    let asked = 0;
    const b = box({
      // A thread is running for the first two checks, then the host is idle.
      busy: () => (++asked <= 2 ? 1 : 0),
      // create-time: no bws yet; later refreshes: content changed (bws now present)
      env: (restart, n) =>
        n === 1
          ? "agent-env=ok vars=10 hash=1111111111111111 changed=yes restarted=0 claude=yes bws=no\n"
          : `agent-env=ok vars=25 hash=2222222222222222 changed=yes restarted=${restart ? 1 : 0} claude=yes bws=yes\n`,
    });
    await b.ops.create("run6c", null, async () => {}, b.report, sig);
    await settle();
    b.stop();
    const deferred = b.logs.filter((l) => /agent env bx_run6: changed \(25 vars\); daemon restart deferred \(1 thread\(s\) running\)/.test(l));
    assert.equal(deferred.length, 2, b.logs.join("\n"));
    const restartedAt = b.logs.findIndex((l) => /restarted 1 daemon unit/.test(l));
    assert.ok(restartedAt > b.logs.indexOf(deferred[1]!), "restart only after the deferrals");
    assert.ok(b.logs.some((l) => /agent env bx_run6: changed \(25 vars, provider keys file present\); restarted 1 daemon unit\(s\)/.test(l)), b.logs.join("\n"));
    const restarts = b.events.filter((e) => e === "env(restart=true)").length;
    assert.equal(restarts, 2, "one at create, one after the host went idle");
    assert.ok(!b.logs.join("\n").includes("placeholder-value"));
  });
});
