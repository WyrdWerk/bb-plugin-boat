// Hub gate (T11): right before bootstrap, prove the box can reach the bb hub.
// Live 2026-10-04: enrollment ran ~40 s before Tailscale joined and
// failed with `curl: (6) Could not resolve host: <hub>.<tailnet>.ts.net`.
// Three checks, in order, all run on the box (read-only, no secrets printed):
//   1. tailscale BackendState == Running
//   2. the hub's host name resolves (getent hosts; MagicDNS)
//   3. GET <hub>/health answers 2xx

export interface HubTarget {
  /** Origin + path, no trailing slash, e.g. https://hub.example-tailnet.ts.net:3888 */
  base: string;
  host: string;
  health: string;
}

/** Validate the hub URL from bb before it goes into a shell script. */
export function parseHubUrl(url: string): HubTarget {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`bb's machine server URL is not a URL: ${JSON.stringify(url)}`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`bb's machine server URL must be http(s): ${url}`);
  if (!/^[A-Za-z0-9.-]+$/.test(u.hostname)) throw new Error(`unexpected host in bb's machine server URL: ${u.hostname}`);
  if (u.username || u.password || u.search || u.hash) throw new Error("bb's machine server URL must not carry credentials, query or fragment");
  const path = u.pathname.replace(/\/+$/, "");
  if (!/^[A-Za-z0-9/._-]*$/.test(path)) throw new Error(`unexpected path in bb's machine server URL: ${path}`);
  const base = `${u.protocol}//${u.host}${path}`;
  return { base, host: u.hostname, health: `${base}/health` };
}

/** Script for the box. Prints `ts=<BackendState|none>`, `dns=yes|no`, `health=<http code|000>`. */
export function hubGateScript(target: HubTarget): string {
  return [
    "set -u",
    // Status JSON carries IPs and peers: keep only BackendState. Fall back to root if the user can't read it.
    `st=$({ timeout 10 tailscale status --json 2>/dev/null || timeout 10 sudo -n tailscale status --json 2>/dev/null; } | grep -o '"BackendState": *"[A-Za-z]*"' | head -1 | sed 's/.*"\\([A-Za-z]*\\)"$/\\1/')`,
    'echo "ts=${st:-none}"',
    `if timeout 10 getent hosts '${target.host}' >/dev/null 2>&1; then echo dns=yes; else echo dns=no; fi`,
    `code=$(timeout 15 curl -sS -m 8 -o /dev/null -w '%{http_code}' '${target.health}' 2>/dev/null)`,
    'echo "health=${code:-000}"',
  ].join("\n");
}

export interface HubGateSample {
  tailscale: string;
  dns: boolean;
  health: string;
}

export function parseHubGate(stdout: string): HubGateSample {
  const r: HubGateSample = { tailscale: "none", dns: false, health: "000" };
  for (const line of stdout.split("\n")) {
    if (line.startsWith("ts=")) r.tailscale = line.slice(3).trim() || "none";
    else if (line.startsWith("dns=")) r.dns = line.trim().endsWith("yes");
    else if (line.startsWith("health=")) r.health = line.slice(7).trim() || "000";
  }
  return r;
}

export type HubCheck = "tailscale" | "dns" | "health";

export type HubGateDecision = { ok: true } | { ok: false; check: HubCheck; message: string };

export function hubGateDecision(s: HubGateSample, target: HubTarget): HubGateDecision {
  if (s.tailscale !== "Running") {
    return { ok: false, check: "tailscale", message: `Tailscale is not running on the box (BackendState=${s.tailscale})` };
  }
  if (!s.dns) return { ok: false, check: "dns", message: `the hub name ${target.host} does not resolve on the box (MagicDNS)` };
  if (!/^2\d\d$/.test(s.health)) {
    return { ok: false, check: "health", message: `GET ${target.health} answered ${s.health === "000" ? "nothing (no connection)" : s.health}` };
  }
  return { ok: true };
}
