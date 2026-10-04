# Upstream bug reports for bb (draft, 2026-10-04)

Found while running bb threads on remote machines (Boat sandboxes enrolled as bb machines
through a machine-provider plugin). Versions: **bb-app 0.45.0** (server and host daemon; the
daemon is installed on the machine by the server), `@get-bb/plugin-sdk` 0.6.15, Linux runners
(Ubuntu 24.04, systemd 255). Code references are to the shipped bundles
(`server/dist/start-server.js`, `host-daemon/dist/daemon-bundle.mjs`).

---

## 1. An interrupted environment hook blocks cleanup forever after a daemon restart

**Symptom.** Environments stay in lifecycle phase `teardown`, teardown status `failed`, with
attempts rising indefinitely (seen 8 → 14). Every attempt fails with:

> Environment hook outcome is unknown after interruption. Automatic cleanup is blocked; inspect
> the workspace before recovering it.

Removing the machine is blocked by the same environments. `bb environment cleanup <id>` returns
`ok` but changes nothing; `bb thread unarchive` doesn't reset it either. There is no CLI or SDK
call that clears it.

**Repro.**
1. Create a thread with a worktree environment on a non-server machine.
2. Archive the thread (environment → `retiring`, then `teardown` after the grace period).
3. Restart that machine's host daemon (or suspend/stop the machine) before the teardown hook
   finishes.
4. Watch the environment: teardown retries forever with the message above.

**Cause (from the 0.45.0 server bundle).** Each hook has a row in `environment_hook_operations`.
Teardown and machine suspend call `cancelPendingEnvironmentHook` for unfinished rows, which sends
`environment.hook.cancel` to the daemon. Hook state lives only in daemon memory (also stated in
`bb guide environments`), so a restarted daemon answers `status: "unknown"`, and the server does:

```js
if (result.status === "unknown")
  throw new Error("Environment hook outcome is unknown after interruption. …");
deps.db.update(environmentHookOperations).set({ finishedAt: Date.now(), error: "Environment hook cancelled" })…
```

The throw happens before `finishedAt` is set, so the row stays unfinished and every retry repeats
the same cancel → `unknown` → throw. The message says "inspect the workspace before recovering
it", but no recovery action exists.

**Suggested fixes (any one):**
- An explicit recovery: e.g. `bb environment recover <id> [--discard-hook]` (and an SDK call)
  that, after the user confirms the workspace was inspected, marks the operation finished with
  an error and lets teardown proceed. `bb environment cleanup` could be the place.
- Persist enough hook state on the machine (pid / exit-status file) for a restarted daemon to
  report `finished` or `failed` instead of `unknown`.
- Bound the retries: after N `unknown` answers, mark the row finished (error "outcome unknown")
  and surface it, instead of blocking forever.

**Impact.** Archived environments and the machine record can never be cleaned up, and machine
removal is blocked. Any daemon restart (auto-update, crash, a machine suspend from an idle policy)
during a teardown window triggers it.

---

## 2. A failed skill-tree pull can leave the skill store broken; later thread starts fail

**Symptom.** Thread start fails within seconds:

- `ENOENT … runtime/skill-store/<hash>/.last-used`, or
- `EIO: i/o error, rename '…/runtime/skill-store/.tmp-<hash>-…' -> '…/runtime/skill-store/<hash>'`.

In the ENOENT case `runtime/skill-store/<hash>/` existed but was **empty**. Healthy entries
contain `.complete`, `.last-used` and `content/`. The daemon log shows "Failed to pull required
injected skill tree … reason: ENOENT …/.last-used" on every start; it never recovers by itself.
Deleting the empty `<hash>` dir (and any `.tmp-*` leftovers) fixed it, and the next start pulled
the tree successfully.

Context: the machines' disks were being restored lazily by the sandbox provider, so file
operations, renames included, could fail with EIO for a while after start/resume. The *trigger* is
environmental. The *getting stuck* is in the daemon.

**What the 0.45.0 daemon does** (`RM` → `oWe`):
- `RM` checks `<hash>/.complete` and `<hash>/content`. On ENOENT it pulls again (`oWe`). So
  `.complete` *is* checked before use, and a pull is attempted again.
- `oWe` builds `.tmp-<hash>-<pid>-<time>-<rand>/` (content, `.last-used`, `.complete`), then
  `rename(tmp, <hash>)`.
  - On **EEXIST / ENOTEMPTY** it deletes the fresh tmp tree and **continues as if installed**:
    it writes `<hash>/.last-used` and returns `<hash>/content` without re-checking `<hash>/.complete`.
    An existing incomplete or broken `<hash>` is therefore never replaced.
  - On any other error (e.g. **EIO**) it deletes the tmp tree and throws. The thread start fails,
    and nothing retries until the next start.

How exactly the empty `<hash>` dir came about, and why writing `.last-used` into an existing dir
gave ENOENT, is **inferred, not proven**. Most likely the rename partly happened, or the
directory was left half-restored by the lazy restore, and the EEXIST/ENOTEMPTY branch then
trusted it.

**Suggested fixes:**
- In the EEXIST/ENOTEMPTY branch, re-check `<hash>/.complete` (and `content/`). If it's missing,
  remove the broken `<hash>` and retry the rename once.
- Treat a `<hash>` dir without `.complete` as absent everywhere (remove it before pulling).
- Retry transient errors (EIO, EBUSY) on the rename a few times with a short backoff, and clean
  stale `.tmp-*` entries (older than some minutes) at daemon start.

**Workaround we ship** (machine-provider plugin): before enrolling or resuming a machine, delete
empty `runtime/skill-store/<hash>` dirs and `.tmp-*` leftovers; afterwards repeat the cleanup for
15 min (only `.tmp-*` older than 10 min). Also wait until directory renames work on the machine's
disk before enrolling.

---

Not a bb bug, listed so nobody re-reports it: `systemctl show -p … --value` prints properties in
systemd's order, not the `-p` order (it bit our own probe, not bb).
