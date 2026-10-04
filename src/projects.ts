// Multi-repo "project" runners (T18, revised). The PLUGIN owns project definitions
// (plugin storage, editable on the Boat page). On create the provider writes the
// chosen project's repos to ~/.project-repos.txt on the runner (`name url` per line,
// trailing newline) and runs the base box's sync (project-repos.service →
// /usr/local/bin/project-repos-sync.sh, see BOX-CONTRACT.md: clones into ~/workspace/repos/<name>, skips
// dirty repos, removes repos absent from the manifest, gh + the box's GITHUB_TOKEN).
// Then it waits for the clones and registers each repo as a bb project source on
// the machine, so bb's checkout setup reuses it instead of cloning a second copy.
import { z } from "zod";

// ---------------------------------------------------------------- model

export const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
export const REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

export interface ProjectRepo {
  /** Directory name under ~/workspace/repos (and the manifest's first column). */
  name: string;
  /** https://github.com/<owner>/<repo>(.git) — no credentials. */
  url: string;
  /** Stored for the UI/future use; the base's sync manifest has no branch column (UNVERIFIED support). */
  branch?: string;
}

export interface Project {
  name: string;
  repos: ProjectRepo[];
}

/**
 * Only plain https GitHub repo URLs: no credentials, no query/fragment, owner and
 * repo segments only. Returns the canonical form or an error message.
 */
export function validateRepoUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  const s = raw.trim();
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, error: "Not a URL. Use https://github.com/<owner>/<repo>.git" };
  }
  if (u.protocol !== "https:") return { ok: false, error: "Only https:// URLs are allowed" };
  if (u.username || u.password || s.includes("@")) return { ok: false, error: "URLs must not contain credentials (no user:token@)" };
  if (u.hostname.toLowerCase() !== "github.com") return { ok: false, error: "Only github.com repositories are allowed" };
  if (u.search || u.hash || u.port) return { ok: false, error: "No port, query or fragment allowed" };
  const m = /^\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/.exec(u.pathname);
  if (!m) return { ok: false, error: "Expected https://github.com/<owner>/<repo>.git" };
  return { ok: true, url: `https://github.com/${m[1]}/${m[2]}.git` };
}

export const repoSchema = z.object({
  name: z.string().regex(REPO_NAME_RE, "repo name: letters, digits, . _ -"),
  url: z.string(),
  branch: z
    .string()
    .regex(/^[A-Za-z0-9._/-]{1,200}$/)
    .optional(),
});

export function validateRepo(r: unknown): ProjectRepo {
  const p = repoSchema.parse(r);
  const v = validateRepoUrl(p.url);
  if (!v.ok) throw new Error(`${p.name}: ${v.error}`);
  return { name: p.name, url: v.url, ...(p.branch ? { branch: p.branch } : {}) };
}

/**
 * Projects seeded into plugin storage on first use (then edited on the Boat page).
 * Empty: create projects in the UI. A fork can put its own list here.
 */
export const SEED_PROJECTS: Project[] = [];

// ---------------------------------------------------------------- manifest on the runner

export const REPOS_DIR = "/home/user/workspace/repos";
export const MANIFEST = "$HOME/.project-repos.txt";

/** `name url` per line, trailing newline (the box's file API strips it; we write via shell). */
export function manifestText(project: Project): string {
  return project.repos.map((r) => `${r.name} ${r.url}`).join("\n") + "\n";
}

/**
 * Box-user script: write the manifest atomically. Content is validated (names and
 * credential-free https URLs only), so a quoted heredoc is safe.
 */
export function writeManifestScript(project: Project): string {
  for (const r of project.repos) validateRepo(r);
  const body = manifestText(project);
  if (body.includes("BB_PROJECT_MANIFEST_EOF")) throw new Error("manifest contains the heredoc marker");
  return [
    "set -eu",
    `T="${MANIFEST}.tmp.$$"`,
    "cat >\"$T\" <<'BB_PROJECT_MANIFEST_EOF'",
    body.replace(/\n$/, ""),
    "BB_PROJECT_MANIFEST_EOF",
    `mv -f "$T" "${MANIFEST}"`,
    `echo "manifest-written=$(grep -c . "${MANIFEST}")"`,
  ].join("\n");
}

/**
 * Read-only probe (box user). Lines:
 *   manifest=present|absent
 *   repo ok|missing <name> <url-without-credentials>
 * Handles an unterminated last line. Credentials in URLs are removed on the box,
 * before anything is printed.
 */
