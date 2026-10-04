// Repo picker data (T18): `gh repo list <owner>` on the hub (needs gh logged in there).
// bb's builtin github plugin exposes no RPC, so we don't use it.
// Never returns tokens: only name / url / isPrivate / default branch, URLs stripped
// of any credentials. Cached ~10 min. gh missing or unauthenticated → "unavailable"
// (the UI keeps manual URL entry).
import { z } from "zod";
import { stripCredentials } from "./projects.ts";

export interface GhRun {
  (args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface RepoListing {
  owner: string;
  name: string;
  url: string;
  isPrivate: boolean;
  defaultBranch: string | null;
}

export type RepoListResult =
  | { status: "ok"; repos: RepoListing[]; fetchedAt: number; cached: boolean }
  | { status: "unavailable"; reason: string };

const ghRepoSchema = z.object({
  name: z.string(),
  url: z.string(),
  isPrivate: z.boolean().optional(),
  defaultBranchRef: z.object({ name: z.string() }).nullable().optional(),
});

export function parseGhRepoList(owner: string, stdout: string): RepoListing[] {
  const raw = z.array(z.unknown()).parse(JSON.parse(stdout));
  return raw.map((r) => {
    const p = ghRepoSchema.parse(r);
    return { owner, name: p.name, url: stripCredentials(p.url), isPrivate: p.isPrivate ?? false, defaultBranch: p.defaultBranchRef?.name ?? null };
  });
}

/** Turn gh's failure into a short, safe reason (no stderr passthrough beyond a hint). */
export function unavailableReason(err: unknown, stderr = ""): string {
  if (err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === "ENOENT") return "gh is not installed on the bb server";
  if (/auth login|not logged|authentication|HTTP 401/i.test(stderr)) return "gh on the bb server is not logged in (run `gh auth login` there)";
  return "gh repo list failed on the bb server";
}

export function createRepoLister(opts: { runGh: GhRun; owners: () => Promise<string[]>; now: () => number; ttlMs?: number }) {
  const ttl = opts.ttlMs ?? 10 * 60_000;
  let cache: { key: string; at: number; repos: RepoListing[] } | null = null;
  return async function list(force = false): Promise<RepoListResult> {
    const owners = (await opts.owners()).filter((o) => /^[A-Za-z0-9-]{1,39}$/.test(o));
    if (owners.length === 0) return { status: "unavailable", reason: "no valid GitHub owners configured (setting githubOwners)" };
    const key = owners.join(",");
    if (!force && cache && cache.key === key && opts.now() - cache.at < ttl) {
      return { status: "ok", repos: cache.repos, fetchedAt: cache.at, cached: true };
    }
    const repos: RepoListing[] = [];
    for (const owner of owners) {
      let res;
      try {
        res = await opts.runGh(["repo", "list", owner, "--limit", "300", "--json", "name,url,isPrivate,defaultBranchRef"]);
      } catch (err) {
        return { status: "unavailable", reason: unavailableReason(err) };
      }
      if (res.code !== 0) return { status: "unavailable", reason: unavailableReason(null, res.stderr) };
      try {
        repos.push(...parseGhRepoList(owner, res.stdout));
      } catch {
        return { status: "unavailable", reason: "gh returned output the plugin could not read" };
      }
    }
    repos.sort((a, b) => a.name.localeCompare(b.name));
    cache = { key, at: opts.now(), repos };
    return { status: "ok", repos, fetchedAt: cache.at, cached: false };
  };
}
