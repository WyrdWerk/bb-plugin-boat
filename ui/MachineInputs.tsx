// Machine inputs for the "Boat sandbox" choice in the New Thread picker (T17).
import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginMachineProviderInputsProps } from "@get-bb/plugin-sdk/app";
import { Input } from "@/components/ui/input";
import type { DashboardRpc } from "../src/dashboard.ts";
import { formFromValue, type MachineInputsForm, machineInputsChange } from "./machine-inputs.ts";

export function BoatMachineInputs({ value, onChange }: PluginMachineProviderInputsProps) {
  const rpc = useRpc<DashboardRpc>();
  const [form, setForm] = useState<MachineInputsForm>(() => formFromValue(value));
  const [defaults, setDefaults] = useState<{ from: string | null; type: string; projects: string[] } | null>(null);

  useEffect(() => {
    rpc.call("boat_machine_defaults", null).then(setDefaults, () => setDefaults(null));
  }, [rpc]);
  useEffect(() => {
    onChange(machineInputsChange(form, defaults?.projects));
    // onChange identity may change per render; the form is the source of truth.
  }, [form, defaults]);

  return (
    <div className="flex flex-col gap-2 text-sm">
      <label className="flex flex-col gap-1">
        <span>Fork from (Boat box)</span>
        <Input
          value={form.from}
          placeholder={defaults?.from ?? "plugin default"}
          autoComplete="off"
          onChange={(e) => setForm((f) => ({ ...f, from: e.target.value }))}
        />
        <span className="text-xs text-muted-foreground">Blank = the plugin's default source. Each new thread gets its own new box.</span>
      </label>
      <label className="flex flex-col gap-1">
        <span>Project repos</span>
        <select
          className="h-9 rounded-md border border-input bg-transparent px-2"
          value={form.project}
          onChange={(e) => setForm((f) => ({ ...f, project: e.target.value }))}
        >
          <option value="">None</option>
          {(defaults?.projects ?? []).map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <span className="text-xs text-muted-foreground">Clones the project's repos on the new box and registers them as bb project sources.</span>
      </label>
      <label className="flex flex-col gap-1">
        <span>Size</span>
        <select
          className="h-9 rounded-md border border-input bg-transparent px-2"
          value={form.type}
          onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as MachineInputsForm["type"] }))}
        >
          <option value="">{`Default${defaults ? ` (${defaults.type})` : ""}`}</option>
          <option value="small">small</option>
          <option value="default">default</option>
          <option value="large">large</option>
          <option value="xlarge">xlarge</option>
        </select>
      </label>
    </div>
  );
}
