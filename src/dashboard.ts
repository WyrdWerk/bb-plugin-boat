// Server side of the Boat page: a typed RPC contract and its handlers.
//
// The Boat API key stays here. Every output is built from explicit zod schemas,
// so fields the frontend must never see (ip, url, subdomain, sshEndpoint,
// desktopUrl, the key) can't pass through even if Boat starts returning them.
// Deletes are deliberately absent in v1.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { type BoatApi, type Box, LIVE_STATES, STOPPED_STATES, STOPPING_STATES } from "./boat-api.ts";
import type { RepoListResult } from "./github-repos.ts";
import { machineStuck } from "./machine-state.ts";
import type { ProjectStore } from "./project-store.ts";
import { machineName } from "./policy.ts";

export { machineStuck };
import { PROVIDER_ID } from "./provider.ts";

const repoInput = z.object({ name: z.string(), url: z.string(), branch: z.string().optional() });
const projectDto = z.object({
  name: z.string(),
  repos: z.array(z.object({ name: z.string(), url: z.string(), branch: z.string().optional() })),
});

/** Realtime channel the page and sidebar listen on; published after every action. */
export const BOAT_CHANGED = "boat-changed";

const boxId = z.string().regex(/^bx_[a-z0-9]+$/, "not a Boat box id");
const hours = z.number().min(0.25).max(720); // Boat accepts up to 30 days

const machineDto = z.object({
  hostId: z.string(),
  name: z.string(),
  status: z.string(),
  /** Created by this plugin's machine provider (vs. manually enrolled). */
  viaPlugin: z.boolean(),
  /** bb lifecycle phase (active, suspended, removing, cleanup-failed, …). */
  phase: z.string().default("active"),
});

export const boxDto = z.object({
  id: z.string(),
  name: z.string().nullable(),
  state: z.string(),
  type: z.string().nullable(),
  archiveAfter: z.string().nullable(),
  health: z.string().nullable(),
  error: z.string().nullable(),
  lastSnapshotStatus: z.string().nullable(),
  snapshotCompletedAt: z.string().nullable(),
  createdAt: z.string().nullable(),
  machine: machineDto.nullable(),
  /** The base box runners are forked from: fork only, never resumed/stopped/changed here. */
  isBase: z.boolean().default(false),
  /** agents-update marker (`<time> pi=ok codex=ok …`) seen by the provider, if any. */
  agentUpdates: z.string().nullable().default(null),
});
export type BoxDto = z.infer<typeof boxDto>;

export const walletDto = z.object({
  org: z.string(),
  canStart: z.boolean().nullable(),
  blockedReason: z.string().nullable(),
  accessTier: z.string().nullable(),
  activeBoxes: z.number().nullable(),
  maxActiveBoxes: z.number().nullable(),
  creditHours: z.number().nullable(),
  startsRemaining: z.object({ minute: z.number().nullable(), hour: z.number().nullable(), day: z.number().nullable() }),
  startsUnlimited: z.boolean().nullable(),
});
export type WalletDto = z.infer<typeof walletDto>;

export const snapshotDto = z.object({
  name: z.string(),
  status: z.string().nullable(),
  sourceBoxId: z.string().nullable(),
  type: z.string().nullable(),
  sizeBytes: z.number().nullable(),
  createdAt: z.string().nullable(),
});
export type SnapshotDto = z.infer<typeof snapshotDto>;

const section = <T extends z.ZodType>(item: T) => z.object({ items: item.nullable(), error: z.string().nullable() });

export const overviewDto = z.object({
  configured: z.boolean(),
  setupMessage: z.string().nullable(),
  fetchedAt: z.string(),
  boxes: section(z.array(boxDto)),
  wallet: section(walletDto),
  snapshots: section(z.array(snapshotDto)),
});
export type OverviewDto = z.infer<typeof overviewDto>;

const actionResult = z.object({ ok: z.literal(true), message: z.string() });