export function repoProbeScript(): string {
  return [
    "set -u",
    `M="${MANIFEST}"`,
    'if [ ! -s "$M" ]; then echo manifest=absent; exit 0; fi',
    "echo manifest=present",
    'while read -r name url rest || [ -n "${name:-}" ]; do',
    '  case "$name" in ""|\\#*) continue;; esac',
    `  u=$(printf %s "\${url:-}" | sed -E 's#^([A-Za-z][A-Za-z0-9+.-]*://)[^@/]*@#\\1#')`,
    '  if [ -d "$HOME/workspace/repos/$name/.git" ]; then st=ok; else st=missing; fi',
    '  echo "repo $st $name $u"',
    '  name=""; url=""',
    'done <"$M"',
  ].join("\n");
}

export interface RepoState {
  name: string;
  url: string;
  cloned: boolean;
}
export interface RepoProbe {
  manifest: boolean;
  repos: RepoState[];
}

export function parseRepoProbe(stdout: string): RepoProbe {
  const out: RepoProbe = { manifest: false, repos: [] };
  for (const line of stdout.split("\n")) {
    if (line.trim() === "manifest=present") out.manifest = true;
    const m = /^repo (ok|missing) (\S+)(?: (\S+))?\s*$/.exec(line.trim());
    if (m) out.repos.push({ name: m[2]!, url: stripCredentials(m[3] ?? ""), cloned: m[1] === "ok" });
  }
  return out;
}

/** Defence in depth: never keep credentials from a URL. */
export function stripCredentials(url: string): string {
  return url.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^@/]*@/, "$1");
}

/** "github.com/owner/repo" regardless of scheme, credentials, scp form, .git, case. */
export function normalizeRemote(url: string | null | undefined): string | null {
  if (!url) return null;
  let u = url.trim();
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(u);
  if (scp) u = `${scp[1]}/${scp[2]}`;
  u = u.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, "");
  u = u.replace(/^[^@/]*@/, "");
  u = u.replace(/:\d+(?=\/)/, "");
  u = u.replace(/\/+$/, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  u = u.toLowerCase();
  return u.length > 0 && u.includes("/") ? u : null;
}

export type WaitDecision =
  | { status: "done"; repos: RepoState[] }
  | { status: "wait"; progress: string }
  | { status: "timeout"; reason: string };

/** Done when the manifest lists exactly the project's repos and each has a .git dir. */
export function cloneWaitDecision(probe: RepoProbe, project: Project, elapsedMs: number, timeoutMs: number): WaitDecision {
  const want = project.repos.map((r) => r.name);
  const have = new Map(probe.repos.map((r) => [r.name, r]));
  const missing = want.filter((n) => !have.get(n)?.cloned);
  if (probe.manifest && missing.length === 0) return { status: "done", repos: want.map((n) => have.get(n)!) };
  if (elapsedMs >= timeoutMs) {
    return {
      status: "timeout",
      reason: !probe.manifest ? "~/.project-repos.txt is missing on the box" : `missing repos: ${missing.join(", ")}`,
    };
  }
  return { status: "wait", progress: `Cloning ${project.name} repos (${want.length - missing.length}/${want.length})` };
}

// ---------------------------------------------------------------- bb project sources

export interface ProjectLite {
  id: string;
  name: string;
  gitRemoteUrl: string | null;
  sources: { hostId: string; path: string }[];
}

export type SourceAction =
  | { kind: "add"; repo: string; projectId: string; projectName: string; path: string }
  | { kind: "present"; repo: string; projectId: string; projectName: string; path: string }
  | { kind: "create"; repo: string; path: string }
  | { kind: "unmatched"; repo: string; url: string }
  | { kind: "ambiguous"; repo: string; projectNames: string[] };

/** What to register on this host for each cloned repo (pure). */
export function planSources(repos: RepoState[], projects: ProjectLite[], hostId: string, createMissing: boolean): SourceAction[] {
  const byRemote = new Map<string, ProjectLite[]>();
  for (const p of projects) {
    const key = normalizeRemote(p.gitRemoteUrl);
    if (key) byRemote.set(key, [...(byRemote.get(key) ?? []), p]);
  }
  return repos.map((r): SourceAction => {
    const path = `${REPOS_DIR}/${r.name}`;
    const key = normalizeRemote(r.url);
    const hits = key ? (byRemote.get(key) ?? []) : [];
    if (hits.length > 1) return { kind: "ambiguous", repo: r.name, projectNames: hits.map((p) => p.name) };
    const p = hits[0];
    if (!p) return createMissing ? { kind: "create", repo: r.name, path } : { kind: "unmatched", repo: r.name, url: r.url };
    const existing = p.sources.find((s) => s.hostId === hostId);
    if (existing) return { kind: "present", repo: r.name, projectId: p.id, projectName: p.name, path: existing.path };
    return { kind: "add", repo: r.name, projectId: p.id, projectName: p.name, path };
  });
}
