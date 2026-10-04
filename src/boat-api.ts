// Minimal Boat (boat.dev, formerly ASCII Box) REST client for the machine provider.
//
// Only the calls the provider needs. Responses are parsed at this boundary and
// secret-bearing box fields (url, ip, sshEndpoint, subdomain, desktopUrl) are
// dropped here, so nothing downstream can log or persist them.
import { z } from "zod";

export const BOAT_API_BASE = "https://boat.dev/api/box/v1";

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ status: number; text(): Promise<string> }>;

/** Non-secret view of a box. */
export const boxSchema = z.object({
  id: z.string(),
  name: z.string().nullable().optional(),
  state: z.string(),
  error: z.string().nullable().optional(),
  health: z.string().nullable().optional(),
  archiveAfter: z.string().nullable().optional(),
  type: z.string().nullable().optional(),
  createdAt: z.string().nullable().optional(),
  snapshotAvailable: z.boolean().nullable().optional(),
  lastSnapshotStatus: z.string().nullable().optional(),
  snapshotCompletedAt: z.string().nullable().optional(),
});
export type Box = z.infer<typeof boxSchema>;

const commandResultSchema = z.object({
  exitCode: z.number().nullable(),
  stdout: z.string().default(""),
  stderr: z.string().default(""),
  timedOut: z.boolean().optional(),
});
export type CommandResult = z.infer<typeof commandResultSchema>;

/** GET /limits (wallet-scoped). Fields per the 2026-09 reference; all optional. */
// Tolerant by design: the wallet card must survive fields we don't render or
// shapes we haven't seen. Each rendered field falls back to null on a type
// mismatch, and unknown fields pass through. Seen live 2026-10-04 (`boat limits
// --json`): starts = {day|hour|minute: {limit, remaining, used}, unlimited: false}.
const optStr = z.string().nullable().optional().catch(null);
const optNum = z.number().nullable().optional().catch(null);
const optBool = z.boolean().nullable().optional().catch(null);
const startWindow = z
  .object({ limit: optNum, remaining: optNum, used: optNum })
  .passthrough()
  .nullable()
  .optional()
  .catch(null);

export const limitsSchema = z
  .object({
    teamId: optStr,
    canStart: optBool,
    blockedReason: optStr,
    accessTier: optStr,
    activeBoxes: optNum,
    maxActiveBoxes: optNum,
    creditBalanceSeconds: optNum,
    subscriptionStatus: optStr,
    starts: z
      .object({ minute: startWindow, hour: startWindow, day: startWindow, unlimited: optBool })
      .passthrough()
      .nullable()
      .optional()
      .catch(null),
  })
  .passthrough();
export type Limits = z.infer<typeof limitsSchema>;

/** GET /named-snapshots entries. */
export const namedSnapshotSchema = z.object({
  name: z.string(),
  status: z.string().nullable().optional(),
  sourceBoxId: z.string().nullable().optional(),
  type: z.string().nullable().optional(),
  sizeBytes: z.number().nullable().optional(),
  createdAt: z.string().nullable().optional(),
});
export type NamedSnapshot = z.infer<typeof namedSnapshotSchema>;

export class BoatApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Boat's `message` as sent. */
  readonly boatMessage: string;
  /** Boat's error details, stringified and truncated. For matching only; never logged. */
  readonly detail: string;
  constructor(status: number, code: string, message: string, detail = "") {
    super(`Boat API ${status} ${code}: ${message}`);
    this.status = status;
    this.code = code;
    this.boatMessage = message;
    this.detail = detail;
  }
}

/**
 * T9: errors meaning "the box didn't take the command; it isn't ready yet". Safe to
 * retry because the command never ran:
 *   - 502 box_direct_failed whose message/detail says box_restoring: seen live
 *     2026-10-04 while its state was already `idle` (lazy restore),
 *   - 409 box_starting and machine_not_running (reference: box not up yet),
 *   - the same under Boat's new names: sandbox_direct_failed / sandbox_restoring /
 *     sandbox_starting (T10; the CLI already uses them).
 * Any other 502 is NOT retryable: the reference warns a 502 can mean the command
 * already ran.
 */
