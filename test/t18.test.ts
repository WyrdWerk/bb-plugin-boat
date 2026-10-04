import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SAMPLE_PROJECTS as SEED_PROJECTS } from "./fixtures.ts";
import type { BoatApi } from "../src/boat-api.ts";
import { createDashboardHandlers } from "../src/dashboard.ts";
import { createRepoLister, parseGhRepoList, unavailableReason } from "../src/github-repos.ts";
import { ProjectStore } from "../src/project-store.ts";
import {
  cloneWaitDecision,
  manifestText,
  normalizeRemote,
  type Project,
  type ProjectLite,
  parseRepoProbe,
  planSources,
  repoProbeScript,
  SEED_PROJECTS as PLUGIN_SEED,
  validateRepoUrl,
  writeManifestScript,
} from "../src/projects.ts";
import { BoatMachineOps } from "../src/provider.ts";
import { checkRepoForm, filterRepos, repoNameFromUrl } from "../ui/projects-ui.ts";
import { memIntents, withPrep } from "./helpers.ts";

function memKv() {
  const m = new Map<string, unknown>();
  return { m, get: async <T>(k: string) => (m.has(k) ? (structuredClone(m.get(k)) as T) : undefined), set: async (k: string, v: unknown) => void m.set(k, structuredClone(v)) };
}

describe("repo URL rules (T18)", () => {
  it("accepts plain https GitHub URLs and canonicalizes to .git", () => {
    assert.deepEqual(validateRepoUrl("https://github.com/example-org/webapp"), { ok: true, url: "https://github.com/example-org/webapp.git" });
    assert.deepEqual(validateRepoUrl(" https://github.com/example-org/wiki.example.com.git "), { ok: true, url: "https://github.com/example-org/wiki.example.com.git" });
  });
  it("refuses credentials, other hosts, schemes and extra parts", () => {
    for (const bad of [
      "https://x-access-token:secret@github.com/example-org/a.git",
      "https://token@github.com/example-org/a.git",
      "http://github.com/example-org/a.git",
      "git@github.com:example-org/a.git",
      "https://gitlab.com/example-org/a.git",
      "https://github.com/example-org/a.git?x=1",
      "https://github.com/example-org/a/tree/main",
      "https://github.com:8443/example-org/a.git",
    ]) {
      assert.equal(validateRepoUrl(bad).ok, false, bad);
    }
  });
  it("the plugin seeds no projects; every sample repo URL validates", () => {
    assert.deepEqual(PLUGIN_SEED, []);
    for (const p of SEED_PROJECTS) for (const r of p.repos) assert.equal(validateRepoUrl(r.url).ok, true, r.url);
  });
});

describe("project store (T18)", () => {
  it("seeds once; deleting everything does not re-seed", async () => {
    const kv = memKv();
    const s = new ProjectStore(kv, SEED_PROJECTS);
    assert.equal((await s.list()).length, 8);
    for (const p of await s.list()) await s.delete(p.name, p.name);
    assert.deepEqual(await new ProjectStore(kv, SEED_PROJECTS).list(), []);
  });
  it("create / rename / delete with typed confirmation", async () => {
    const s = new ProjectStore(memKv(), SEED_PROJECTS);
    await s.create("New_Thing");
    assert.ok(await s.get("new_thing"));
    await assert.rejects(s.create("new_thing"), /already exists/);
    await assert.rejects(s.create("Bad Name!"), /lowercase letters/);
    await s.rename("new_thing", "renamed");
    assert.equal(await s.get("new_thing"), null);
    await assert.rejects(s.delete("renamed", "renamd"), /Confirmation does not match: type renamed exactly/);
    await s.delete("renamed", "renamed");
    assert.equal(await s.get("renamed"), null);
  });
  it("repo add / update / remove, with URL validation", async () => {
    const s = new ProjectStore(memKv(), SEED_PROJECTS);
    await s.addRepo("sandbox", { name: "side-repo", url: "https://github.com/example-org/side-repo", branch: "main" });
    assert.deepEqual((await s.get("sandbox"))!.repos.at(-1), { name: "side-repo", url: "https://github.com/example-org/side-repo.git", branch: "main" });
    await assert.rejects(s.addRepo("sandbox", { name: "x", url: "https://u:t@github.com/example-org/x.git" }), /must not contain credentials/);
    await assert.rejects(s.addRepo("sandbox", { name: "side-repo", url: "https://github.com/example-org/side-repo.git" }), /already has a repo/);
    await s.updateRepo("sandbox", "side-repo", { name: "heddle", url: "https://github.com/example-org/side-repo.git" });
    await s.removeRepo("sandbox", "heddle");
    assert.deepEqual((await s.get("sandbox"))!.repos.map((r) => r.name), ["shared-notes", "experiments"]);
  });
});

