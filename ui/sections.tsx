// The Boat page's sections. Each is self-contained and takes the same props, so
// BoatPage can reorder, drop or regroup them (see SECTIONS there) when the
// layout is matched to Boat's dashboard.
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { BoxDto, OverviewDto } from "../src/dashboard.ts";
import { ACTIONS, type ActionId, actionsFor } from "./actions.ts";
import { agentsSummary, ago, bytes, healthLabel, stateBadge, type Tone, ttlLabel } from "./format.ts";

export interface SectionProps {
  data: OverviewDto;
  now: number;
  onAction: (id: ActionId, box: BoxDto) => void;
}

const TONE: Record<Tone, string> = {
  ok: "bg-secondary text-foreground",
  busy: "bg-secondary text-muted-foreground",
  idle: "text-muted-foreground",
  warn: "border border-border text-foreground",
  bad: "border border-destructive text-destructive",
};

export function Badge({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cn("inline-flex items-center rounded px-1.5 py-0.5 text-xs", TONE[tone])}>
      {children}
    </span>
  );
}

export function SectionFrame({ title, error, children, right }: { title: string; error?: string | null; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="mt-5">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-medium">{title}</h2>
        {right}
      </div>
      {error ? (
        <p role="alert" className="mb-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-sm">{value}</div>
    </div>
  );
}

export function WalletSection({ data }: SectionProps) {
  const w = data.wallet.items;
  const n = (v: number | null) => (v === null ? "—" : String(v));
  return (
    <SectionFrame title="Wallet" error={data.wallet.error}>
      {w === null ? (
        <Empty>No wallet data.</Empty>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat
            label="Wallet"
            value={
              <>
                {w.org} {w.canStart === false ? <Badge tone="bad">{w.blockedReason ?? "blocked"}</Badge> : null}
              </>
            }
          />
          <Stat label="Active boxes" value={`${n(w.activeBoxes)} / ${n(w.maxActiveBoxes)}`} />
          <Stat label="Credit" value={w.creditHours === null ? "—" : `${w.creditHours} h`} />
          <Stat
            label="Starts left (min / hour / day)"
            value={w.startsUnlimited ? "unlimited" : `${n(w.startsRemaining.minute)} / ${n(w.startsRemaining.hour)} / ${n(w.startsRemaining.day)}`}
          />
        </div>
      )}
    </SectionFrame>
  );
}

/** Columns are data, so the table is easy to reshape. */
const BOX_COLUMNS: { key: string; label: string; cell: (b: BoxDto, now: number) => ReactNode; className?: string }[] = [
  {
    key: "box",
    label: "Box",
    cell: (b) => (
      <div className="min-w-0">
        <div className="truncate">{b.name ?? "—"}</div>
        <div className="font-mono text-xs text-muted-foreground">
          {b.id} {b.isBase ? <Badge tone="warn">base</Badge> : null}
        </div>
      </div>
    ),
  },
  {
    key: "state",
    label: "State",
    cell: (b) => {
      const s = stateBadge(b.state);
      return <Badge tone={s.tone}>{s.label}</Badge>;
    },
  },
  { key: "type", label: "Type", cell: (b) => b.type ?? "—", className: "hidden md:table-cell" },
  { key: "ttl", label: "Auto-stop", cell: (b, now) => (b.archiveAfter === null ? "—" : ttlLabel(b.archiveAfter, now)) },
  {
    key: "health",
    label: "Health",
    cell: (b) => {
      const h = healthLabel(b.health, b.error);
      return (
        <Badge tone={h.tone} title={h.detail ?? undefined}>
          {h.text}
        </Badge>
      );
    },
  },
  {
    key: "snapshot",
    label: "Snapshot",
    cell: (b, now) => (
      <span className="text-xs">
        {b.lastSnapshotStatus ?? "—"} <span className="text-muted-foreground">{ago(b.snapshotCompletedAt, now)}</span>
      </span>
    ),
    className: "hidden lg:table-cell",
  },
  {
    key: "agents",
    label: "Agents",
    cell: (b) => {
      const a = agentsSummary(b.agentUpdates);
      return (
        <Badge tone={a.tone} title={b.agentUpdates ?? "no agents-update result seen yet"}>
          {a.text}
        </Badge>
      );
    },
    className: "hidden lg:table-cell",
  },
  {
    key: "machine",
    label: "bb machine",
    cell: (b) =>
      b.machine === null ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        // bb's machine settings route (/settings/machines/:hostId); no SDK navigation target exists for it yet.
        <a className="underline-offset-4 hover:underline" href={`/settings/machines/${encodeURIComponent(b.machine.hostId)}`}>
          {b.machine.name} <span className="text-xs text-muted-foreground">{b.machine.status}</span>
        </a>
      ),
  },
];

export function BoxesSection({ data, now, onAction }: SectionProps) {
  const boxes = data.boxes.items;
  return (
    <SectionFrame title={`Boxes${boxes ? ` (${boxes.length})` : ""}`} error={data.boxes.error}>
      {boxes === null ? (
        <Empty>No box data.</Empty>
      ) : boxes.length === 0 ? (
        <Empty>No boxes on this account.</Empty>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                {BOX_COLUMNS.map((c) => (
                  <th key={c.key} className={cn("px-3 py-2 font-normal", c.className)}>
                    {c.label}
                  </th>
                ))}
                <th className="px-3 py-2 text-right font-normal">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {boxes.map((b) => (
                <tr key={b.id} className="align-middle">
                  {BOX_COLUMNS.map((c) => (
                    <td key={c.key} className={cn("px-3 py-2", c.className)}>
                      {c.cell(b, now)}
                    </td>
                  ))}
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1">
                      {actionsFor(b).map((id) => (
                        <Button key={id} variant="ghost" size="sm" onClick={() => onAction(id, b)} aria-label={`${ACTIONS[id].label} ${b.id}`}>
                          <Icon name={ACTIONS[id].icon} className="size-4" />
                          <span className="hidden xl:inline">{ACTIONS[id].label}</span>
                        </Button>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionFrame>
  );
}

export function SnapshotsSection({ data, now }: SectionProps) {
  const snaps = data.snapshots.items;
  return (
    <SectionFrame title="Named snapshots" error={data.snapshots.error}>
      {snaps === null || snaps.length === 0 ? (
        <Empty>{snaps === null ? "No snapshot data." : "No named snapshots."}</Empty>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border bg-card px-3">
          {snaps.map((s) => (
            <li key={s.name} className="flex items-center gap-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate font-mono">{s.name}</span>
              <Badge tone={s.status === "ready" ? "ok" : s.status === "failed" ? "bad" : "busy"}>{s.status ?? "—"}</Badge>
              <span className="hidden font-mono text-xs text-muted-foreground sm:inline">{s.sourceBoxId ?? ""}</span>
              <span className="text-xs text-muted-foreground">{bytes(s.sizeBytes)}</span>
              <span className="text-xs text-muted-foreground">{ago(s.createdAt, now)}</span>
            </li>
          ))}
        </ul>
      )}
    </SectionFrame>
  );
}