export function notReadyYet(err: unknown): string | null {
  if (!(err instanceof BoatApiError)) return null;
  const code = canonicalCode(err.code);
  if (code === "box_direct_failed" && /\b(?:box|sandbox)_restoring\b/i.test(`${err.boatMessage} ${err.detail}`)) return "box_restoring";
  if (code === "box_starting" || code === "machine_not_running") return code;
  return null;
}

/**
 * Boat is renaming box → sandbox (T10, live 2026-10-04): the API sent
 * `box_direct_failed`/`box_restoring` while the boat CLI reports
 * `sandbox_direct_failed`/`sandbox_restoring` for the same refusal. Compare codes
 * through this: lower-case, and a `sandbox_` prefix reads as `box_`.
 */
export function canonicalCode(code: string): string {
  const c = code.trim().toLowerCase();
  return c.startsWith("sandbox_") ? `box_${c.slice("sandbox_".length)}` : c;
}

export interface CreateFromSnapshot {
  kind: "snapshot";
  /** Named snapshot, e.g. a runner template baked with runner-ensure installed. */
  from: string;
}
export interface CreateByFork {
  kind: "fork";
  /** Source box id. */
  boxId: string;
}
export type BoxSource = CreateFromSnapshot | CreateByFork;

export interface CreateBoxRequest {
  source: BoxSource;
  /** Omitted: Boat picks its default name (e.g. "<source> fork"). */
  name?: string;
  org: string;
  ttlSeconds: number;
  type?: string;
  idempotencyKey: string;
}

/** States in which machine-gated calls (commands, files) work. */
export const LIVE_STATES = new Set(["ready", "idle", "running"]);
/** States the CLI shows as stopped (archived snapshot). */
export const STOPPED_STATES = new Set(["archived", "stopped"]);
/** Transitional states on the way to stopped. */
export const STOPPING_STATES = new Set(["stopping", "archiving"]);

export interface DeleteWaitOptions {
  signal?: AbortSignal;
  /** Between polls (default 5 s). */
  pollMs?: number;
  /** Bound on the whole delete (default 3 min); then deletion_timeout. */
  maxMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Step log (no secrets: ids, statuses, reasons). */
  log?: (message: string) => void;
}

// Shapes not yet seen live (reference: "202 and a deletion operation id"); accept
// the plausible spellings and fail loudly on unknown statuses only at the bound.
const DELETION_DONE = new Set(["completed", "complete", "succeeded", "success", "done", "deleted"]);
const DELETION_FAILED = new Set(["failed", "error", "cancelled", "canceled"]);

