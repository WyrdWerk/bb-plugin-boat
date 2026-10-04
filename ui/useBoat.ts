// Data for the Boat page: one overview fetch, refreshed by the server's
// "boat-changed" signal, a slow timer (Boat state also changes on its own: TTL
// stops, snapshots), and after every action.
import { useCallback, useEffect, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { DashboardRpc, OverviewDto } from "../src/dashboard.ts";
import type { ActionId } from "./actions.ts";

export const BOAT_CHANGED = "boat-changed";

/** An action's outcome: a message, optionally with the bb machine it created (T17). */
export type RunResult = string | { message: string; hostId?: string };
const REFRESH_MS = 30_000;

export function useBoatOverview() {
  const rpc = useRpc<DashboardRpc>();
  const [data, setData] = useState<OverviewDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refetch = useCallback(() => {
    setLoading(true);
    rpc.call("boat_overview", null).then(
      (o) => {
        setData(o);
        setError(null);
        setLoading(false);
      },
      (e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      },
    );
  }, [rpc]);

  useEffect(() => {
    refetch();
    const t = setInterval(refetch, REFRESH_MS);
    return () => clearInterval(t);
  }, [refetch]);
  useRealtime(BOAT_CHANGED, refetch);

  /** Run a confirmed action; resolves to the server's message. */
  const run = useCallback(
    async (id: ActionId, boxId: string, fields: Record<string, number | string>): Promise<RunResult> => {
      switch (id) {
        case "resume":
          return (await rpc.call("boat_resume", { boxId, ttlHours: Number(fields.ttlHours) })).message;
        case "stop":
          return (await rpc.call("boat_stop", { boxId })).message;
        case "fork-runner": {
          const r = await rpc.call("boat_fork_runner", { boxId, requestId: crypto.randomUUID() });
          return { message: r.message, hostId: r.hostId };
        }
        case "fork":
          return (await rpc.call("boat_fork", { boxId, ttlHours: Number(fields.ttlHours), requestId: crypto.randomUUID() }))
            .message;
        case "set-ttl":
          return (await rpc.call("boat_set_ttl", { boxId, hours: Number(fields.hours) })).message;
        case "save-snapshot":
          return (await rpc.call("boat_save_snapshot", { boxId, name: String(fields.name) })).message;
        case "delete":
          return (await rpc.call("boat_delete", { boxId, confirmBoxId: String(fields.confirm), mode: "machine-and-box" })).message;
        case "delete-box-only":
          return (await rpc.call("boat_delete", { boxId, confirmBoxId: String(fields.confirm), mode: "box-only" })).message;
      }
    },
    [rpc],
  );

  return { data, error, loading, refetch, run };
}

/** Running-box count for the sidebar row. */
export function useBoatRunning(): number | null {
  const rpc = useRpc<DashboardRpc>();
  const [running, setRunning] = useState<number | null>(null);
  const refetch = useCallback(() => {
    rpc.call("boat_summary", null).then((s) => setRunning(s.running), () => setRunning(null));
  }, [rpc]);
  useEffect(() => {
    refetch();
    const t = setInterval(refetch, 60_000);
    return () => clearInterval(t);
  }, [refetch]);
  useRealtime(BOAT_CHANGED, refetch);
  return running;
}
