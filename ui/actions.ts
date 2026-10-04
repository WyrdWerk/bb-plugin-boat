// Per-box actions for the Boat page: availability by state and confirmation copy.
// Pure (no React) so the rules are unit-tested. Every action here changes state
// or costs money, so the page always confirms. Delete since T16 (typed confirmation).
import type { BoxDto } from "../src/dashboard.ts";
import { machineStuck } from "../src/machine-state.ts";

export type ActionId = "resume" | "stop" | "fork-runner" | "fork" | "set-ttl" | "save-snapshot" | "delete" | "delete-box-only";

export interface ActionField {
  key: "ttlHours" | "hours" | "name" | "confirm";
  label: string;
  /** confirm-id: the user must type the box id exactly. */
  kind: "number" | "text" | "confirm-id";
  /** Initial value shown in the dialog. */
  initial: string;
  hint?: string;
}

export interface ActionSpec {
  id: ActionId;
  label: string;
  icon: string;
  /** Shown in the confirmation dialog; says what happens and what it costs. */
  confirm: (box: BoxDto) => string;
  fields: ActionField[];
  destructiveTone: boolean;
}

const LIVE = new Set(["ready", "idle", "running"]);
const STOPPED = new Set(["archived", "stopped"]);

export const ACTIONS: Record<ActionId, ActionSpec> = {
  resume: {
    id: "resume",
    label: "Resume",
    icon: "Play",
    confirm: (b) =>
      `Resume ${b.id}${b.name ? ` (${b.name})` : ""}? This counts as one machine start on the team wallet and bills while it runs.` +
      (b.machine ? ` bb machine ${b.machine.name} reconnects after Boat finishes restoring (~2–3 min).` : ""),
    fields: [{ key: "ttlHours", label: "Auto-stop after (hours)", kind: "number", initial: "4" }],
    destructiveTone: false,
  },
  stop: {
    id: "stop",
    label: "Stop",
    icon: "Square",
    confirm: (b) =>
      `Stop ${b.id}? Boat snapshots the disk first, then archives the box.` +
      (b.machine ? ` Threads running on bb machine ${b.machine.name} will be cut off. Prefer suspending it from bb.` : ""),
    fields: [],
    destructiveTone: true,
  },
  "fork-runner": {
    id: "fork-runner",
    label: "Fork as bb runner",
    icon: "Server",
    confirm: (b) =>
      `Create a new bb machine from a fork of ${b.id}${b.name ? ` (${b.name})` : ""}. bb runs the full setup: fork, disk check, runner conversion, hub check and enrollment (a few minutes); the machine then appears in Machines. ${b.id} itself is not changed. The new box bills while it runs (one machine start).`,
    fields: [],
    destructiveTone: false,
  },
  fork: {
    id: "fork",
    label: "Plain fork (no bb runner)",
    icon: "GitFork",
    confirm: (b) =>
      `Fork ${b.id} from its latest snapshot into a NEW billable box (one machine start).` +
      (b.machine
        ? ` This box is bb machine ${b.machine.name}: the fork copies its runner identity. It must run runner-ensure before any bb daemon starts (T1), or it will impersonate this machine.`
        : ""),
    fields: [{ key: "ttlHours", label: "Fork auto-stop after (hours)", kind: "number", initial: "1", hint: "Forks don't inherit TTL" }],
    destructiveTone: false,
  },
  "set-ttl": {
    id: "set-ttl",
    label: "Set TTL",
    icon: "Timer",
    confirm: (b) => `Set ${b.id} to auto-stop N hours from now (replaces the current deadline).`,
    fields: [{ key: "hours", label: "Hours from now", kind: "number", initial: "2" }],
    destructiveTone: false,
  },
  "save-snapshot": {
    id: "save-snapshot",
    label: "Save snapshot",
    icon: "Camera",
    confirm: (b) => `Save ${b.id}'s current disk as a named snapshot. Named snapshots can seed new boxes and machines.`,
    fields: [{ key: "name", label: "Snapshot name", kind: "text", initial: "", hint: "lowercase, digits, dashes" }],
    destructiveTone: false,
  },
  delete: {
    id: "delete",
    label: "Delete",
    icon: "Trash2",
    confirm: (b) =>
      b.machine
        ? `PERMANENT. ${b.id} is bb machine ${b.machine.name}. This removes the machine in bb first (bb tears down its environments), then deletes the box: its disk and its snapshots are gone for good.`
        : `PERMANENT. Deletes ${b.id}${b.name ? ` (${b.name})` : ""}: its disk and its snapshots are gone for good.`,
    fields: [{ key: "confirm", label: "Type the box id to confirm", kind: "confirm-id", initial: "" }],
    destructiveTone: true,
  },
  "delete-box-only": {
    id: "delete-box-only",
    label: "Delete box only",
    icon: "Trash",
    confirm: (b) =>
      `PERMANENT. Deletes ${b.id} (disk and snapshots) WITHOUT bb's cleanup. bb machine ${b.machine?.name ?? "?"} is ${b.machine?.status ?? "?"} (${b.machine?.phase ?? "?"}); its record stays in bb until bb can clean it up (resume the box instead if you want bb to finish).`,
    fields: [{ key: "confirm", label: "Type the box id to confirm", kind: "confirm-id", initial: "" }],
    destructiveTone: true,
  },
};

/** Actions offered for a box in its current state. */
export function actionsFor(box: BoxDto): ActionId[] {
  // The base box (fork source for runners) is never changed from bb: fork only, never deleted.
  if (box.isBase) return LIVE.has(box.state) || STOPPED.has(box.state) ? ["fork-runner", "fork"] : [];
  const del: ActionId[] = ["delete"];
  if (box.machine && machineStuck(box.machine)) del.push("delete-box-only");
  if (LIVE.has(box.state)) return ["stop", "set-ttl", "fork-runner", "fork", "save-snapshot", ...del];
  if (STOPPED.has(box.state)) return ["resume", "fork-runner", "fork", "set-ttl", ...del];
  if (box.state === "error") return del;
  return []; // transitioning: wait for Boat
}

/** Parse dialog input into RPC input; returns an error string for the dialog. */
export function parseFields(id: ActionId, values: Record<string, string>, box?: { id: string }): Record<string, number | string> | string {
  const out: Record<string, number | string> = {};
  for (const f of ACTIONS[id].fields) {
    const raw = (values[f.key] ?? f.initial).trim();
    if (f.kind === "confirm-id") {
      if (!box || raw !== box.id) return `Type ${box?.id ?? "the box id"} exactly to confirm`;
      out[f.key] = raw;
    } else if (f.kind === "number") {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0.25 || n > 720) return `${f.label}: enter 0.25–720`;
      out[f.key] = n;
    } else {
      if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(raw)) return `${f.label}: ${f.hint ?? "invalid"}`;
      out[f.key] = raw;
    }
  }
  return out;
}
