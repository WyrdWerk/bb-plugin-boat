// bb-plugin-boat — Boat sandboxes (boat.dev) as bb machines.
//
// Experimental. See DESIGN.md for the mapping from bb's machine-provider
// callbacks to Boat and the evidence behind each rule (T1 fork identity,
// T2 post-resume settle). The base box contract is in BOX-CONTRACT.md.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { BoatApi, type FetchLike } from "./src/boat-api.ts";
import type { EnvLite } from "./src/envguard.ts";
import { BOAT_CHANGED, createDashboardHandlers, dashboardRpc, pendingBoxDeleteSweep } from "./src/dashboard.ts";
import { execFile } from "node:child_process";
import { createRepoLister } from "./src/github-repos.ts";
import { lifecycleSweep } from "./src/lifecycle.ts";
import { ProjectStore } from "./src/project-store.ts";

export type { DashboardRpc, OverviewDto, BoxDto } from "./src/dashboard.ts";

/** T17: Boat + a core environment provider. ids are what the CLI's --environment-provider takes. */
export const BOAT_COMPOSITIONS = [
  {
    id: "boat",
    displayName: "Boat sandbox",
    description: "A NEW Boat sandbox for this thread (forked from the base box, enrolled as a bb machine), with an isolated Git worktree. Bills while it runs; remove the machine when done.",
    icon: "./boat.svg",
    environmentProviderId: "git-worktree",
  },
  {
    id: "boat-checkout",
    displayName: "Boat sandbox (project checkout)",
    description: "A NEW Boat sandbox for this thread, working directly in the project checkout on it. Bills while it runs; remove the machine when done.",
    icon: "./boat.svg",
    environmentProviderId: "project-checkout",
  },
] as const;
import {
  type AllocationIntent,
  BoatMachineOps,
  inputsSchema,
  PROVIDER_ID,
  type ProviderConfig,
  resourceSchema,
} from "./src/provider.ts";