export const dashboardRpc = defineRpcContract({
  boat_overview: { input: z.null(), output: overviewDto },
  boat_summary: { input: z.null(), output: z.object({ running: z.number().nullable(), total: z.number().nullable() }) },
  /** T17: non-secret defaults for the machine inputs control (placeholders). */
  boat_machine_defaults: {
    input: z.null(),
    output: z.object({ from: z.string().nullable(), type: z.string(), projects: z.array(z.string()).default([]) }),
  },
  // T18: plugin-owned multi-repo projects (Boat page → Projects).
  projects_list: { input: z.null(), output: z.object({ projects: z.array(projectDto) }) },
  project_create: { input: z.object({ name: z.string() }), output: projectDto },
  project_rename: { input: z.object({ name: z.string(), newName: z.string() }), output: projectDto },
  project_delete: { input: z.object({ name: z.string(), confirmName: z.string() }), output: z.object({ ok: z.literal(true) }) },
  project_repo_add: { input: z.object({ project: z.string(), repo: repoInput }), output: projectDto },
  project_repo_update: { input: z.object({ project: z.string(), repoName: z.string(), repo: repoInput }), output: projectDto },
  project_repo_remove: { input: z.object({ project: z.string(), repoName: z.string() }), output: projectDto },
  // T18 add-on: repo picker from `gh repo list` on the hub (no tokens returned).
  repos_list: {
    input: z.object({ refresh: z.boolean().default(false) }),
    output: z.discriminatedUnion("status", [
      z.object({
        status: z.literal("ok"),
        repos: z.array(z.object({ owner: z.string(), name: z.string(), url: z.string(), isPrivate: z.boolean(), defaultBranch: z.string().nullable() })),
        fetchedAt: z.number(),
        cached: z.boolean(),
      }),
      z.object({ status: z.literal("unavailable"), reason: z.string() }),
    ]),
  },
  boat_resume: { input: z.object({ boxId, ttlHours: hours.optional() }), output: actionResult },
  boat_stop: { input: z.object({ boxId }), output: actionResult },
  boat_fork: {
    // requestId (a UUID from the page) becomes the Idempotency-Key, so a double
    // click or a retried request can't bill a second fork.
    input: z.object({ boxId, ttlHours: hours, requestId: z.string().uuid() }),
    output: actionResult.extend({ newBoxId: z.string() }),
  },
  // T17: fork as a bb runner through bb core (hosts.experimental_create with this
  // provider), so the normal create path runs. requestId → stable creation key per click.
  boat_fork_runner: {
    input: z.object({ boxId, requestId: z.string().uuid() }),
    output: actionResult.extend({ hostId: z.string(), machineName: z.string().nullable() }),
  },
  boat_set_ttl: { input: z.object({ boxId, hours }), output: actionResult.extend({ archiveAfter: z.string().nullable() }) },
  boat_save_snapshot: {
    input: z.object({ boxId, name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/, "lowercase letters, digits and dashes") }),
    output: actionResult,
  },
  // T16: permanent delete. confirmBoxId must equal boxId (typed by the user).
  // machine-and-box: bb removes the machine first (core tears down environments);
  // box-only: just the Boat box, allowed for unlinked boxes or stuck machines.
  boat_delete: {
    input: z.object({ boxId, confirmBoxId: z.string(), mode: z.enum(["machine-and-box", "box-only"]) }),
    output: actionResult,
  },
});

export type DashboardRpc = typeof dashboardRpc;

export interface DashboardHost {
  id: string;
  name: string;
  status: string;
  machineProviderId: string | null;
  phase?: string;
}

export interface DashboardDeps {
  /** T17: plugin defaults for new machines (non-secret). */
  machineDefaults?(): Promise<{ from: string | null; type: string }>;
  /** T18: plugin-owned project definitions. */
  projectStore?: ProjectStore;
  /** T18 add-on: `gh repo list` on the hub, cached. */
  listRepos?(refresh: boolean): Promise<RepoListResult>;
  /** Configured client + org, or the setup message to show. */
  /** baseBoxId: the fork source runners are made from; the page never changes it (T6). */
  client(): Promise<{ api: BoatApi; org: string; ttlSeconds: number; baseBoxId?: string | null } | { error: string }>;
  hosts(): Promise<DashboardHost[]>;
  getResource(hostId: string): Promise<unknown | null>;
  publish(): void;
  now(): number;
  /** Overview cache lifetime; the sidebar count polls through it. */
  cacheMs?: number;
  /** Last agents-update marker line seen for a box (T8), if any. */
  agentUpdates?(boxId: string): Promise<string | null>;
  /**
   * T17: create a bb machine with this plugin's provider (SDK hosts.experimental_create,
   * wait: false). Returns the creating host.
   */
  createMachine?(args: { key: string; inputs: { source: "fork"; from: string } }): Promise<{ hostId: string; name: string | null }>;
  /** T16: bb machine removal (SDK hosts.delete). Core tears down environments first. */
  removeHost?(hostId: string): Promise<void>;
  /** T16: remember to delete a manual machine's box once bb has removed the machine. */
  setPendingBoxDelete?(hostId: string, boxId: string): Promise<void>;
  /** Bound for a box-only delete inside the RPC (default 90 s); Boat keeps going after. */
  deleteMaxMs?: number;
}

