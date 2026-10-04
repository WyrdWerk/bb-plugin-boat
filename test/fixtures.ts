// Sample project list for tests (the plugin itself seeds nothing).
import type { Project } from "../src/projects.ts";

export const SAMPLE_PROJECTS: Project[] = (
  [
    ["webapp", ["webapp", "shared-notes"]],
    ["sites", ["shared-notes", "docs-site", "personal-site", "company-site"]],
    ["sandbox", ["shared-notes", "experiments"]],
    ["content", ["shared-notes", "content-engine", "content-store"]],
    ["privacy", ["privacy-app", "shared-notes"]],
    ["landing", ["landing-site", "shared-notes"]],
    ["video", ["video-pipeline", "video-assets"]],
    ["design", ["design-kit", "html-answers"]],
  ] as const
).map(([name, repos]) => ({ name, repos: repos.map((r) => ({ name: r, url: `https://github.com/example-org/${r}.git` })) }));