describe("manifest and repo probe on the runner (T18), run for real", () => {
  const project: Project = SEED_PROJECTS.find((p) => p.name === "sandbox")!;
  it("writes `name url` lines with a trailing newline", () => {
    const home = mkdtempSync(join(tmpdir(), "manifest-"));
    const out = execFileSync("bash", ["-c", writeManifestScript(project)], { env: { HOME: home, PATH: process.env.PATH! }, encoding: "utf8" });
    assert.match(out, /manifest-written=2/);
    const text = readFileSync(join(home, ".project-repos.txt"), "utf8");
    assert.equal(text, manifestText(project));
    assert.equal(text, "shared-notes https://github.com/example-org/shared-notes.git\nexperiments https://github.com/example-org/experiments.git\n");
  });
  it("probe reads an unterminated last line, reports clones, strips credentials", () => {
    const home = mkdtempSync(join(tmpdir(), "probe-"));
    writeFileSync(join(home, ".project-repos.txt"), "a https://github.com/example-org/a.git\nb https://x-access-token:SECRETVALUE@github.com/example-org/b.git");
    mkdirSync(join(home, "workspace", "repos", "a", ".git"), { recursive: true });
    const out = execFileSync("bash", ["-c", repoProbeScript()], { env: { HOME: home, PATH: process.env.PATH! }, encoding: "utf8" });
    assert.ok(!out.includes("SECRETVALUE"));
    assert.deepEqual(parseRepoProbe(out), {
      manifest: true,
      repos: [
        { name: "a", url: "https://github.com/example-org/a.git", cloned: true },
        { name: "b", url: "https://github.com/example-org/b.git", cloned: false },
      ],
    });
  });
  it("probe without a manifest", () => {
    const home = mkdtempSync(join(tmpdir(), "probe-"));
    assert.deepEqual(parseRepoProbe(execFileSync("bash", ["-c", repoProbeScript()], { env: { HOME: home, PATH: process.env.PATH! }, encoding: "utf8" })), { manifest: false, repos: [] });
  });
});

describe("wait, remote matching, source plan (T18)", () => {
  const project: Project = { name: "webapp", repos: [{ name: "webapp", url: "https://github.com/example-org/webapp.git" }, { name: "shared-notes", url: "https://github.com/example-org/shared-notes.git" }] };
  it("wait: progress n/m, done, timeout naming missing repos", () => {
    const probe = (a: boolean, b: boolean) => ({ manifest: true, repos: [{ name: "webapp", url: "u", cloned: a }, { name: "shared-notes", url: "u", cloned: b }] });
    assert.deepEqual(cloneWaitDecision(probe(true, false), project, 0, 600_000), { status: "wait", progress: "Cloning webapp repos (1/2)" });
    assert.equal(cloneWaitDecision(probe(true, true), project, 0, 600_000).status, "done");
    assert.deepEqual(cloneWaitDecision(probe(true, false), project, 600_000, 600_000), { status: "timeout", reason: "missing repos: shared-notes" });
    assert.deepEqual(cloneWaitDecision({ manifest: false, repos: [] }, project, 600_000, 600_000), { status: "timeout", reason: "~/.project-repos.txt is missing on the box" });
  });
  it("normalizes remotes for matching", () => {
    const want = "github.com/example-org/webapp";
    for (const u of ["https://github.com/example-org/webapp.git", "https://github.com/EXAMPLE-ORG/webapp/", "git@github.com:example-org/webapp.git", "ssh://git@github.com/example-org/webapp.git", "https://x:y@github.com/example-org/webapp"]) {
      assert.equal(normalizeRemote(u), want, u);
    }
    assert.equal(normalizeRemote(null), null);
  });
  it("plans add / present / unmatched / create / ambiguous", () => {
    const repos = [
      { name: "webapp", url: "https://github.com/example-org/webapp.git", cloned: true },
      { name: "shared-notes", url: "https://github.com/example-org/shared-notes.git", cloned: true },
      { name: "orphan", url: "https://github.com/example-org/orphan.git", cloned: true },
      { name: "twin", url: "https://github.com/example-org/twin.git", cloned: true },
    ];
    const projects: ProjectLite[] = [
      { id: "p1", name: "webapp", gitRemoteUrl: "git@github.com:example-org/webapp.git", sources: [] },
      { id: "p2", name: "shared-notes", gitRemoteUrl: "https://github.com/example-org/shared-notes", sources: [{ hostId: "host_r", path: "/home/user/x/amh" }] },
      { id: "p3", name: "twin-a", gitRemoteUrl: "https://github.com/example-org/twin.git", sources: [] },
      { id: "p4", name: "twin-b", gitRemoteUrl: "https://github.com/example-org/twin", sources: [] },
    ];
    assert.deepEqual(planSources(repos, projects, "host_r", false).map((a) => a.kind), ["add", "present", "unmatched", "ambiguous"]);
    assert.deepEqual(planSources(repos, projects, "host_r", true)[2], { kind: "create", repo: "orphan", path: "/home/user/workspace/repos/orphan" });
    assert.deepEqual(planSources(repos, projects, "host_r", false)[0], { kind: "add", repo: "webapp", projectId: "p1", projectName: "webapp", path: "/home/user/workspace/repos/webapp" });
  });
});