const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));

function toBoxDto(b: Box, machine: BoxDto["machine"], isBase = false): BoxDto {
  return boxDto.parse({
    id: b.id,
    name: b.name ?? null,
    state: b.state,
    type: b.type ?? null,
    archiveAfter: b.archiveAfter ?? null,
    health: b.health ?? null,
    error: b.error ?? null,
    lastSnapshotStatus: b.lastSnapshotStatus ?? null,
    snapshotCompletedAt: b.snapshotCompletedAt ?? null,
    createdAt: b.createdAt ?? null,
    machine,
    isBase,
  });
}

/** Box id → bb machine: provider resource first, then the bx-<id> naming convention. */
async function machineIndex(deps: DashboardDeps): Promise<Map<string, z.infer<typeof machineDto>>> {
  const index = new Map<string, z.infer<typeof machineDto>>();
  for (const h of await deps.hosts()) {
    const viaPlugin = h.machineProviderId === PROVIDER_ID;
    let id: string | null = null;
    if (viaPlugin) {
      const r = (await deps.getResource(h.id)) as { boxId?: unknown } | null;
      if (r && typeof r.boxId === "string") id = r.boxId;
    }
    if (id === null && /^bx-[a-z0-9]+$/.test(h.name)) id = h.name.replace(/^bx-/, "bx_");
    if (id !== null) index.set(id, { hostId: h.id, name: h.name, status: h.status, viaPlugin, phase: h.phase ?? "active" });
  }
  return index;
}

