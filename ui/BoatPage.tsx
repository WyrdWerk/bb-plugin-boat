// The Boat page (navPanel component). Layout lives in SECTIONS: reorder, drop or
// add entries to reshape the page (e.g. to mirror Boat's desktop dashboard).
import { type ComponentType, useEffect, useState } from "react";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { ConfirmActionDialog, type PendingAction } from "./ConfirmActionDialog.tsx";
import { ProjectsSection } from "./ProjectsSection.tsx";
import { BoxesSection, type SectionProps, SnapshotsSection, WalletSection } from "./sections.tsx";
import { useBoatOverview, useBoatRunning } from "./useBoat.ts";
import { ago } from "./format.ts";

export const SECTIONS: { id: string; component: ComponentType<SectionProps> }[] = [
  { id: "wallet", component: WalletSection },
  { id: "boxes", component: BoxesSection },
  { id: "snapshots", component: SnapshotsSection },
  { id: "projects", component: ProjectsSection },
];

function useNow(ms = 15_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function BoatPage(_props: PluginNavPanelProps) {
  const { data, error, loading, refetch, run } = useBoatOverview();
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [notice, setNotice] = useState<{ message: string; hostId?: string } | null>(null);
  const now = useNow();

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-6xl px-4 pb-6 pt-3 md:px-5 md:pt-4">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">
            Boat sandboxes on the team wallet. Every action asks first; delete needs the box id typed.
          </p>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {data ? <span>updated {ago(data.fetchedAt, now)}</span> : null}
            <Button variant="ghost" size="sm" onClick={refetch} disabled={loading} aria-label="Refresh">
              <Icon name="RefreshCw" className="size-4" />
            </Button>
          </div>
        </div>
        {error ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p role="status" className="mt-3 text-sm">
            {notice.message}
            {notice.hostId ? (
              <>
                {" "}
                <a className="underline underline-offset-4" href={`/settings/machines/${encodeURIComponent(notice.hostId)}`}>
                  Open the new machine
                </a>
              </>
            ) : null}
          </p>
        ) : null}
        {data === null ? (
          <p className="mt-6 text-sm text-muted-foreground">Loading…</p>
        ) : !data.configured ? (
          <div className="mt-6 rounded-lg border border-dashed border-border px-4 py-6 text-sm">
            <p>{data.setupMessage}</p>
            <p className="mt-1 text-muted-foreground">
              Settings → Plugins → Boat, or <code>bb plugin config boat</code>.
            </p>
          </div>
        ) : (
          SECTIONS.map(({ id, component: Section }) => (
            <Section key={id} data={data} now={now} onAction={(action, box) => setPending({ id: action, box })} />
          ))
        )}
      </div>
      <ConfirmActionDialog
        pending={pending}
        onClose={() => setPending(null)}
        onRun={async (id, boxId, fields) => {
          const result = await run(id, boxId, fields);
          setNotice(typeof result === "string" ? { message: result } : result);
          refetch();
          return result;
        }}
      />
    </div>
  );
}

/** Sidebar row accessory: running-box count (narrow, no controls). */
export function RunningCount() {
  const running = useBoatRunning();
  if (running === null) return null;
  return <span className="text-xs tabular-nums text-muted-foreground">{running} running</span>;
}