/** Fake runner for the provider flow: clones "arrive" over fake time. */
function runner(opts: { cloneDoneAtMs: number; projects?: ProjectLite[]; repos?: Project["repos"] }) {
  let t = 0;
  const events: string[] = [];
  const project: Project = { name: "webapp", repos: opts.repos ?? SEED_PROJECTS[0]!.repos };
  const api = withPrep({
    createBox: async () => ({ id: "bx_proj1", state: "provisioning" }),
    getBox: async () => ({ id: "bx_proj1", state: "idle", error: null }),
    setName: async (_id: string, name: string) => void events.push(`rename ${name}`),
    writeFile: async () => {},
    runCommand: async (_id: string, cmd: string) => {
      const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" });
      if (cmd.includes("manifest-written=")) return events.push("write-manifest"), ok("manifest-written=2\n");
      if (cmd.includes("project-repos.service")) return events.push("start-sync"), ok("");
      if (cmd.includes("manifest=present")) {
        events.push("probe");
        const done = t >= opts.cloneDoneAtMs;
        return ok(`manifest=present\n${project.repos.map((r, i) => `repo ${done || i === 0 ? "ok" : "missing"} ${r.name} ${r.url}`).join("\n")}\n`);
      }
      if (cmd.includes("rename-probe-cleaned=")) return ok("rename-probe-cleaned=1\n");
      if (cmd.includes('echo "rename=ok')) return ok("rename=ok where=bb-machines kio=0 kio_vda=0\n");
      if (cmd.includes("BackendState")) return ok("ts=Running\ndns=yes\nhealth=200\n");
      if (cmd.includes("runner-conversion=")) return ok("runner-conversion=ok\n");
      if (cmd.includes("identity=")) return ok("identity=kept\n");
      return ok("unit tailscale-rejoin Result=success ExecMainStartTimestampMonotonic=9 LoadState=loaded ActiveState=active\nensure=no\nagents=none\n");
    },
  });
  const added: string[] = [];
  const progress: string[] = [];
  const ops = new BoatMachineOps({
    config: async () => ({ apiKey: "k", org: "o", source: "fork", from: "bx_base0001", type: "default", ttlSeconds: 3600, renameProbeOk: 1 }),
    api: () => api as unknown as BoatApi,
    bootstrap: async () => (events.push("bootstrap"), { hostId: "host_proj1" }),
    now: () => t,
    sleep: async (ms) => void (t += ms),
    intents: memIntents(),
    hubUrl: async () => "https://hub.example-tailnet.ts.net:3888",
    getProject: async (n) => (n === "webapp" ? project : n === "empty" ? { name: "empty", repos: [] } : null),
    listProjects: async () => opts.projects ?? [{ id: "p1", name: "webapp", gitRemoteUrl: "https://github.com/example-org/webapp.git", sources: [] }],
    addProjectSource: async ({ projectId, hostId, path }) => void (added.push(`${projectId}@${hostId}:${path}`), events.push("add-source")),
  });
  const report = { step: (s: string) => void progress.push(`step: ${s}`), log: (s: string) => void progress.push(`log: ${s}`) };
  return { ops, events, added, progress, report };
}
const sig = new AbortController().signal;

