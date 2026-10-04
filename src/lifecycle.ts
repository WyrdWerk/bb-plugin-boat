// One sweep of idle / pre-TTL handling over this provider's machines. Injected
// dependencies keep it testable; server.ts wires them to the bb SDK and Boat.
import type { Box } from "./boat-api.ts";
import { DEFER_ACTIONS, describeBlockers, type EnvLite, envBlockers } from "./envguard.ts";
import { type LifecycleAction, lifecycleDecision } from "./policy.ts";
import { PROVIDER_ID, resourceSchema } from "./provider.ts";

export interface SweepHost {
  id: string;
  machineProviderId: string | null;
  lifecycle: { phase: string };
}

export interface SweepDeps {
  listHosts(): Promise<SweepHost[]>;
  getResource(hostId: string): Promise<unknown | null>;
  /**
   * Threads occupying the host right now (status starting or active), counted by
   * the bb server. This is the busy signal; event timestamps only measure idle time,
   * so a long, quiet tool call still counts as busy.
   */
  countBusyThreads(hostId: string): Promise<number>;
  getLastActive(hostId: string): Promise<number | undefined>;
  setLastActive(hostId: string, at: number): Promise<void>;
  getBox(boxId: string): Promise<Box | null>;
  setTtl(boxId: string, ttlSeconds: number): Promise<void>;
  suspend(hostId: string): Promise<void>;
  /** Environments on the host (T14): a suspend request is deferred while any hook may run. */
  listHostEnvironments?(hostId: string): Promise<EnvLite[]>;
  now(): number;
  warn(message: string): void;
  info(message: string): void;
}

export interface SweepSettings {
  idleMs: number | null;
  preTtlMarginMs: number;
  ttlSeconds: number;
}

export interface SweepResult {
  hostId: string;
  action: LifecycleAction;
  busyThreads: number;
  /** Set when a suspend was deferred because of environment hooks (T14). */
  deferred?: string;
}

const isMachineBusy = (err: unknown) => err instanceof Error && "code" in err && err.code === "machine_busy";

export async function lifecycleSweep(deps: SweepDeps, s: SweepSettings): Promise<SweepResult[]> {
  const results: SweepResult[] = [];
  for (const host of await deps.listHosts()) {
    if (host.machineProviderId !== PROVIDER_ID || host.lifecycle.phase !== "active") continue;
    try {
      const raw = await deps.getResource(host.id);
      if (raw === null) continue;
      const box = await deps.getBox(resourceSchema.parse(raw).boxId);
      if (!box) continue;
      const now = deps.now();
      const busyThreads = await deps.countBusyThreads(host.id);
      let last = await deps.getLastActive(host.id);
      if (busyThreads > 0 || last === undefined) {
        // Running work keeps the idle clock at zero; first sight starts it.
        last = now;
        await deps.setLastActive(host.id, now);
      }
      const action = lifecycleDecision({
        now,
        lastActiveAt: last,
        idleMs: s.idleMs,
        archiveAfter: box.archiveAfter ?? null,
        preTtlMarginMs: s.preTtlMarginMs,
        busy: busyThreads > 0,
      });
      if (action === "suspend-idle" || action === "suspend-before-ttl") {
        // T14: suspending stops the daemon; an environment hook cut mid-run leaves its
        // outcome unknown and blocks cleanup. Defer while any may run.
        let why: string | null = null;
        if (deps.listHostEnvironments) {
          try {
            const b = envBlockers(await deps.listHostEnvironments(host.id), now, DEFER_ACTIONS);
            if (b.length > 0) why = `environment teardown running: ${describeBlockers(b)}`;
          } catch (err) {
            why = `environment list unavailable: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
        if (why) {
          results.push({ hostId: host.id, action, busyThreads, deferred: why });
          if (action === "suspend-before-ttl") {
            // Don't let Boat's auto-stop do what we just refused to do.
            await deps.setTtl(box.id, s.ttlSeconds);
            deps.info(`Suspend before TTL deferred for ${host.id} (${why}); extended Boat TTL for ${box.id}`);
          } else {
            deps.info(`Idle suspend deferred for ${host.id} (${why})`);
          }
          continue;
        }
      }
      results.push({ hostId: host.id, action, busyThreads });
      if (action === "extend-ttl") {
        await deps.setTtl(box.id, s.ttlSeconds);
        deps.info(`Extended Boat TTL for ${box.id} (${busyThreads} thread(s) running)`);
      } else if (action === "suspend-idle" || action === "suspend-before-ttl") {
        await deps.suspend(host.id);
        deps.info(`Suspending ${host.id} (${action})`);
      }
    } catch (err) {
      if (isMachineBusy(err)) continue; // core refused: launch/setup in progress; retry next sweep
      deps.warn(`Boat lifecycle check failed for ${host.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return results;
}