export function deletionOperationId(json: Record<string, unknown>): string | null {
  const op = (json.deletionOperation ?? json.operation ?? null) as Record<string, unknown> | null;
  const id = json.deletionOperationId ?? json.operationId ?? op?.id ?? null;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export function deletionStatus(json: Record<string, unknown>): string {
  const op = (json.deletionOperation ?? json.operation ?? json) as Record<string, unknown>;
  const s = op.status ?? op.state ?? "";
  return typeof s === "string" ? s.toLowerCase() : "";
}

export class BoatApi {
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly base: string;

  constructor(apiKey: string, fetchImpl: FetchLike, base: string = BOAT_API_BASE) {
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.base = base;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    opts: { idempotencyKey?: string; confirmDelete?: string; signal?: AbortSignal } = {},
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.apiKey}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
    // Boat gates deletes: without this header DELETE returns 409 delete_confirmation_required.
    if (opts.confirmDelete) headers["X-Ascii-Confirm-Delete"] = opts.confirmDelete;
    const res = await this.fetchImpl(this.base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: opts.signal,
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      throw new BoatApiError(res.status, "invalid_json", "non-JSON response");
    }
    if (res.status >= 400 || json.ok === false) {
      const errObj = (typeof json.error === "object" && json.error !== null ? json.error : {}) as Record<string, unknown>;
      const code = typeof json.code === "string" ? json.code : typeof errObj.code === "string" ? errObj.code : "http_error";
      const message = typeof json.message === "string" ? json.message : `HTTP ${res.status}`;
      const err = (json.error ?? {}) as Record<string, unknown>;
      const raw = json.details ?? err.details ?? json.detail ?? err.detail ?? (typeof json.error === "string" ? json.error : null);
      const detail = raw === null || raw === undefined ? "" : (typeof raw === "string" ? raw : JSON.stringify(raw)).slice(0, 500);
      throw new BoatApiError(res.status, code, message, detail);
    }
    return json;
  }

  /** Box objects come either bare or wrapped in `box`/`sandbox`. */
  private static pickBox(json: Record<string, unknown>): Box {
    const raw = (json.box ?? json.sandbox ?? json) as Record<string, unknown>;
    return boxSchema.parse(raw);
  }

  async getBox(id: string, signal?: AbortSignal): Promise<Box | null> {
    try {
      return BoatApi.pickBox(await this.request("GET", `/boxes/${encodeURIComponent(id)}`, undefined, { signal }));
    } catch (err) {
      if (err instanceof BoatApiError && err.status === 404) return null;
      throw err;
    }
  }

  /** Every box the key may touch, all states, following pagination (bounded). */
  async listBoxes(signal?: AbortSignal): Promise<Box[]> {
    const out: Box[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const q = new URLSearchParams({ limit: "200" });
      if (cursor) q.set("cursor", cursor);
      const json = await this.request("GET", `/boxes?${q}`, undefined, { signal });
      for (const b of z.array(z.unknown()).parse(json.boxes ?? json.sandboxes ?? [])) out.push(boxSchema.parse(b));
      const info = (json.pageInfo ?? {}) as { hasMore?: boolean; nextCursor?: string | null };
      if (!info.hasMore || !info.nextCursor) break;
      cursor = info.nextCursor;
    }
    return out;
  }

  /** Wallet readiness and quotas for an org (team wallet). Non-secret fields only. */
  async getLimits(org: string, signal?: AbortSignal): Promise<Limits> {
    const json = await this.request("GET", `/limits?${new URLSearchParams({ org })}`, undefined, { signal });
    return limitsSchema.parse(json.limits ?? json);
  }

  async listNamedSnapshots(signal?: AbortSignal): Promise<NamedSnapshot[]> {
    const json = await this.request("GET", "/named-snapshots", undefined, { signal });
    const raw = z.array(z.unknown()).parse(json.namedSnapshots ?? json.snapshots ?? json.items ?? []);
    return raw.map((r) => namedSnapshotSchema.parse(r));
  }

  /**
   * Save a box's current state as a named snapshot. Body shape NOT verified live
   * (the reference only shows POST /named-snapshots → 400 invalid_json on a bad body).
   */
  async saveNamedSnapshot(boxId: string, name: string, signal?: AbortSignal): Promise<void> {
    await this.request("POST", "/named-snapshots", { boxId, name }, { signal });
  }

  /** Create or fork. The same idempotency key + body returns the same box for 24 h. */
  async createBox(req: CreateBoxRequest, signal?: AbortSignal): Promise<Box> {
    const common = {
      ...(req.name ? { name: req.name } : {}),
      ttlSeconds: req.ttlSeconds,
      ...(req.type ? { type: req.type } : {}),
    };
    const json =
      req.source.kind === "fork"
        ? await this.request("POST", `/boxes/${encodeURIComponent(req.source.boxId)}/fork`, common, {
            idempotencyKey: req.idempotencyKey,
            signal,
          })
        : await this.request("POST", "/boxes", { ...common, from: req.source.from, org: req.org }, {
            idempotencyKey: req.idempotencyKey,
            signal,
          });
    return BoatApi.pickBox(json);
  }

  async stop(id: string, signal?: AbortSignal): Promise<void> {
    await this.request("POST", `/boxes/${encodeURIComponent(id)}/stop`, {}, { signal });
  }

  async resume(id: string, ttlSeconds: number, signal?: AbortSignal): Promise<void> {
    await this.request("POST", `/boxes/${encodeURIComponent(id)}/resume`, { ttlSeconds }, { signal });
  }

  /** PATCH name (documented in UpdateBoxRequest: 1–120 chars). */
  async setName(id: string, name: string, signal?: AbortSignal): Promise<void> {
    await this.request("PATCH", `/boxes/${encodeURIComponent(id)}`, { name: name.slice(0, 120) }, { signal });
  }

  async setTtl(id: string, ttlSeconds: number, signal?: AbortSignal): Promise<Box> {
    return BoatApi.pickBox(await this.request("PATCH", `/boxes/${encodeURIComponent(id)}`, { ttlSeconds }, { signal }));
  }

  /**
   * Delete a box (irreversible: box and its unshared snapshots). Confirmed live
   * 2026-10-04: DELETE with X-Ascii-Confirm-Delete removed the box.
   *
   * Resolves once the box is gone. "Gone" is decided by GET /boxes/{id} → 404 at
   * every poll step, whatever the deletion operation says: the operation's status
   * vocabulary has never been seen live, and the first live remove sat in
   * "removing" for 25+ min while the box was already not_found (T7). Bounded by
   * maxMs overall; every step and the final reason go to `log`.
   */
  async deleteBox(id: string, opts: DeleteWaitOptions = {}): Promise<void> {
    const log = opts.log ?? (() => {});
    const now = opts.now ?? (() => Date.now());
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const pollMs = opts.pollMs ?? 5_000;
    const maxMs = opts.maxMs ?? 180_000;
    const start = now();

    let json: Record<string, unknown>;
    try {
      log(`delete ${id}: DELETE /boxes/${id}`);
      json = await this.request("DELETE", `/boxes/${encodeURIComponent(id)}`, undefined, {
        confirmDelete: id,
        signal: opts.signal,
      });
    } catch (err) {
      if (err instanceof BoatApiError && err.status === 404) {
        log(`delete ${id}: box not found, already removed`);
        return;
      }
      log(`delete ${id}: DELETE failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
    const opId = deletionOperationId(json);
    log(`delete ${id}: accepted${opId ? ` (operation ${opId})` : " (no operation id in the response)"}`);

    let lastStatus = "unseen";
    for (let poll = 1; ; poll++) {
      opts.signal?.throwIfAborted();
      if ((await this.getBox(id, opts.signal)) === null) {
        log(`delete ${id}: box not found after ${poll} poll(s); removed (operation status was "${lastStatus}")`);
        return;
      }
      if (opId !== null) {
        try {
          const op = await this.request("GET", `/deletion-operations/${encodeURIComponent(opId)}`, undefined, { signal: opts.signal });
          lastStatus = deletionStatus(op) || "(no status field)";
        } catch (err) {
          lastStatus = `poll error: ${err instanceof Error ? err.message : String(err)}`;
        }
        if (DELETION_FAILED.has(lastStatus)) {
          log(`delete ${id}: operation ${opId} reports "${lastStatus}"`);
          throw new BoatApiError(500, "deletion_failed", `deletion of ${id} failed (operation ${opId}: ${lastStatus})`);
        }
        // A "done" status is only a hint; the box 404 above is what counts.
        if (DELETION_DONE.has(lastStatus)) log(`delete ${id}: operation reports "${lastStatus}", waiting for the box to disappear`);
      }
      if (now() - start >= maxMs) {
        const reason = `box ${id} still exists ${Math.round((now() - start) / 1000)} s after DELETE (operation ${opId ?? "none"}, last status "${lastStatus}")`;
        log(`delete ${id}: giving up: ${reason}`);
        throw new BoatApiError(504, "deletion_timeout", reason);
      }
      await sleep(pollMs);
    }
  }

  /** Synchronous command, 1–600 s. Runs as the box user in /home/user. */
  async runCommand(id: string, command: string, timeoutSeconds: number, signal?: AbortSignal): Promise<CommandResult> {
    const json = await this.request(
      "POST",
      `/boxes/${encodeURIComponent(id)}/commands`,
      { command, timeoutSeconds: Math.min(600, Math.max(1, Math.ceil(timeoutSeconds))) },
      { signal },
    );
    return commandResultSchema.parse(json.command ?? json);
  }

  /** Paths must be under /home/user or /tmp. */
  async writeFile(id: string, path: string, content: string, signal?: AbortSignal): Promise<void> {
    await this.request(
      "PUT",
      `/boxes/${encodeURIComponent(id)}/files`,
      { path, content: Buffer.from(content, "utf8").toString("base64"), encoding: "base64" },
      { signal },
    );
  }
}