const MINUTE = 60_000;

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    apiKey: {
      type: "string",
      label: "Boat API key",
      description: "A Boat API key scoped to the team wallet. Stored as a secret; never sent to the frontend.",
      secret: true,
    },
    org: {
      type: "string",
      label: "Billing org",
      description: "Boat org id or name new boxes bill to. Never the personal wallet.",
    },
    source: {
      type: "select",
      label: "New machines come from",
      options: ["snapshot", "fork"],
      default: "fork",
    },
    from: {
      type: "string",
      label: "Base box id (fork) or named snapshot",
      description:
        "The box new runners are forked from (e.g. bx_abcd1234), or a named snapshot when the source is 'snapshot'. The base is never modified; each fork is converted to a runner at create. See BOX-CONTRACT.md.",
      default: "",
    },
    type: {
      type: "select",
      label: "Box size",
      options: ["small", "default", "large", "xlarge"],
      default: "default",
    },
    ttlHours: {
      type: "number",
      label: "Boat TTL (hours)",
      description: "Auto-stop set on create and resume. bb suspends or extends before it hits.",
      default: 4,
    },
    idleMinutes: {
      type: "number",
      label: "Suspend after idle (minutes, 0 = never)",
      default: 15,
    },
    preTtlMarginMinutes: {
      type: "number",
      label: "Act this long before Boat's auto-stop (minutes)",
      description: "Must cover core's 5-minute drain plus Boat's snapshot.",
      default: 15,
    },
    githubOwners: {
      type: "string",
      label: "GitHub owners for the repo picker",
      description: "Comma list of GitHub users/orgs whose repos the Projects editor offers (via `gh repo list` on this bb server).",
      default: "",
    },
    createMissingProjects: {
      type: "boolean",
      label: "Create bb projects for unmatched repos",
      description: "When a cloned project repo matches no bb project by git remote, create one from the clone on the runner. Off: just log it.",
      default: false,
    },
    renameProbeOk: {
      type: "number",
      label: "Disk-settled check: successful renames in a row",
      description:
        "Before enrolling (create and resume), the box must rename a directory this many times in a row, 10 s apart. Boat's lazy restore makes renames fail with EIO for a while, and bb can't install skills until they work.",
      default: 6,
    },
    renameProbeTimeoutMinutes: {
      type: "number",
      label: "Disk-settled check: give up after (minutes)",
      default: 20,
    },
    waitForAgentUpdates: {
      type: "boolean",
      label: "Wait for agent updates before enrolling",
      description:
        "The base box updates its agents ~8–10 min after ready (writes agents-update.done). Off: enroll as soon as the box is converted and report the update result when it lands. On: wait for it, up to 15 min.",
      default: false,
    },
  });

  async function config(): Promise<ProviderConfig | { error: string }> {
    const s = await settings.get();
    if (!s.apiKey) return { error: "Set the Boat API key in the plugin settings." };
    if (!s.org) return { error: "Set the Boat billing org (team wallet) in the plugin settings." };
    if (!s.from) return { error: "Set the named snapshot or source box id in the plugin settings." };
    return {
      apiKey: s.apiKey,
      org: s.org,
      source: s.source === "fork" ? "fork" : "snapshot",
      from: s.from,
      type: s.type,
      ttlSeconds: Math.round(s.ttlHours * 3600),
      waitForAgentUpdates: s.waitForAgentUpdates,
      renameProbeOk: Math.max(1, Math.round(s.renameProbeOk)),
      createMissingProjects: s.createMissingProjects,
      renameProbeTimeoutMs: Math.max(1, s.renameProbeTimeoutMinutes) * 60_000,
    };
  }

  // Allocation intents (non-secret create requests) for name-free cleanup; see provider.ts.
  const intentKey = (key: string) => `alloc/${key}`;
  // T18: plugin-owned multi-repo projects and the gh-backed repo picker.
  const projectStore = new ProjectStore(bb.storage.kv);
  const listRepos = createRepoLister({
    owners: async () => (await settings.get()).githubOwners.split(",").map((o) => o.trim()).filter(Boolean),
    now: () => Date.now(),
    runGh: (args) =>
      new Promise((resolve, reject) => {
        execFile("gh", args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
          if (err && (err as NodeJS.ErrnoException).code === "ENOENT") return reject(err);
          resolve({ code: err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
        });
      }),
  });
  // agents-update marker lines per box (shown on the Boat page), and a dispose
  // signal so background marker watchers stop on reload.
  const agentsKey = (boxId: string) => `agents/${boxId}`;
  // T16: manual machines removed from the Boat page; their box is deleted once bb is done.
  const pendingDeleteKey = (hostId: string) => `pendingdel/${hostId}`;
  const background = new AbortController();
  bb.onDispose(() => background.abort());
  const ops = new BoatMachineOps({
    config,
    api: (c) => new BoatApi(c.apiKey, fetch as unknown as FetchLike),
    bootstrap: (req) => bb.experimental_machines.bootstrap(req),
    now: () => Date.now(),
    sleep: (ms, signal) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        signal.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true });
      }),
    intents: {
      get: (key) => bb.storage.kv.get<AllocationIntent>(intentKey(key)),
      set: (key, intent) => bb.storage.kv.set(intentKey(key), intent),
      delete: (key) => bb.storage.kv.delete(intentKey(key)),
    },
    log: (m) => bb.log.info(m),
    backgroundSignal: background.signal,
    // T18: plugin-owned projects; cloned repos become bb project sources (no clone).
    getProject: (name) => projectStore.get(name),
    listProjects: async () =>
      ((await bb.sdk.projects.list()) as unknown as { id: string; name: string; gitRemoteUrl: string | null; sources?: { hostId: string; path: string }[] }[]).map(
        (p) => ({ id: p.id, name: p.name, gitRemoteUrl: p.gitRemoteUrl, sources: (p.sources ?? []).map((x) => ({ hostId: x.hostId, path: x.path })) }),
      ),
    addProjectSource: async ({ projectId, hostId, path }) => void (await bb.sdk.projects.sources.add({ projectId, type: "local_path", hostId, path })),
    createProject: async ({ name, hostId, path }) => {
      const p = (await bb.sdk.projects.create({ name, source: { type: "local_path", hostId, path } })) as unknown as { id: string };
      return { id: p.id };
    },
    // The URL bb hands machines (direct access: the machineServerUrl setting).
    hubUrl: async () => (await bb.sdk.system.config()).serverAccess.effectiveUrl,
    // T14: environments on the host (lifecycle phase, retireAt, teardown status).
    listHostEnvironments: async (hostId) => (await bb.sdk.environments.list({ hostId, limit: 500 })) as unknown as EnvLite[],
    // T19: resume resets the idle clock so the lifecycle sweep does not suspend a
    // freshly resumed machine at its next tick.
    markActive: (hostId) => bb.storage.kv.set(activeKey(hostId), Date.now()),
    countBusyThreads: async (hostId) =>
      (await bb.sdk.threads.count({ hostId, status: "starting" })).total + (await bb.sdk.threads.count({ hostId, status: "active" })).total,
    onAgentUpdates: (boxId, line) => {
      bb.log.info(`Boat ${boxId} agent updates: ${line}`);
      void bb.storage.kv.set(agentsKey(boxId), { line, seenAt: new Date().toISOString() });
    },
  });

  const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

  bb.experimental_machines.register({
    id: PROVIDER_ID,
    displayName: "Boat",
    description: "Run bb threads on Boat sandboxes enrolled as machines.",
    icon: "./boat.svg",
    ephemeral: false,
    inputs: inputsSchema,
    async availability() {
      const c = await config();
      return "error" in c ? { status: "setup-required", message: c.error } : { status: "available" };
    },
    async create({ inputs, key, checkpoint, report, signal }) {
      try {
        const { name, resource } = await ops.create(key, inputs ?? null, checkpoint, report, signal);
        return { status: "created", name, resource };
      } catch (err) {
        signal.throwIfAborted();
        return { status: "failed", message: message(err) };
      }
    },
    async reconcileCleanup({ key, signal }) {
      try {
        await ops.reconcileCleanup(key, signal);
        return { status: "removed" };
      } catch (err) {
        signal.throwIfAborted();
        bb.log.warn(`Boat cleanup for ${key} failed: ${message(err)}`);
        return { status: "failed", message: `Boat cleanup failed: ${message(err)}` };
      }
    },
    async suspend({ hostId, resource, checkpoint, report, signal }) {
      return { resource: await ops.suspend(resourceSchema.parse(resource), checkpoint, report, signal, hostId) };
    },
    async resume({ hostId, resource, checkpoint, report, signal }) {
      return { resource: await ops.resume(hostId, resourceSchema.parse(resource), checkpoint, report, signal) };
    },
    async remove({ hostId, resource, report, signal }) {
      try {
        await ops.remove(resourceSchema.parse(resource), signal, hostId, report);
        return { status: "removed" };
      } catch (err) {
        signal.throwIfAborted();
        bb.log.warn(`Boat remove failed: ${message(err)}`);
        return { status: "failed", message: `Boat remove failed: ${message(err)}` };
      }
    },
  });

  // T17: environment compositions, so "Boat sandbox" appears in the New Thread
  // environment picker and `bb thread spawn --environment-provider boat` works. Core
  // creates the machine (this provider), prepares the project checkout once it
  // connects, then asks the environment provider for a workspace. Machine
  // registration alone adds no picker option (plugin-api-docs, machine-providers).
  for (const c of BOAT_COMPOSITIONS) bb.experimental_environments.register({ ...c, machineProviderId: PROVIDER_ID });

  // Idle and pre-TTL suspension (policy in src/policy.ts).
  const activeKey = (hostId: string) => `active/${hostId}`;
  // Last activity, used only to measure idle time (the busy signal is threads.count).
  const bump = (hostId: string) => bb.storage.kv.set(activeKey(hostId), Date.now());

  bb.events.on("experimental_thread.events", async ({ thread }) => {
    if ((thread.status !== "starting" && thread.status !== "active") || thread.environmentId === null) return;
    const env = await bb.sdk.environments.get({ environmentId: thread.environmentId });
    await bump(env.hostId);
  });
  bb.events.on("experimental_terminal.input", async ({ terminal }) => {
    await bump(terminal.hostId);
  });

  bb.background.schedule("boat-lifecycle", "* * * * *", async () => {
    const c = await config();
    if ("error" in c) return;
    const delApi = new BoatApi(c.apiKey, fetch as unknown as FetchLike);
    await pendingBoxDeleteSweep({
      list: async () => {
        const out: { hostId: string; boxId: string }[] = [];
        for (const k of await bb.storage.kv.list("pendingdel/")) {
          const v = await bb.storage.kv.get<{ boxId: string }>(k);
          if (v) out.push({ hostId: k.slice("pendingdel/".length), boxId: v.boxId });
        }
        return out;
      },
      hostGone: async (hostId) => {
        const h = (await bb.sdk.hosts.list()).find((x) => x.id === hostId);
        return !h || h.lifecycle.phase === "destroyed";
      },
      deleteBox: (boxId) => delApi.deleteBox(boxId, { log: (m) => bb.log.info(m) }),
      clear: (hostId) => bb.storage.kv.delete(pendingDeleteKey(hostId)),
      log: (m) => bb.log.info(m),
    }).catch((err) => bb.log.warn(`pending box deletes: ${message(err)}`));
    const s = await settings.get();
    const api = new BoatApi(c.apiKey, fetch as unknown as FetchLike);
    const count = async (hostId: string, status: "starting" | "active") =>
      (await bb.sdk.threads.count({ hostId, status })).total;
    await lifecycleSweep(
      {
        listHosts: () => bb.sdk.hosts.list(),
        getResource: (hostId) => bb.experimental_machines.getResource(hostId),
        // T14: environments on the host (lifecycle phase, retireAt, teardown status).
        listHostEnvironments: async (hostId) => (await bb.sdk.environments.list({ hostId, limit: 500 })) as unknown as EnvLite[],
        countBusyThreads: async (hostId) => (await count(hostId, "starting")) + (await count(hostId, "active")),
        getLastActive: (hostId) => bb.storage.kv.get<number>(activeKey(hostId)),
        setLastActive: (hostId, at) => bb.storage.kv.set(activeKey(hostId), at),
        getBox: (boxId) => api.getBox(boxId),
        setTtl: async (boxId, ttl) => void (await api.setTtl(boxId, ttl)),
        suspend: async (hostId) => void (await bb.sdk.hosts.experimental_suspend({ hostId })),
        now: () => Date.now(),
        warn: (m) => bb.log.warn(m),
        info: (m) => bb.log.info(m),
      },
      {
        idleMs: s.idleMinutes > 0 ? s.idleMinutes * MINUTE : null,
        preTtlMarginMs: s.preTtlMarginMinutes * MINUTE,
        ttlSeconds: c.ttlSeconds,
      },
    );
  });

  // Boat page (app.tsx): data and actions over typed RPC; the key never leaves the server.
  bb.rpc.register(
    dashboardRpc,
    createDashboardHandlers({
      client: async () => {
        const cfg = await config();
        if ("error" in cfg) return cfg;
        return {
          api: new BoatApi(cfg.apiKey, fetch as unknown as FetchLike),
          org: cfg.org,
          ttlSeconds: cfg.ttlSeconds,
          baseBoxId: cfg.source === "fork" ? cfg.from : null,
        };
      },
      hosts: async () =>
        (await bb.sdk.hosts.list()).map((h) => ({
          id: h.id,
          name: h.name,
          status: h.status,
          machineProviderId: h.machineProviderId,
          phase: h.lifecycle.phase,
        })),
      removeHost: async (hostId) => void (await bb.sdk.hosts.delete({ hostId })),
      projectStore,
      listRepos: (refresh) => listRepos(refresh),
      machineDefaults: async () => {
        const s = await settings.get();
        return { from: s.source === "fork" ? (s.from ?? null) : null, type: s.type };
      },
      createMachine: async ({ key, inputs }) => {
        const h = await bb.sdk.hosts.experimental_create({ machineProviderId: PROVIDER_ID, key, inputs, wait: false });
        return { hostId: h.id, name: h.name ?? null };
      },
      setPendingBoxDelete: (hostId, boxId) => bb.storage.kv.set(pendingDeleteKey(hostId), { boxId, at: Date.now() }),
      getResource: (hostId) => bb.experimental_machines.getResource(hostId),
      publish: () => bb.realtime.publish(BOAT_CHANGED, {}),
      now: () => Date.now(),
      agentUpdates: async (boxId) => (await bb.storage.kv.get<{ line: string }>(agentsKey(boxId)))?.line ?? null,
    }),
  );

  const c = await config();
  if ("error" in c) bb.status.needsConfiguration(c.error);
}