describe("provider: project runner create / resume (T18)", () => {
  it("after enrollment: write manifest → start sync → wait for clones → register sources; no proj- rename", async () => {
    const r = runner({ cloneDoneAtMs: 30_000 });
    const out = await r.ops.create("k1", { project: "webapp" }, async () => {}, r.report, sig);
    const tail = r.events.slice(r.events.indexOf("bootstrap"));
    assert.deepEqual(tail.slice(0, 3), ["bootstrap", "write-manifest", "start-sync"]);
    assert.equal(tail.at(-1), "add-source");
    assert.ok(!r.events.some((e) => e.startsWith("rename proj-")), "box is not renamed proj-*");
    assert.ok(r.events.some((e) => e.startsWith("rename bb-runner ")));
    assert.deepEqual(r.added, ["p1@host_proj1:/home/user/workspace/repos/webapp"]);
    assert.ok(r.progress.includes("step: Cloning webapp repos (1/2)"));
    assert.ok(r.progress.some((p) => /repo shared-notes: no bb project with remote/.test(p)));
    assert.equal(out.resource.project, "webapp");
  });
  it("fails clearly naming missing repos after 10 min", async () => {
    const r = runner({ cloneDoneAtMs: Number.POSITIVE_INFINITY });
    await assert.rejects(r.ops.create("k2", { project: "webapp" }, async () => {}, r.report, sig), /Cloning webapp repos did not finish in 10 min: missing repos: shared-notes/);
  });
  it("refuses unknown or empty projects before allocating a box", async () => {
    const r = runner({ cloneDoneAtMs: 0 });
    await assert.rejects(r.ops.create("k3", { project: "nope" }, async () => {}, r.report, sig), /Unknown project "nope"/);
    await assert.rejects(r.ops.create("k4", { project: "empty" }, async () => {}, r.report, sig), /has no repos yet/);
    assert.deepEqual(r.events, []);
  });
  it("resume: no clone; verifies repos and re-adds missing sources", async () => {
    const r = runner({ cloneDoneAtMs: 0 });
    await r.ops.resume("host_proj1", { boxId: "bx_proj1", key: "k", project: "webapp" }, async () => {}, r.report, sig);
    assert.ok(!r.events.includes("write-manifest") && !r.events.includes("start-sync"));
    assert.deepEqual(r.added, ["p1@host_proj1:/home/user/workspace/repos/webapp"]);
  });
  it("resume: a missing repo fails clearly", async () => {
    const r = runner({ cloneDoneAtMs: Number.POSITIVE_INFINITY });
    await assert.rejects(r.ops.resume("host_proj1", { boxId: "bx_proj1", key: "k", project: "webapp" }, async () => {}, r.report, sig), /repos missing on bx_proj1 after resume: shared-notes/);
  });
});