export function createDashboardHandlers(deps: DashboardDeps) {
  const cacheMs = deps.cacheMs ?? 15_000;
  let cache: { at: number; value: OverviewDto } | null = null;

  async function overview(): Promise<OverviewDto> {
    if (cache && deps.now() - cache.at < cacheMs) return cache.value;
    const fetchedAt = new Date(deps.now()).toISOString();
    const c = await deps.client();
    if ("error" in c) {
      const empty = { items: null, error: null };
      return overviewDto.parse({ configured: false, setupMessage: c.error, fetchedAt, boxes: empty, wallet: empty, snapshots: empty });
    }
    const [boxes, wallet, snapshots, machines] = await Promise.allSettled([
      c.api.listBoxes(),
      c.api.getLimits(c.org),
      c.api.listNamedSnapshots(),
      machineIndex(deps),
    ]);
    const index = machines.status === "fulfilled" ? machines.value : new Map();
    const value = overviewDto.parse({
      configured: true,
      setupMessage: null,
      fetchedAt,
      boxes:
        boxes.status === "fulfilled"
          ? {
              items: await Promise.all(
                boxes.value.map(async (b) => ({
                  ...toBoxDto(b, index.get(b.id) ?? null, b.id === (c.baseBoxId ?? null)),
                  agentUpdates: deps.agentUpdates ? await deps.agentUpdates(b.id).catch(() => null) : null,
                })),
              ),
              error: null,
            }
          : { items: null, error: msg(boxes.reason) },
      wallet:
        wallet.status === "fulfilled"
          ? {
              items: {
                org: c.org,
                canStart: wallet.value.canStart ?? null,
                blockedReason: wallet.value.blockedReason ?? null,
                accessTier: wallet.value.accessTier ?? null,
                activeBoxes: wallet.value.activeBoxes ?? null,
                maxActiveBoxes: wallet.value.maxActiveBoxes ?? null,
                creditHours:
                  typeof wallet.value.creditBalanceSeconds === "number"
                    ? Math.round((wallet.value.creditBalanceSeconds / 3600) * 100) / 100
                    : null,
                startsRemaining: {
                  minute: wallet.value.starts?.minute?.remaining ?? null,
                  hour: wallet.value.starts?.hour?.remaining ?? null,
                  day: wallet.value.starts?.day?.remaining ?? null,
                },
                startsUnlimited: wallet.value.starts?.unlimited ?? null,
              },
              error: null,
            }
          : { items: null, error: msg(wallet.reason) },
      snapshots:
        snapshots.status === "fulfilled"
          ? {
              items: snapshots.value.map((s) =>
                snapshotDto.parse({
                  name: s.name,
                  status: s.status ?? null,
                  sourceBoxId: s.sourceBoxId ?? null,
                  type: s.type ?? null,
                  sizeBytes: s.sizeBytes ?? null,
                  createdAt: s.createdAt ?? null,
                }),
              ),
              error: null,
            }
          : { items: null, error: msg(snapshots.reason) },
    });
    cache = { at: deps.now(), value };
    return value;
  }

  async function configured() {
    const c = await deps.client();
    if ("error" in c) throw new Error(c.error);
    return c;
  }

  /** Every state-changing action except fork: refuse the base box (T6: never modified). */
  async function configuredNotBase(id: string) {
    const c = await configured();
    if (c.baseBoxId && id === c.baseBoxId) {
      throw new Error(`${id} is the base box runners are forked from; it is never changed from bb. Fork it instead.`);
    }
    return c;
  }

  async function mustGet(api: BoatApi, id: string): Promise<Box> {
    const box = await api.getBox(id);
    if (!box) throw new Error(`Boat box ${id} not found`);
    return box;
  }

  async function withStore<T>(fn: (s: ProjectStore) => Promise<T>): Promise<T> {
    if (!deps.projectStore) throw new Error("project storage is not available in this build");
    const r = await fn(deps.projectStore);
    deps.publish();
    return r;
  }

  function changed() {
    cache = null;
    deps.publish();
  }

  return {
    boat_overview: async () => overview(),

    boat_summary: async () => {
      const o = await overview();
      const items = o.boxes.items;
      return items === null
        ? { running: null, total: null }
        : { running: items.filter((b) => LIVE_STATES.has(b.state)).length, total: items.length };
    },

    boat_resume: async ({ boxId: id, ttlHours }: { boxId: string; ttlHours?: number }) => {
      const c = await configuredNotBase(id);
      const box = await mustGet(c.api, id);
      if (LIVE_STATES.has(box.state)) throw new Error(`${id} is already ${box.state}`);
      if (STOPPING_STATES.has(box.state)) throw new Error(`${id} is still ${box.state}; resume once it is stopped`);
      if (!STOPPED_STATES.has(box.state)) throw new Error(`${id} is ${box.state}; cannot resume now`);
      await c.api.resume(id, ttlHours ? Math.round(ttlHours * 3600) : c.ttlSeconds);
      changed();
      return { ok: true as const, message: `Resuming ${id}` };
    },

    boat_stop: async ({ boxId: id }: { boxId: string }) => {
      const c = await configuredNotBase(id);
      const box = await mustGet(c.api, id);
      if (!LIVE_STATES.has(box.state)) throw new Error(`${id} is ${box.state}, not running`);
      await c.api.stop(id);
      changed();
      return { ok: true as const, message: `Stopping ${id} (Boat snapshots it first)` };
    },

    boat_fork: async ({ boxId: id, ttlHours, requestId }: { boxId: string; ttlHours: number; requestId: string }) => {
      const c = await configured();
      await mustGet(c.api, id);
      const created = await c.api.createBox({
        source: { kind: "fork", boxId: id },
        org: c.org,
        ttlSeconds: Math.round(ttlHours * 3600),
        idempotencyKey: requestId,
      });
      changed();
      return { ok: true as const, message: `Forked ${id} → ${created.id}`, newBoxId: created.id };
    },

    boat_machine_defaults: async () => {
      const d = deps.machineDefaults ? await deps.machineDefaults() : { from: null, type: "default" };
      const projects = deps.projectStore ? (await deps.projectStore.list()).map((p) => p.name) : [];
      return { from: d.from, type: d.type, projects };
    },

    projects_list: async () => ({ projects: deps.projectStore ? await deps.projectStore.list() : [] }),
    project_create: async ({ name }: { name: string }) => withStore((s) => s.create(name)),
    project_rename: async ({ name, newName }: { name: string; newName: string }) => withStore((s) => s.rename(name, newName)),
    project_delete: async ({ name, confirmName }: { name: string; confirmName: string }) => {
      await withStore((s) => s.delete(name, confirmName));
      return { ok: true as const };
    },
    project_repo_add: async ({ project, repo }: { project: string; repo: { name: string; url: string; branch?: string } }) =>
      withStore((s) => s.addRepo(project, repo)),
    project_repo_update: async ({ project, repoName, repo }: { project: string; repoName: string; repo: { name: string; url: string; branch?: string } }) =>
      withStore((s) => s.updateRepo(project, repoName, repo)),
    project_repo_remove: async ({ project, repoName }: { project: string; repoName: string }) => withStore((s) => s.removeRepo(project, repoName)),
    repos_list: async ({ refresh }: { refresh: boolean }) =>
      deps.listRepos ? deps.listRepos(refresh) : { status: "unavailable" as const, reason: "repo listing is not wired in this build" },

    boat_fork_runner: async ({ boxId: id, requestId }: { boxId: string; requestId: string }) => {
      if (!deps.createMachine) throw new Error("bb machine creation is not available in this plugin build");
      const c = await configured(); // the base box is allowed: it's the normal fork source
      await mustGet(c.api, id);
      const key = forkRunnerKey(requestId);
      const host = await deps.createMachine({ key, inputs: { source: "fork", from: id } });
      changed();
      return {
        ok: true as const,
        message: `Creating bb machine ${host.name ?? host.hostId} from a fork of ${id}: fork → disk check → conversion → hub check → enrollment (a few minutes). Follow it in Machines.`,
        hostId: host.hostId,
        machineName: host.name,
      };
    },

    boat_set_ttl: async ({ boxId: id, hours: h }: { boxId: string; hours: number }) => {
      const c = await configuredNotBase(id);
      const box = await c.api.setTtl(id, Math.round(h * 3600));
      changed();
      return { ok: true as const, message: `${id} now auto-stops ${box.archiveAfter ?? "never"}`, archiveAfter: box.archiveAfter ?? null };
    },

    boat_delete: async ({ boxId: id, confirmBoxId, mode }: { boxId: string; confirmBoxId: string; mode: "machine-and-box" | "box-only" }) => {
      if (confirmBoxId.trim() !== id) throw new Error(`Confirmation does not match: type ${id} exactly to delete it`);
      const c = await configuredNotBase(id);
      const machine = (await machineIndex(deps)).get(id) ?? null;
      if (machine && mode === "machine-and-box") {
        if (!deps.removeHost) throw new Error("bb machine removal is not available in this plugin build");
        await deps.removeHost(machine.hostId);
        changed();
        if (machine.viaPlugin) {
          return { ok: true as const, message: `Removing bb machine ${machine.name}: bb tears down its environments, then this plugin deletes ${id}` };
        }
        await deps.setPendingBoxDelete?.(machine.hostId, id);
        return {
          ok: true as const,
          message: `Removing bb machine ${machine.name}: bb tears down its environments first; ${id} is deleted once the machine is gone`,
        };
      }
      if (machine && !machineStuck(machine)) {
        throw new Error(`${id} is bb machine ${machine.name}, which is connected: use "Remove machine and box" so bb can clean up first`);
      }
      try {
        await c.api.deleteBox(id, { maxMs: deps.deleteMaxMs ?? 90_000 });
      } catch (err) {
        if (err instanceof Error && /deletion_timeout/.test(`${(err as { code?: string }).code ?? ""} ${err.message}`)) {
          changed();
          return { ok: true as const, message: `Boat accepted the delete of ${id}; it is still finishing` };
        }
        throw err;
      }
      changed();
      return {
        ok: true as const,
        message: machine
          ? `Deleted ${id}. bb machine ${machine.name} stays (${machine.status}, ${machine.phase}) until bb can clean it up`
          : `Deleted ${id}`,
      };
    },

    boat_save_snapshot: async ({ boxId: id, name }: { boxId: string; name: string }) => {
      const c = await configuredNotBase(id);
      await mustGet(c.api, id);
      await c.api.saveNamedSnapshot(id, name);
      changed();
      return { ok: true as const, message: `Saving ${id} as named snapshot ${name}` };
    },
  };
}

