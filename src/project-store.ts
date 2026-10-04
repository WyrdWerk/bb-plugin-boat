// Plugin-owned project definitions (T18). One JSON document in plugin kv storage,
// seeded once (SEED_PROJECTS, empty by default), then edited from the Boat page.
import { PROJECT_NAME_RE, type Project, type ProjectRepo, SEED_PROJECTS, validateRepo } from "./projects.ts";

export interface KvLike {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

const KEY = "projects/v1";
const SEEDED = "projects/seeded";

function checkName(name: string): string {
  const n = name.trim();
  if (!PROJECT_NAME_RE.test(n)) throw new Error(`Project name "${name}": lowercase letters, digits, _ and - (max 63)`);
  return n;
}

export class ProjectStore {
  private readonly kv: KvLike;
  private readonly seed: Project[];
  constructor(kv: KvLike, seed: Project[] = SEED_PROJECTS) {
    this.kv = kv;
    this.seed = seed;
  }

  /** All projects; seeds the seed list the first time only (deleting them later sticks). */
  async list(): Promise<Project[]> {
    const cur = await this.kv.get<Project[]>(KEY);
    if (cur !== undefined) return cur;
    if (await this.kv.get<boolean>(SEEDED)) return [];
    await this.kv.set(KEY, this.seed);
    await this.kv.set(SEEDED, true);
    return structuredClone(this.seed);
  }

  async get(name: string): Promise<Project | null> {
    const n = name.trim().toLowerCase();
    return (await this.list()).find((p) => p.name === n) ?? null;
  }

  private async save(all: Project[]): Promise<void> {
    await this.kv.set(KEY, all);
  }

  private async mustGet(all: Project[], name: string): Promise<Project> {
    const p = all.find((x) => x.name === name.trim().toLowerCase());
    if (!p) throw new Error(`No project "${name}"`);
    return p;
  }

  async create(name: string): Promise<Project> {
    const n = checkName(name.toLowerCase());
    const all = await this.list();
    if (all.some((p) => p.name === n)) throw new Error(`Project "${n}" already exists`);
    const p: Project = { name: n, repos: [] };
    await this.save([...all, p]);
    return p;
  }

  async rename(name: string, newName: string): Promise<Project> {
    const n = checkName(newName.toLowerCase());
    const all = await this.list();
    const p = await this.mustGet(all, name);
    if (n !== p.name && all.some((x) => x.name === n)) throw new Error(`Project "${n}" already exists`);
    p.name = n;
    await this.save(all);
    return p;
  }

  /** confirmName must equal the project name (typed in the UI). */
  async delete(name: string, confirmName: string): Promise<void> {
    const all = await this.list();
    const p = await this.mustGet(all, name);
    if (confirmName.trim() !== p.name) throw new Error(`Confirmation does not match: type ${p.name} exactly to delete it`);
    await this.save(all.filter((x) => x !== p));
  }

  async addRepo(project: string, repo: ProjectRepo): Promise<Project> {
    const r = validateRepo(repo);
    const all = await this.list();
    const p = await this.mustGet(all, project);
    if (p.repos.some((x) => x.name === r.name)) throw new Error(`${p.name} already has a repo named ${r.name}`);
    p.repos.push(r);
    await this.save(all);
    return p;
  }

  async updateRepo(project: string, repoName: string, repo: ProjectRepo): Promise<Project> {
    const r = validateRepo(repo);
    const all = await this.list();
    const p = await this.mustGet(all, project);
    const i = p.repos.findIndex((x) => x.name === repoName);
    if (i < 0) throw new Error(`${p.name} has no repo named ${repoName}`);
    if (r.name !== repoName && p.repos.some((x) => x.name === r.name)) throw new Error(`${p.name} already has a repo named ${r.name}`);
    p.repos[i] = r;
    await this.save(all);
    return p;
  }

  async removeRepo(project: string, repoName: string): Promise<Project> {
    const all = await this.list();
    const p = await this.mustGet(all, project);
    if (!p.repos.some((x) => x.name === repoName)) throw new Error(`${p.name} has no repo named ${repoName}`);
    p.repos = p.repos.filter((x) => x.name !== repoName);
    await this.save(all);
    return p;
  }
}