describe("repo picker: gh repo list (T18 add-on)", () => {
  const GH = JSON.stringify([
    { name: "webapp", url: "https://github.com/example-org/webapp", isPrivate: true, defaultBranchRef: { name: "main" } },
    { name: "shared-notes", url: "https://x-access-token:abc@github.com/example-org/shared-notes", isPrivate: false, defaultBranchRef: null },
  ]);
  it("parses, strips credentials, sorts", async () => {
    let calls = 0;
    const list = createRepoLister({ owners: async () => ["example-org"], now: () => 0, runGh: async (args) => (calls++, assert.deepEqual(args, ["repo", "list", "example-org", "--limit", "300", "--json", "name,url,isPrivate,defaultBranchRef"]), { code: 0, stdout: GH, stderr: "" }) });
    const r = await list();
    assert.equal(r.status, "ok");
    if (r.status !== "ok") return;
    assert.deepEqual(r.repos.map((x) => [x.name, x.url, x.isPrivate, x.defaultBranch]), [
      ["shared-notes", "https://github.com/example-org/shared-notes", false, null],
      ["webapp", "https://github.com/example-org/webapp", true, "main"],
    ]);
    assert.ok(!JSON.stringify(r).includes("abc"));
    assert.equal(calls, 1);
  });
  it("caches ~10 min; refresh forces", async () => {
    let t = 0;
    let calls = 0;
    const list = createRepoLister({ owners: async () => ["example-org"], now: () => t, runGh: async () => (calls++, { code: 0, stdout: GH, stderr: "" }) });
    await list();
    t = 5 * 60_000;
    const again = await list();
    assert.equal(again.status === "ok" && again.cached, true);
    await list(true);
    t = 16 * 60_000;
    await list();
    assert.equal(calls, 3);
  });
  it("unavailable: gh missing, not logged in, garbage output, no owners", async () => {
    const enoent = Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
    assert.deepEqual(await createRepoLister({ owners: async () => ["example-org"], now: () => 0, runGh: async () => { throw enoent; } })(), { status: "unavailable", reason: "gh is not installed on the bb server" });
    assert.deepEqual(await createRepoLister({ owners: async () => ["example-org"], now: () => 0, runGh: async () => ({ code: 4, stdout: "", stderr: "To get started with GitHub CLI, please run:  gh auth login" }) })(), {
      status: "unavailable",
      reason: "gh on the bb server is not logged in (run `gh auth login` there)",
    });
    assert.equal((await createRepoLister({ owners: async () => ["example-org"], now: () => 0, runGh: async () => ({ code: 0, stdout: "not json", stderr: "" }) })()).status, "unavailable");
    assert.equal((await createRepoLister({ owners: async () => ["bad owner!"], now: () => 0, runGh: async () => ({ code: 0, stdout: "[]", stderr: "" }) })()).status, "unavailable");
    assert.equal(unavailableReason(null, "HTTP 401: Bad credentials"), "gh on the bb server is not logged in (run `gh auth login` there)");
    assert.deepEqual(parseGhRepoList("o", "[]"), []);
  });
});

describe("Projects RPCs and dialog helpers (T18)", () => {
  function h() {
    return createDashboardHandlers({
      client: async () => ({ error: "unconfigured" }),
      hosts: async () => [],
      getResource: async () => null,
      publish: () => {},
      now: () => 0,
      projectStore: new ProjectStore(memKv(), SEED_PROJECTS),
    });
  }
  it("lists the seeded projects; machine defaults offer their names", async () => {
    const x = h();
    assert.equal((await x.projects_list()).projects.length, 8);
    assert.deepEqual((await x.boat_machine_defaults()).projects.slice(0, 2), ["webapp", "sites"]);
  });
  it("edits through the RPCs and rejects credential URLs", async () => {
    const x = h();
    await x.project_create({ name: "lab" });
    const p = await x.project_repo_add({ project: "lab", repo: { name: "webapp", url: "https://github.com/example-org/webapp" } });
    assert.deepEqual(p.repos, [{ name: "webapp", url: "https://github.com/example-org/webapp.git" }]);
    await assert.rejects(x.project_repo_add({ project: "lab", repo: { name: "y", url: "https://ghp_x@github.com/example-org/y" } }), /credentials/);
    await assert.rejects(x.project_delete({ name: "lab", confirmName: "lb" }), /Confirmation does not match/);
    assert.deepEqual(await x.project_delete({ name: "lab", confirmName: "lab" }), { ok: true });
  });
  it("repos_list says unavailable when not wired", async () => {
    assert.equal((await h().repos_list({ refresh: false })).status, "unavailable");
  });
  it("dialog helpers", () => {
    assert.equal(repoNameFromUrl("https://github.com/example-org/wiki.example.com.git"), "wiki.example.com");
    assert.deepEqual(checkRepoForm({ name: "", url: "https://github.com/example-org/side-repo", branch: "" }), { ok: true, repo: { name: "side-repo", url: "https://github.com/example-org/side-repo.git" } });
    assert.equal(checkRepoForm({ name: "x", url: "https://t@github.com/a/b", branch: "" }).ok, false);
    const repos = [{ owner: "example-org", name: "webapp", url: "u", isPrivate: false, defaultBranch: null }, { owner: "example-org", name: "side-repo", url: "u", isPrivate: true, defaultBranch: "main" }];
    assert.deepEqual(filterRepos(repos, "SIDE").map((r) => r.name), ["side-repo"]);
  });
});
