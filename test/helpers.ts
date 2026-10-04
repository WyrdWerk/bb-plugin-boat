import type { AllocationIntent, IntentStore } from "../src/provider.ts";

/** In-memory stand-in for the plugin's kv-backed allocation intent store. */
export function memIntents(seed: Record<string, AllocationIntent> = {}): IntentStore & { map: Map<string, AllocationIntent> } {
  const map = new Map(Object.entries(seed));
  return {
    map,
    get: async (k) => map.get(k),
    set: async (k, v) => void map.set(k, structuredClone(v)),
    delete: async (k) => void map.delete(k),
  };
}

/** Canned, value-free answers for the T12 prep commands (skill-store cleanup, agent env). */
export function prepReply(cmd: string): { exitCode: number; stdout: string; stderr: string } | null {
  if (cmd.includes("rename-probe-cleaned=")) return { exitCode: 0, stdout: "rename-probe-cleaned=1\n", stderr: "" };
  if (cmd.includes('echo "rename=ok')) return { exitCode: 0, stdout: "rename=ok where=bb-machines kio=0 kio_vda=0\n", stderr: "" };
  if (cmd.includes("skill-store-cleaned=")) return { exitCode: 0, stdout: "skill-store-cleaned=0\n", stderr: "" };
  if (cmd.includes("agent-env=")) {
    return { exitCode: 0, stdout: "agent-env=ok vars=12 hash=0123456789abcdef changed=no restarted=0 claude=yes bws=yes\n", stderr: "" };
  }
  return null;
}

/** Wrap a fake Boat API so prep commands are answered and everything else passes through. */
export function withPrep<T>(api: T): T {
  const inner = api as unknown as { runCommand?: (id: string, cmd: string, ...rest: unknown[]) => Promise<unknown> };
  return new Proxy(api as object, {
    get(target, prop, receiver) {
      if (prop === "runCommand") {
        return async (id: string, cmd: string, ...rest: unknown[]) => prepReply(cmd) ?? inner.runCommand!(id, cmd, ...rest);
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as T;
}
