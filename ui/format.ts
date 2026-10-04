// Pure display helpers for the Boat page (no React; unit-tested).

export type Tone = "ok" | "busy" | "idle" | "warn" | "bad";

const LIVE = new Set(["ready", "idle", "running"]);
const STARTING = new Set(["init", "provisioning", "provisioned", "cloning", "resuming", "forking"]);
const STOPPING = new Set(["stopping", "archiving"]);
const STOPPED = new Set(["archived", "stopped"]);

export function isLive(state: string): boolean {
  return LIVE.has(state);
}

/** Boat state → badge tone and label. Unknown states show as-is. */
export function stateBadge(state: string): { tone: Tone; label: string } {
  if (LIVE.has(state)) return { tone: "ok", label: state === "running" ? "running (agent)" : "running" };
  if (STARTING.has(state)) return { tone: "busy", label: state };
  if (STOPPING.has(state)) return { tone: "busy", label: state };
  if (STOPPED.has(state)) return { tone: "idle", label: "stopped" };
  if (state === "error") return { tone: "bad", label: "error" };
  return { tone: "warn", label: state };
}

/** "in 1h 05m", "in 4m", "overdue 3m", or "no auto-stop". */
export function ttlLabel(archiveAfter: string | null, now: number): string {
  if (archiveAfter === null) return "no auto-stop";
  const t = Date.parse(archiveAfter);
  if (!Number.isFinite(t)) return "unknown";
  const diff = t - now;
  const abs = Math.abs(diff);
  const h = Math.floor(abs / 3_600_000);
  const m = Math.floor((abs % 3_600_000) / 60_000);
  const span = h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
  return diff >= 0 ? `in ${span}` : `overdue ${span}`;
}

/** Short relative age: "3m ago", "2h ago", "5d ago". */
export function ago(iso: string | null, now: number): string {
  if (iso === null) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172_800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

export function bytes(n: number | null): string {
  if (n === null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** agents-update marker `<time> pi=ok codex=failed …` → short cell text. */
export function agentsSummary(line: string | null): { tone: Tone; text: string } {
  if (line === null) return { tone: "idle", text: "—" };
  const results = [...line.matchAll(/([A-Za-z0-9_.-]+)=([A-Za-z0-9_.-]+)/g)].map((m) => [m[1]!, m[2]!] as const);
  if (results.length === 0) return { tone: "warn", text: "unknown" };
  const bad = results.filter(([, v]) => v !== "ok" && v !== "skipped");
  return bad.length === 0
    ? { tone: "ok", text: `all ok (${results.length})` }
    : { tone: "warn", text: bad.map(([k, v]) => `${k}=${v}`).join(" ") };
}

/** Health/error cell. Boat leaves stale errors on healthy boxes; say which. */
export function healthLabel(health: string | null, error: string | null): { tone: Tone; text: string; detail: string | null } {
  if (error && /^Restore incomplete/i.test(error)) {
    return { tone: "bad", text: "restore incomplete", detail: `${error} — files may be missing (see T2).` };
  }
  if (error) return { tone: "warn", text: health ?? "error", detail: error };
  if (health && health !== "ok") return { tone: "warn", text: health, detail: null };
  return { tone: "ok", text: health ?? "—", detail: null };
}
