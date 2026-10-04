// Confirmation for every state-changing action: says what happens, collects the
// action's inputs, and only then calls the server.
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { BoxDto } from "../src/dashboard.ts";
import { ACTIONS, type ActionId, parseFields } from "./actions.ts";

export interface PendingAction {
  id: ActionId;
  box: BoxDto;
}

export function ConfirmActionDialog({
  pending,
  onClose,
  onRun,
}: {
  pending: PendingAction | null;
  onClose: () => void;
  onRun: (id: ActionId, boxId: string, fields: Record<string, number | string>) => Promise<unknown>;
}) {
  const spec = pending ? ACTIONS[pending.id] : null;
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setValues(Object.fromEntries((spec?.fields ?? []).map((f) => [f.key, f.initial])));
    setError(null);
    setBusy(false);
  }, [pending, spec]);

  if (!pending || !spec) return null;

  const confirm = async () => {
    const parsed = parseFields(spec.id, values, pending.box);
    if (typeof parsed === "string") {
      setError(parsed);
      return;
    }
    setBusy(true);
    try {
      await onRun(spec.id, pending.box.id, parsed);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {spec.label} <span className="font-mono">{pending.box.id}</span>
          </DialogTitle>
          <DialogDescription>{spec.confirm(pending.box)}</DialogDescription>
        </DialogHeader>
        {spec.fields.map((f) => (
          <label key={f.key} className="flex flex-col gap-1 text-sm">
            <span>{f.label}</span>
            <Input
              type={f.kind === "number" ? "number" : "text"}
              autoComplete="off"
              placeholder={f.kind === "confirm-id" ? pending.box.id : undefined}
              value={values[f.key] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            />
            {f.hint ? <span className="text-xs text-muted-foreground">{f.hint}</span> : null}
          </label>
        ))}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant={spec.destructiveTone ? "destructive" : "default"} onClick={confirm} disabled={busy}>
            {busy ? "Working…" : spec.label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
