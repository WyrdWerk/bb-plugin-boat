// Boat page → Projects (T18): plugin-owned multi-repo projects. A runner created
// with a project gets these repos cloned (base's sync) and registered as bb sources.
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import type { DashboardRpc } from "../src/dashboard.ts";
import { checkRepoForm, filterRepos, type PickerRepo, repoNameFromUrl } from "./projects-ui.ts";
import { SectionFrame } from "./sections.tsx";
import { BOAT_CHANGED } from "./useBoat.ts";

interface Repo {
  name: string;
  url: string;
  branch?: string;
}
interface Project {
  name: string;
  repos: Repo[];
}

type Modal =
  | { kind: "create" }
  | { kind: "rename"; project: string }
  | { kind: "delete"; project: string }
  | { kind: "repo"; project: string; editing: Repo | null }
  | { kind: "remove-repo"; project: string; repo: string };

function FormDialog(props: { title: string; description: string; error: string | null; busy: boolean; submitLabel: string; destructive?: boolean; onSubmit: () => void; onClose: () => void; children: ReactNode }) {
  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : props.onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>{props.description}</DialogDescription>
        </DialogHeader>
        {props.children}
        {props.error ? (
          <p role="alert" className="text-sm text-destructive">
            {props.error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={props.onClose} disabled={props.busy}>
            Cancel
          </Button>
          <Button variant={props.destructive ? "destructive" : "default"} onClick={props.onSubmit} disabled={props.busy}>
            {props.busy ? "Working…" : props.submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span>{label}</span>
      <Input value={value} placeholder={placeholder} autoComplete="off" onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

export function ProjectsSection() {
  const rpc = useRpc<DashboardRpc>();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState<{ status: "loading" } | { status: "ok"; repos: PickerRepo[] } | { status: "unavailable"; reason: string }>({ status: "loading" });

  const refetch = useCallback(() => {
    rpc.call("projects_list", null).then(
      (r) => {
        setProjects(r.projects);
        setError(null);
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime(BOAT_CHANGED, refetch);

  const open = (m: Modal, initial: Record<string, string> = {}) => {
    setModal(m);
    setForm(initial);
    setFormError(null);
    setBusy(false);
    if (m.kind === "repo") {
      setPicker({ status: "loading" });
      rpc.call("repos_list", { refresh: false }).then(setPicker, (e: unknown) => setPicker({ status: "unavailable", reason: e instanceof Error ? e.message : String(e) }));
    }
  };
  const close = () => setModal(null);
  const submit = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      close();
      refetch();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  const set = (k: string) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <SectionFrame
      title="Projects"
      error={error}
      right={
        <Button variant="ghost" size="sm" onClick={() => open({ kind: "create" }, { name: "" })}>
          <Icon name="Plus" className="size-4" />
          New project
        </Button>
      }
    >
      <p className="mb-2 text-xs text-muted-foreground">
        A project is a set of repos. A runner created with a project clones them on the box and registers them as bb project sources.
      </p>
      {projects === null ? null : projects.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">No projects yet.</div>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border bg-card">
          {projects.map((p) => (
            <li key={p.name} className="px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-sm">{p.name}</span>
                <div className="flex gap-1">
                  <Button variant="ghost" size="sm" onClick={() => open({ kind: "repo", project: p.name, editing: null }, { name: "", url: "", branch: "", q: "" })}>
                    <Icon name="Plus" className="size-4" />
                    <span className="hidden md:inline">Add repo</span>
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => open({ kind: "rename", project: p.name }, { name: p.name })}>
                    <Icon name="Pencil" className="size-4" />
                    <span className="hidden md:inline">Rename</span>
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => open({ kind: "delete", project: p.name }, { confirm: "" })}>
                    <Icon name="Trash2" className="size-4" />
                    <span className="hidden md:inline">Delete</span>
                  </Button>
                </div>
              </div>
              <ul className="mt-1 space-y-0.5">
                {p.repos.length === 0 ? <li className="text-xs text-muted-foreground">no repos</li> : null}
                {p.repos.map((r) => (
                  <li key={r.name} className="flex items-center gap-2 text-xs">
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-mono">{r.name}</span> <span className="text-muted-foreground">{r.url}</span>
                      {r.branch ? <span className="text-muted-foreground"> @ {r.branch}</span> : null}
                    </span>
                    <Button variant="ghost" size="sm" aria-label={`Edit ${r.name}`} onClick={() => open({ kind: "repo", project: p.name, editing: r }, { name: r.name, url: r.url, branch: r.branch ?? "", q: "" })}>
                      <Icon name="Pencil" className="size-3.5" />
                    </Button>
                    <Button variant="ghost" size="sm" aria-label={`Remove ${r.name}`} onClick={() => open({ kind: "remove-repo", project: p.name, repo: r.name })}>
                      <Icon name="X" className="size-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}

      {modal?.kind === "create" ? (
        <FormDialog title="New project" description="Lowercase letters, digits, _ and -." error={formError} busy={busy} submitLabel="Create" onClose={close} onSubmit={() => submit(() => rpc.call("project_create", { name: form.name ?? "" }))}>
          <Field label="Project name" value={form.name ?? ""} onChange={set("name")} />
        </FormDialog>
      ) : null}
      {modal?.kind === "rename" ? (
        <FormDialog title={`Rename ${modal.project}`} description="Existing runners keep the repos they cloned." error={formError} busy={busy} submitLabel="Rename" onClose={close} onSubmit={() => submit(() => rpc.call("project_rename", { name: modal.project, newName: form.name ?? "" }))}>
          <Field label="New name" value={form.name ?? ""} onChange={set("name")} />
        </FormDialog>
      ) : null}
      {modal?.kind === "delete" ? (
        <FormDialog title={`Delete ${modal.project}`} description="Removes the project definition from the plugin. Runners and their repos are not touched." error={formError} busy={busy} submitLabel="Delete" destructive onClose={close} onSubmit={() => submit(() => rpc.call("project_delete", { name: modal.project, confirmName: form.confirm ?? "" }))}>
          <Field label="Type the project name to confirm" value={form.confirm ?? ""} placeholder={modal.project} onChange={set("confirm")} />
        </FormDialog>
      ) : null}
      {modal?.kind === "remove-repo" ? (
        <FormDialog title={`Remove ${modal.repo}`} description={`Remove ${modal.repo} from ${modal.project}? New runners won't clone it; existing runners are not touched.`} error={formError} busy={busy} submitLabel="Remove" destructive onClose={close} onSubmit={() => submit(() => rpc.call("project_repo_remove", { project: modal.project, repoName: modal.repo }))}>
          {null}
        </FormDialog>
      ) : null}
      {modal?.kind === "repo" ? (
        <FormDialog
          title={modal.editing ? `Edit ${modal.editing.name}` : `Add a repo to ${modal.project}`}
          description="Pick from GitHub or enter an https://github.com/<owner>/<repo>.git URL. No credentials in URLs; the runner clones with its own GITHUB_TOKEN."
          error={formError}
          busy={busy}
          submitLabel={modal.editing ? "Save" : "Add"}
          onClose={close}
          onSubmit={() => {
            const c = checkRepoForm({ name: form.name ?? "", url: form.url ?? "", branch: form.branch ?? "" });
            if (!c.ok) return setFormError(c.error);
            return submit(() =>
              modal.editing
                ? rpc.call("project_repo_update", { project: modal.project, repoName: modal.editing.name, repo: c.repo })
                : rpc.call("project_repo_add", { project: modal.project, repo: c.repo }),
            );
          }}
        >
          <div className="flex flex-col gap-1 text-sm">
            <span>From GitHub</span>
            {picker.status === "loading" ? <span className="text-xs text-muted-foreground">Loading repos…</span> : null}
            {picker.status === "unavailable" ? <span className="text-xs text-muted-foreground">Repo list unavailable ({picker.reason}). Enter the URL below.</span> : null}
            {picker.status === "ok" ? (
              <>
                <Input value={form.q ?? ""} placeholder="Search repos" autoComplete="off" onChange={(e) => set("q")(e.target.value)} />
                <ul className="max-h-40 overflow-y-auto rounded border border-border">
                  {filterRepos(picker.repos, form.q ?? "").map((r) => (
                    <li key={`${r.owner}/${r.name}`}>
                      <button type="button" className="w-full px-2 py-1 text-left text-xs hover:bg-secondary" onClick={() => setForm((f) => ({ ...f, name: r.name, url: r.url.endsWith(".git") ? r.url : `${r.url}.git`, branch: f.branch ?? "" }))}>
                        {r.owner}/{r.name} {r.isPrivate ? <span className="text-muted-foreground">(private)</span> : null}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </div>
          <Field label="Repo URL (manual)" value={form.url ?? ""} placeholder="https://github.com/<owner>/<repo>.git" onChange={(v) => setForm((f) => ({ ...f, url: v, name: f.name || repoNameFromUrl(v) }))} />
          <Field label="Directory name" value={form.name ?? ""} onChange={set("name")} />
          <Field label="Branch (optional)" value={form.branch ?? ""} onChange={set("branch")} />
        </FormDialog>
      ) : null}
    </SectionFrame>
  );
}
