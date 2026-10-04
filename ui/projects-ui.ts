// Pure helpers for the Projects section (T18). Validation is shared with the server
// (src/projects.ts) so the dialog rejects what the RPC would reject.
import { REPO_NAME_RE, validateRepoUrl } from "../src/projects.ts";

export interface PickerRepo {
  owner: string;
  name: string;
  url: string;
  isPrivate: boolean;
  defaultBranch: string | null;
}

/** Case-insensitive search over owner/name; at most `limit` results. */
export function filterRepos(repos: PickerRepo[], query: string, limit = 50): PickerRepo[] {
  const q = query.trim().toLowerCase();
  const hits = q === "" ? repos : repos.filter((r) => `${r.owner}/${r.name}`.toLowerCase().includes(q));
  return hits.slice(0, limit);
}

/** Repo name from a GitHub URL (the directory under ~/workspace/repos). */
export function repoNameFromUrl(url: string): string {
  const m = /\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? m[1]! : "";
}

/** Dialog-side validation; returns the repo to submit or an error. */
export function checkRepoForm(form: { name: string; url: string; branch: string }):
  | { ok: true; repo: { name: string; url: string; branch?: string } }
  | { ok: false; error: string } {
  const v = validateRepoUrl(form.url);
  if (!v.ok) return { ok: false, error: v.error };
  const name = (form.name.trim() || repoNameFromUrl(v.url)).trim();
  if (!REPO_NAME_RE.test(name)) return { ok: false, error: "Repo name: letters, digits, . _ - only" };
  const branch = form.branch.trim();
  if (branch !== "" && !/^[A-Za-z0-9._/-]{1,200}$/.test(branch)) return { ok: false, error: "Branch: letters, digits, . _ / - only" };
  return { ok: true, repo: { name, url: v.url, ...(branch ? { branch } : {}) } };
}
