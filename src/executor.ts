// MachineExecutor over Boat's commands API, used by core's bootstrap helper.
//
// Boat runs one shell string per call (argv is not preserved, `boat exec` drops
// quoting), $HOME is empty, and there is no stdin. So: quote argv ourselves, set
// HOME, and pass stdin through a private temp file that the command deletes.
// The API returns output only when the command ends, so onOutput gets it once.
import { randomUUID } from "node:crypto";
import type { MachineExecutor, MachineExecutorRequest } from "@get-bb/plugin-sdk";
import { type BoatApi, notReadyYet } from "./boat-api.ts";

/** POSIX single-quote each argument. */
export function shellQuote(argv: string[]): string {
  return argv.map((a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");
}

const BOX_HOME = "/home/user";
/** Boat's synchronous command limit. */
export const MAX_COMMAND_SECONDS = 600;

/** Build the shell string Boat runs for one executor request. */
export function buildCommand(argv: string[], stdinPath: string | null): string {
  const env = `export HOME=${BOX_HOME} XDG_RUNTIME_DIR=/run/user/$(id -u); cd ${BOX_HOME};`;
  const cmd = shellQuote(argv);
  if (stdinPath === null) return `${env} ${cmd} </dev/null`;
  const f = shellQuote([stdinPath]);
  return `${env} chmod 600 ${f}; ${cmd} <${f}; rc=$?; rm -f ${f}; exit $rc`;
}

export interface NotReadyRetry {
  /** Between attempts (default 10 s). */
  intervalMs?: number;
  /** Give up after this long waiting for the box to accept commands (default 12 min). */
  maxWaitMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Called on every refused attempt (reason: box_restoring | box_starting | machine_not_running). */
  onNotReady?: (reason: string, waitedMs: number) => void;
}

export class BoatExecutor implements MachineExecutor {
  private readonly api: BoatApi;
  private readonly boxId: string;
  private readonly retry: Required<Omit<NotReadyRetry, "onNotReady">> & Pick<NotReadyRetry, "onNotReady">;

  constructor(api: BoatApi, boxId: string, retry: NotReadyRetry = {}) {
    this.api = api;
    this.boxId = boxId;
    this.retry = {
      intervalMs: retry.intervalMs ?? 10_000,
      maxWaitMs: retry.maxWaitMs ?? 12 * 60_000,
      now: retry.now ?? (() => Date.now()),
      sleep:
        retry.sleep ??
        ((ms, signal) =>
          new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, ms);
            signal.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true });
          })),
      onNotReady: retry.onNotReady,
    };
  }

  /** Run a Boat call, retrying only while Boat says the box isn't ready (T9). */
  private async whenReady<T>(call: () => Promise<T>, signal: AbortSignal): Promise<T> {
    const start = this.retry.now();
    for (;;) {
      try {
        return await call();
      } catch (err) {
        const reason = notReadyYet(err);
        if (reason === null) throw err; // includes every other 502: may have run
        const waited = this.retry.now() - start;
        if (waited >= this.retry.maxWaitMs) {
          throw new Error(
            `Boat still refuses commands on ${this.boxId} (${reason}) after ${Math.round(waited / 1000)} s: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        this.retry.onNotReady?.(reason, waited);
        await this.retry.sleep(this.retry.intervalMs, signal);
      }
    }
  }

  async exec(req: MachineExecutorRequest): Promise<{ exitCode: number }> {
    req.signal.throwIfAborted();
    if (req.command.length === 0) throw new Error("empty command");
    let stdinPath: string | null = null;
    if (req.stdin.length > 0) {
      // Never logged or echoed; the command removes it after reading.
      stdinPath = `/tmp/bb-stdin-${randomUUID()}`;
      await this.whenReady(() => this.api.writeFile(this.boxId, stdinPath!, req.stdin, req.signal), req.signal);
    }
    const seconds = Math.min(MAX_COMMAND_SECONDS, Math.max(1, Math.ceil(req.timeoutMs / 1000)));
    const command = buildCommand(req.command, stdinPath);
    const res = await this.whenReady(() => this.api.runCommand(this.boxId, command, seconds, req.signal), req.signal);
    if (res.stdout) req.onOutput(res.stdout);
    if (res.stderr) req.onOutput(res.stderr);
    if (res.timedOut) return { exitCode: 124 };
    return { exitCode: res.exitCode ?? 1 };
  }
}
