// Inputs control logic for the "Boat sandbox" machine choice (T17). Pure: the
// component in MachineInputs.tsx only renders it. Machine inputs are persisted and
// readable by every plugin, so only non-secret fields: source/from/type.

export interface MachineInputsForm {
  /** Box id to fork; blank = the plugin's default (`from` setting, normally the base box). */
  from: string;
  /** Box size; "" = the plugin's default. */
  type: "" | "small" | "default" | "large" | "xlarge";
  /** T18: multi-repo project to clone and register ("" = none). */
  project: string;
}

export type MachineInputsChange =
  | { status: "ready"; value: { source?: "fork"; from?: string; type?: string; project?: string } }
  | { status: "blocked"; reason: string };

export function machineInputsChange(form: MachineInputsForm, projects?: string[]): MachineInputsChange {
  const from = form.from.trim();
  if (from !== "" && !/^bx_[a-z0-9]+$/.test(from)) return { status: "blocked", reason: "Fork source must be a Boat box id like bx_abc123 (or leave it blank for the default)" };
  const project = form.project.trim();
  if (project !== "" && projects && !projects.includes(project)) {
    return { status: "blocked", reason: `Unknown project "${project}" (Boat page → Projects)` };
  }
  const value: { source?: "fork"; from?: string; type?: string; project?: string } = {};
  if (project !== "") value.project = project;
  if (from !== "") {
    value.source = "fork";
    value.from = from;
  }
  if (form.type !== "") value.type = form.type;
  return { status: "ready", value };
}

/** Read a persisted value back into the form (unknown shapes → defaults). */
export function formFromValue(value: unknown): MachineInputsForm {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const type = typeof v.type === "string" && ["small", "default", "large", "xlarge"].includes(v.type) ? (v.type as MachineInputsForm["type"]) : "";
  return { from: typeof v.from === "string" ? v.from : "", type, project: typeof v.project === "string" ? v.project : "" };
}
