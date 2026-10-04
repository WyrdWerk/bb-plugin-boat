// Shared (server + page) rule, no dependencies so the frontend bundle can import it.

/** A linked bb machine that can't finish removal on its own (T16; live: "Host is not connected"). */
export function machineStuck(m: { status: string; phase: string }): boolean {
  return m.status !== "connected" || m.phase === "removing" || m.phase === "cleanup-failed";
}