/** Exposed for tests and the page: the bb machine name a box would get. */
export { machineName };

/**
 * T16: delete boxes of manual bb machines whose removal was requested from the Boat
 * page, once bb has actually removed the machine (its environments are torn down by
 * then). Runs from the plugin's minute schedule. Returns what it did.
 */
export async function pendingBoxDeleteSweep(deps: {
  list(): Promise<{ hostId: string; boxId: string }[]>;
  hostGone(hostId: string): Promise<boolean>;
  deleteBox(boxId: string): Promise<void>;
  clear(hostId: string): Promise<void>;
  log(message: string): void;
}): Promise<string[]> {
  const done: string[] = [];
  for (const { hostId, boxId } of await deps.list()) {
    if (!(await deps.hostGone(hostId))) continue;
    try {
      await deps.deleteBox(boxId);
      await deps.clear(hostId);
      deps.log(`bb removed machine ${hostId}; deleted its box ${boxId}`);
      done.push(boxId);
    } catch (err) {
      deps.log(`delete of ${boxId} after machine ${hostId} was removed failed (retrying next minute): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return done;
}

/** Stable bb creation key for one "Fork as bb runner" click (retries reuse it; core is idempotent by key). */
export function forkRunnerKey(requestId: string): string {
  return `boat-page-fork-${requestId}`;
}
