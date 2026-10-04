# bb-plugin-boat: design notes and evidence log

> This is the working log from building the plugin (2026-10-04), lightly sanitized: box,
> host, thread and project ids, hostnames and org names are replaced with `<placeholders>`.
> "The owner" is the person running the setup; "T1…T18" are the test/iteration steps.
> Some sections describe states that later changed; later sections win.

A bb **machine provider** that makes Boat sandboxes bb machines, modelled on bb's
bundled Modal Sandbox plugin (`builtin-plugins/environment-modal-sandbox`).
Status at the end of the log: installed on a live hub (id `boat`); create, threads,
suspend/resume and remove all verified live (see the "Verified live" sections).

Sources: `bb guide plugins`, `bb guide machines`, the plugin-authoring reference
`backend-machines.md`, the SDK declarations (`@get-bb/plugin-sdk` 0.6.15,
`PluginMachineProviderDefinition`, `MachineExecutor`, `MachineBootstrapApi`), the
minified Modal plugin (`registerSandboxBackend`, `createModalSandboxPlugin`),  Boat's
REST API reference, and live tests T1–T3.

## Base-box model (owner direction, T6)

- The **base box is `<base-box>` **: the box everyone works from,
  with Paseo, agents, logins, the Tailscale join and a *standalone* bb server.
  `<box>` is a fork of it that was hand-converted into a runner (T1–T3).
- **Every runner is a fresh fork of the base.** No template snapshot. Plugin defaults:
  `source = fork`, `from = <base-box>` (stored settings still win).
- **The base is never modified.** Fork is `POST /boxes/<base-box>/fork`. Boat forks
  from the latest snapshot, so the base can stay stopped. The executor only ever
  targets the new box id, and create refuses if Boat hands back the source id. The
  Boat page offers only *Fork* on the base: resume, stop, set TTL and save snapshot
  are refused server-side (`configuredNotBase`), and the row is badged `base`.
- **Conversion happens at create** (`src/conversion.ts`), on the fork, as root via
  `sudo -n`:

| Step | What | Why (evidence) |
|---|---|---|
| 1 | `touch /etc/bb-runner-mode`; user drop-in `bb-app.service.d/runner-mode.conf` with `ConditionPathExists=!/etc/bb-runner-mode`; `systemctl --user disable --now bb-app.service` | The base runs its own bb server (`bb-app.service`, :38886). Disable alone fails: `agents-update.sh` does `systemctl --user restart bb-app`, which starts a disabled unit (T1 side finding). The condition blocks every start, including restarts and reboots |
| 1b | `bb-ensure.sh`: insert `[ -e /etc/bb-runner-mode ] && exit 0` after the shebang (once) and `chmod -x` | It starts bb-app and runs `tailscale serve`. Callers: `tailscale-ensure.sh` (only if executable), `pi-boot-init.sh` (calls it directly), `boat-heal.sh` (after DB repair). The guard line covers callers that bypass the exec bit; removing the marker restores the old behaviour |
| 1c | `pkill -f 'bin/bb-app --server-bind-host'` | A server started outside the unit |
| 2 | `tailscale serve --https=443 off`; `tailscale serve reset` only if :38886 is still served | `bb-ensure.sh` published the server on the box's tailnet name |
| 3 | Install runner-ensure (embedded copy of `runner/`, drift-tested), its system unit and the `bb-host-daemon-.service.d/boat-guard.conf` drop-in; enable; run it once. **No stamp written by the conversion**: runner-ensure wipes any copied runner identity, then stamps this box | **Needed on every runner.** A fork of the base starts clean, but once a runner enrolls, Boat's automatic snapshots contain its credential, and any later fork of that runner (e.g. the Boat page's *Fork*) would impersonate it (T1, verified). The guard also stops Boat's post-restore unit start from launching the daemon before the identity check |
| 4 | Verify: nothing accepts on 127.0.0.1:38886 (20 s grace), bb-app not active and not enabled, block files present, bb-ensure not executable, nothing serves :38886 on the tailnet, runner-ensure enabled + `/run/bb-runner/verified` + status `ok|needs-enrollment`, daemon guard present | Last line `runner-conversion=ok bb-app=… port38886=free serve=… runner-ensure=…` or `runner-conversion=failed reason=<slug>`; create fails with `Runner conversion failed: <slug>` |

  Create order: allocate → checkpoint → live → refuse `Restore incomplete` → settle
  (now also waits until Boat has started the snapshot's units: `tailscale-rejoin`
  loaded but inactive = pending; T2 showed this happens ~50 s after "ready") →
  **conversion** → identity guard → bootstrap. Resume runs the same idempotent
  conversion again before guard and bootstrap: restores have lost files (T2), and
  this re-verifies cheaply.

## Division of labour (bb core vs plugin)

bb core owns enrollment, identity files, daemon install, project checkout setup,
draining work before suspend, retries, and the machine record. The plugin
allocates compute, gives core a command executor, and stops/starts/deletes the
box. `bb.experimental_machines.bootstrap({key, executor})` installs or restarts
the daemon and waits for it to connect. Per the docs it "restarts enrolled
identities, including a restored preinstalled snapshot". That is exactly the T1
hazard on a fork, so the plugin has to clean the identity **before** bootstrap.

## Callback mapping

| bb callback | Boat | Notes |
|---|---|---|
| `availability()` | settings check only | `setup-required` until `apiKey`, `org`, `from` are set. No network |
| `create({inputs,key,checkpoint})` | `POST /boxes/{from}/fork` or `POST /boxes {from: <named snapshot>, org}` with `Idempotency-Key` | Key and box name are derived from bb's stable `key` (`idempotencyKey(key)`, `allocationName(key)` = `bb-<sha16>`), so a retry returns the same box (Boat binds keys for 24 h) and cleanup can find it by name. `checkpoint({boxId,key})` right after allocation, before anything that can fail. Create records an allocation intent first (T7) and sends no `name` (Boat ignores it), then renames via PATCH. Then: poll `GET /boxes/{id}` to `ready/idle/running` → refuse `Restore incomplete` → settle phase 1 (Boat unit start; runner-ensure if present) → **runner conversion** (T6) → **identity guard** → `bootstrap` → name `bx-<id>` |
| executor `exec({command,stdin,timeoutMs})` | `POST /boxes/{id}/commands` | One shell string per call (argv quoted by us; Boat drops quoting), `export HOME=/home/user`, ≤600 s. Stdin goes through `PUT /files` to `/tmp/bb-stdin-<uuid>`, `chmod 600`, then `cmd <file; rm -f file`. The bootstrap bundle never appears in a command string or a log. Output arrives once at the end, not streamed |
| `suspend({resource,checkpoint})` | `POST /boxes/{id}/stop` | Core has already drained work and stopped the daemon. While still live, record `git status` of every bb repo into `resource.dirtyAtSuspend` and checkpoint it. Stop snapshots first; wait for `archived/stopped` and `lastSnapshotStatus == completed`. Idempotent: already stopped means just verify |
| `resume({hostId,resource,checkpoint})` | `POST /boxes/{id}/resume {ttlSeconds}` | Idempotent. Live → no POST. `stopping`/`archiving` → wait for `archived/stopped` first (a POST mid-stop is expected to 409; review item 5). Already `provisioning/resuming/cloning` → no POST, just wait. Then wait live → checkpoint → refuse `Restore incomplete` → **full settle rule** (below) → identity guard must say `kept`, else refuse → `bootstrap` with the same key (restarts the same host ID, as seen in Phase 0 and T1) |
| `remove({resource})` | `DELETE /boxes/{id}` with `X-Ascii-Confirm-Delete: <boxId>` | Without the header Boat answers 409 `delete_confirmation_required` (review must-fix 1). On 202 the client polls `GET /deletion-operations/{id}` (3 s, max 100 polls) and reports removed only when the operation says done; `failed` or the bound → `failed` result, so core retries. 404 counts as removed. `ephemeral: false`, so core never removes boxes on its own |
| `reconcileCleanup({key})` | `GET /boxes` filtered by name `allocationName(key)` → `DELETE` | For a create that crashed before its checkpoint |
| idle suspend | `bb.background.schedule("* * * * *")` → `src/lifecycle.ts` → `bb.sdk.hosts.experimental_suspend` | **Busy = `bb.sdk.threads.count({hostId, status})` for `starting` + `active`** (server-side count; review must-fix 2). A busy host resets the idle clock, so a long, quiet tool call is never idle-suspended. The kv timestamp (bumped by `experimental_thread.events` / `experimental_terminal.input`) only measures idle duration. `machine_busy` → retry next sweep |
| pre-TTL | same schedule; `archiveAfter` from `GET /boxes/{id}` | Boat stops boxes at `archiveAfter` without telling bb. Inside `preTtlMarginMinutes` (default 15, more than core's 5-min drain plus snapshot): **busy → `PATCH ttlSeconds`** (extend), **idle → suspend through bb**. Modal has no pre-expiry scheduler and documents the loss; Boat lets us extend, so we do |

Policy functions are pure and tested: `src/policy.ts` (`lifecycleDecision`,
`settleDecision`, `identityGuardScript`, naming).

## Rule from T1: fork identity

Verified: a forked runner connects with the source's copied
`~/.bb-machines/<server>/auth.json`. The hub then flips the host's session between
the two boxes every ~3 s and still shows one "connected" machine.

1. **Template**: the source snapshot/box has `runner/` installed: a
   root boot unit that stamps `~/.config/bb-runner/boat-id` (since T8; was
   `~/.bb-machines/.boat-id`, which broke bb's bootstrap), wipes runner state on
   mismatch, and an `ExecStartPre` guard (prefix drop-in
   `bb-host-daemon-.service.d`) that blocks every bb daemon until the check has run
   this boot (`/run/bb-runner/verified`, tmpfs). This covers Boat's own unit
   start ("reboot semantics", T2), which happens without the plugin.
2. **Plugin, before every bootstrap**: run `identityGuardScript(boxId)` as the
   box user. Stamp ≠ this box → disable/remove `bb-host-daemon-*` units, kill the
   daemon, delete `~/.bb-machines/*` (identity, checkouts, worktrees), then stamp.
   Stamp = this box → keep. Stamping after the wipe makes a retried create on the
   same box safe (it won't wipe an enrollment it already finished).
3. On **resume** the guard must say `kept`. If it doesn't, the box isn't what core
   thinks it is, so refuse instead of restarting `hostId` there.
4. Never `fork` an enrolled runner for a *new* machine without step 2. Prefer a
   named snapshot of a clean template (no identity) as `from`.

## Rule from T2: post-resume settle

Verified timeline: Boat boots a pooled VM, restores `/home` as a **lazyfs** mount
(usable after ~10 s, hydration continues ~6 min), and starts units from the
snapshot only ~50 s after reporting ready. Files can look modified while
hydrating (1 file for ~20 s in T2; 23 in Phase 0). Restores flagged
`Restore incomplete … 504` really lost files (npm 1743/1938).

`resume()` (and `create()`) return only when:

1. Box state is live, and `error` does **not** start with `Restore incomplete`.
   Otherwise fail with a clear message. Don't run agents on a box that may be
   missing files.
2. `runner-ensure` has run this boot (`/run/bb-runner/verified`), where installed.
3. Every bb checkout/worktree's `git status --porcelain` equals the dirty set
   recorded at suspend (empty for create), on two samples ≥10 s apart.
4. Cap 5 min → fail as "did not settle", with the reason.

Core resumes queued thread work as soon as `resume()` returns, so this is the
right gate. Better signals for later: Boat's `hydrated` webhook (needs a public
receiver; our hub is tailnet-only) or the lazyfs `phase:"done"` journal line
(undocumented).

## Boat page in bb (T5, first version)

`app.tsx` registers `app.slots.navPanel({id:"boat", path:"boat", component:
BoatPage, experimental_sidebarAccessory: RunningCount})`, a sidebar row with an
"N running" value and a page at `/plugins/boat/boat`.

**Data flow.** The page only talks to the plugin server through the typed RPC
contract `dashboardRpc` (`src/dashboard.ts`), registered with `bb.rpc.register`. The
server holds the key and builds every response from explicit zod DTOs (`boxDto`,
`walletDto`, `snapshotDto`), so `ip`, `url`, `subdomain`, `sshEndpoint`,
`desktopUrl`, signed URLs and the key can't reach the frontend (tested with
mocked Boat responses that contain them). After each action the server publishes
`boat-changed`. The page and sidebar refetch on that, and also every 30 s / 60 s,
because Boat changes state on its own. Overview is cached 15 s server-side.

| RPC | Boat call(s) | Guard |
|---|---|---|
| `boat_overview` | `GET /boxes` (all pages), `GET /limits?org=<org>`, `GET /named-snapshots`, plus bb `hosts.list` / provider resources for the machine mapping | Partial results: each section carries its own error |
| `boat_summary` | from the overview cache | sidebar count |
| `boat_resume {boxId, ttlHours?}` | `POST /boxes/{id}/resume {ttlSeconds}` | only from `archived/stopped`; refuses while `stopping/archiving` or live |
| `boat_stop {boxId}` | `POST /boxes/{id}/stop` | only when live |
| `boat_fork {boxId, ttlHours, requestId}` | `POST /boxes/{id}/fork {ttlSeconds}` with `Idempotency-Key = requestId` (a UUID from the page) | double-submit safe |
| `boat_set_ttl {boxId, hours}` | `PATCH /boxes/{id} {ttlSeconds}` | 0.25–720 h; sets the deadline N h from now |
| `boat_save_snapshot {boxId, name}` | `POST /named-snapshots {boxId, name}` | name `^[a-z0-9][a-z0-9-]{1,62}$` |

Box ids are validated (`^bx_[a-z0-9]+$`) at the RPC boundary. **No delete in v1.**

**Machine mapping.** Plugin-created machines map through their provider resource
(`boxId`); manually enrolled runners map by the `bx-<id>` naming convention (T1/Phase 0).
The "bb machine" cell links to bb's `/settings/machines/:hostId` route (found in the
bb 0.45 app bundle; the SDK's `useBbNavigate` has no machine target).

**UI.** bb's vendored components (`components/ui`: Button, Dialog, Input, Icon) and
theme tokens only. Every action opens `ConfirmActionDialog`, which says what will
happen (start billing, snapshot, cut-off threads) and collects inputs. Forking a box
that is a bb machine warns about the T1 identity copy. Actions shown depend on state
(`ui/actions.ts`): live → stop / set TTL / fork / save snapshot, stopped → resume /
fork / set TTL, transitional → none.

**Changing the layout** (for the Boat dashboard screenshot): `ui/BoatPage.tsx`
`SECTIONS` is the ordered list of sections. `ui/sections.tsx` holds the sections
(each takes `{data, now, onAction}`) and `BOX_COLUMNS` (table columns as data).
Formatting and action rules are plain TS in `ui/format.ts` and `ui/actions.ts`.

### Boat page: verified live (owner screenshot, 2026-10-04)

- **VERIFIED:** the page renders in bb. Boxes: 9, all states.
  **`GET /boxes` with no `state` filter returns all states by default: yes.**
- **VERIFIED:** named snapshots list (8) renders, so the list key is handled.
- **VERIFIED:** the bb machine link and the `restore incomplete` health flag work
  against real data.
- **Bug found and fixed:** the Wallet card failed with zod `invalid_type` at
  `["starts","unlimited"]` (expected object, got boolean). Real `boat limits --json`:
  `"starts":{"day":{"limit":200,"remaining":198,"used":2},"hour":{…},"minute":{…},"unlimited":false}`.
  `limitsSchema` is now tolerant: `starts.unlimited` is a boolean, each window is
  `{limit, remaining, used}`, every rendered field `.catch(null)`es and unknown fields
  pass through. One odd field can no longer blank the card. The wallet DTO stays an
  explicit whitelist (adds `startsUnlimited`). Tested with that exact shape
  (`test/limits.test.ts`). Not yet re-seen live after the fix.

### Boat page: still to verify live

- **`POST /named-snapshots` body** `{boxId, name}` is a guess. The reference only
  shows 400 `invalid_json` on a bad body, and the key then lacked `snapshot.write`.
- `PATCH ttlSeconds` semantics ("N hours from now") per the reference's `archiveAfter`
  note.
- The confirmation dialogs and each action against real boxes (none run yet).
- The sidebar "N running" accessory (not in the screenshot).

## Secrets and data

- Plugin settings: `apiKey` is `secret: true` (0600 file under the plugin data
  dir, never sent to the frontend). `org`, `source`, `from`, `type`, TTL, idle
  and margin are plain settings.
- Machine `inputs` (persisted and readable by every plugin) hold only `source`,
  `from`, `type`. Resource JSON holds `boxId`, `key`, dirty file *names*.
- `BoatApi` parses responses through a schema that drops `url`, `ip`,
  `sshEndpoint`, `subdomain`, `desktopUrl`, so they can't reach logs, resources or
  progress output.
- Billing: `org` is required, and `create` from a snapshot always sends it. A
  **fork bills the source box's owning wallet** (Boat behaviour), so fork only
  team-owned sources.

## Requirements on the box / network

- Base box `<base-box>`: Node + npm + curl (bootstrap needs them), the tailnet
  join (`tailscale-ensure.sh`, `tag:boat`), passwordless `sudo -n` for `user`. The
  conversion supplies the rest (own bb server blocked, runner-ensure).
- Conversion assumptions to verify on the first live create: the commands API runs
  as `user` with `sudo -n` working; a ~6.5 KB `bash -c` command is accepted;
  `tailscale serve status --json` shows the :38886 proxy when published; Boat's unit
  start leaves `tailscale-rejoin` `active` (it is `RemainAfterExit`).
- bb `machineServerUrl` = `https://<hub>.<tailnet>.ts.net:3888`, reachable
  only over the tailnet. Box egress to npm/registry is needed for the first
  install.

## Verified live: first provider run (2026-10-04 ~10:40Z, T7)

Owner ran `bb machine create --provider boat --key boat-live-test-1` (source fork
`<box>`) on the installed plugin. Recorded facts, then the fixes:

| What | Result | Status |
|---|---|---|
| Fork via `POST /boxes/{src}/fork` with `Idempotency-Key` | Created `<box>` | **VERIFIED** |
| Box `name` sent on fork | **Ignored.** Boat named it  fork fork", not `bb-<hash>` | **VERIFIED. Review item 3 confirmed: name-based cleanup can't work** |
| Settle waits for Boat's unit start | Progress showed "Boat has not started the box's units yet (tailscale-rejoin pending)", then passed | **VERIFIED** (the T6 `boot=pending` probe works) |
| Commands API + `sudo -n bash -c` + the ~6.5 KB script | Conversion ran as root and printed `runner-conversion=ok bb-app=inactive/disabled port38886=free serve=off runner-ensure=ok` | **VERIFIED** (also: runs as `user`, sudo works, the size is accepted, the response shape parses) |
| Exit code of that command | **143** (SIGTERM). Create failed: "Runner conversion failed: exit 143: …" | Bug, fixed below |
| Remove (`DELETE` + `X-Ascii-Confirm-Delete`) | Box gone (Boat `not_found`) | **VERIFIED: delete path works** |
| bb record after remove | `<host>` stuck in `removing`, teardown `running`, attempts 3 → 4 at 10:49:42Z → 10:55:52Z (6 min 10 s apart), plugin logged nothing | Bug, fixed below |

### Fix 1: exit 143 was `pkill -f` matching its own parent shell

The conversion runs as `sudo -n bash -c '<script>'` inside a user-owned shell whose
command line holds the whole script. `pkill -u user -f 'bin/bb-app --server-bind-host'`
matched that shell and killed it. The root script survived and printed `ok`, but the
command's exit status was the killed parent's: 143. The reviewer reproduced it locally.
**Fix:** every `pkill`/`pgrep -f` in generated or shipped scripts uses a self-safe
pattern: `[b]in/bb-app --server-bind-host` (conversion) and `[b]b-app[ /]host-daemon`
(identity guard, runner-ensure). `runner/runner-mode.sh`'s `pgrep` is fixed too.
The new test (`test/t7.test.ts`) asserts no pattern matches any generated script's
text, raw or as the executor sends it. It found a **second, latent self-match**:
runner-ensure's old `bb-app.* host-daemon`, embedded in the conversion, matched the
conversion's own command line via `.*` (`bb-app.service` … ` host-daemon`). It would
have killed the conversion whenever runner-ensure took its wipe path. Fixed by the
adjacency pattern `[b]b-app[ /]host-daemon`, which matches both the launcher
(`bin/bb-app host-daemon`) and the bundle (`bb-app/host-daemon/dist/…`). A real
`pgrep` test shows the plain pattern finds its own shell and the bracket form doesn't.

### Fix 2: stuck remove (cause: operation poll; status vocabulary still unseen)

The pre-T7 code polled `GET /deletion-operations/{id}` up to 100 × 3 s and only
accepted known status words. Observed: retries every ~6 min (= that 5-min bound +
core's 1-min retry) while the box was already `not_found`. Each attempt also apparently
got something other than 404 from a repeat `DELETE`, otherwise it would have returned
at once. **Inference, consistent with the timing; the actual operation body is still
unseen.** **Fix:** `deleteBox` now treats `GET /boxes/{id}` → 404 as removed at every poll
step, whatever the operation says. A "done" status alone isn't trusted, a "failed"
status fails fast, and the whole delete is bounded (default 3 min, 5 s polls). Every
step and the final reason go to `bb.log` (`delete bx_…: …`, `remove …`, `cleanup …`; ids
and statuses only), and remove/cleanup return `failed` with "Boat remove failed: <reason>"
so bb shows it. The last operation status seen is included in the timeout reason, so the
next run tells us the vocabulary. Once reloaded, the stuck record should clear on its
next attempt (first poll sees the 404). Not yet observed.

### Fix 3: allocation recovery without names

`reconcileCleanup` no longer looks for names. Create stores an **allocation intent**
(the exact, non-secret create request: source, org, TTL, type, Idempotency-Key) in plugin
kv **before** calling Boat, adds the box id as soon as Boat answers, and still
checkpoints the id immediately. Cleanup: no intent → nothing was sent → removed. Box
id recorded → delete it. Otherwise **replay the identical request with the same
Idempotency-Key** to learn the id, then delete it. A 4xx on replay (except in-progress /
rate limits / key-reused) means Boat created nothing → removed. Never deletes the fork
source. **The replay assumption is UNVERIFIED live:** Boat's docs say the same key + body
returns the same box within 24 h. Caveat: if the original request never reached Boat,
the replay creates the box now (one billed start) and cleanup then deletes it.

### Fix 4 (optional item): recognisable names

The API reference documents `name` (1–120 chars) on `PATCH /boxes/{id}`
(`UpdateBoxRequest`). After create the plugin renames the fork to `bb-runner <12-hex of
the bb key>`. Best effort: a failed rename is logged and create continues. Rename via
PATCH is **unverified live**. The create body no longer sends `name`.

## Verified live: second provider run (2026-10-04 13:02–13:30 local, T8)

| What | Result | Status |
|---|---|---|
| Create (source fork `<box>`) | Forked `<box>` → settled → converted → enrolled; machine `<box-hostname>` connected and active in ~5 min | **VERIFIED end to end** |
| Rename after create (PATCH `name`) | Box renamed to the bb machine name | **VERIFIED** |
| Suspend | phase `suspended` | **VERIFIED** |
| Remove (twice) | Log: `accepted (operation bdop_…)` then `box not found after 1 poll(s); removed (operation status was "unseen")`. A repeat `DELETE` of an already-deleted box returns **202**, not 404 | **VERIFIED** (T7 fix works; explains the T7 stuck remove) |
| **Resume** | **Failed**: "Machine bootstrap command failed: … ENOTDIR: not a directory, open '/home/user/.bb-machines/.boat-id/auth.json'" | Bug, fixed below |
| Base fork `<box>` (owner notes) | Boat never started `pi-boot-init` / `tailscale-rejoin` / `agents-update` (40 min after ready); on the base itself they started ~80 s after ready | Gap, fixed below |

### Fix 1: identity stamp moved out of `~/.bb-machines`

bb core's bootstrap (restart of an enrolled identity) treats **every entry** under
`~/.bb-machines` as a server data dir, opens `<entry>/auth.json`, and only tolerates
ENOENT. Our stamp file `.boat-id` there made it fail with ENOTDIR. Create worked
because nothing was enrolled yet when it was written. Resume hit it. The stamp now lives at
**`~/.config/bb-runner/boat-id`** (user-owned, in `/home`, so it's in the Boat snapshot
with the identity it guards) in runner-ensure, the identity guard and `install.sh`.
Migration: runner-ensure and the guard move an existing `~/.bb-machines/.boat-id` to the
new place (or drop it if the new one exists), and the wipe now clears every entry under
`~/.bb-machines`. **Existing runner `<box-hostname>`**: its next resume, after the reload,
re-runs the conversion, which reinstalls the new runner-ensure and migrates the stamp
before bootstrap, so it should recover. Not yet observed. Forks of `<box>`
(hand-converted, old stamp) are migrated and then wiped as foreign. Test
(`test/t8.test.ts`): no generated or shipped script writes a non-directory entry directly
under `~/.bb-machines` (static write-target analysis, with a control proving the pre-T8
guard is flagged). Guard tests run the script for real against a temp `$HOME` and assert
only directories remain there.

### Fix 2: start the boot units Boat skips

The settle probe reports each boot unit's state from `systemctl show` (`LoadState`,
`ActiveState`, `Result`, `ExecMainStartTimestampMonotonic`; 0 = never started this boot),
so "never started" is told apart from "ran and finished" even for oneshots without
`RemainAfterExit`. Settle waits for `pi-boot-init` and `tailscale-rejoin` to **finish**.
If any of `pi-boot-init`, `tailscale-rejoin`, `agents-update` hasn't been started ~2 min
after settle began (≈ ready), the plugin runs `sudo -n systemctl start --no-block …` once
and keeps waiting. A failed `pi-boot-init`/`tailscale-rejoin` fails create/resume with
"Box setup failed: boot unit … failed: without it the box has no provider keys and no
Tailscale". A failed start command fails too. Settle timeout raised to 12 min.
`agents-update` is started if skipped, but never waited on: the owner notes show the same fork
skipped it too, and fix 3's marker depends on it running. That's my addition beyond the
two units named; say if you'd rather not.

### Fix 3: agent updates exposed, not blocking

The probe reads `/run/user/$(id -u)/agents-update.done` (sanitized, one line). If present
at settle, create/resume logs `Agent updates: <line>` in the machine progress. If not, it
logs that updates are still running (done ~8–10 min after ready; agents use previous
versions), and a background watcher (every 60 s, ≤15 min, stopped on plugin dispose)
logs the line via `bb.log` once it lands and stores it per box. The **Boat page** shows it
in an "Agents" column ("all ok (n)" or the failing `name=status` pairs; full line on hover).
New setting **`waitForAgentUpdates`** (default **false**): when on, create/resume waits
for the marker before identity guard + bootstrap, bounded at 15 min. On timeout it logs and
continues rather than failing, because agents still work on their previous versions.
Default `from` stays `<base-box>`.

## Verified live: third provider run (2026-10-04 13:40 local, T9)

Plugin reloaded with T8. `bb machine create --provider boat --key boat-live-test-3`
(fork of `<box>`):

| What | Result | Status |
|---|---|---|
| Fork + rename | `<box>`, renamed `bb-runner 954356bc1cbd` | **VERIFIED** (rename works live) |
| First command on the box | **`Boat API 502 box_direct_failed: box_restoring`** while the box state was already `idle`; create failed, core started removal | Bug, fixed below |

### "Commands accepted" is Boat's observable restore-done signal

Boat's commands API refuses commands during the lazy restore and says so: 502,
code `box_direct_failed`, message/detail `box_restoring`. The box `state` doesn't
show it (`idle`). So the **first settle condition** is now "Boat accepts a command": settle
runs `true` through the executor before any unit, runner-ensure or repo check, and logs
`Boat accepts commands on the box (restore signal) after N s`.
**Verified once live** (the refusal; the acceptance path is unit-tested only). **Uncertain:**
whether Boat starts accepting commands before the restore has fully finished. T2 saw
lazyfs keep hydrating ~6 min after "ready", so acceptance probably means "restore handed
over", not "all files local". The later settle checks (boot units, runner-ensure, repo
stability) stay in place for that reason.

### Retry rule (executor-wide)

`notReadyYet(err)` (`src/boat-api.ts`) is the only retry gate: **502 `box_direct_failed`
whose message/detail says `box_restoring`**, **409 `box_starting`**, and
**`machine_not_running`**. These mean the command was not taken, so retrying is safe.
`BoatExecutor` retries exactly those every 10 s, bounded by the settle timeout (12 min),
for both the commands call and the private stdin file write. So settle, conversion,
identity guard, agent-marker checks and **bb core's bootstrap** (which runs through the
same executor) all wait. Progress: "Boat is still restoring the disk (commands refused:
box_restoring); retrying every 10 s (N s so far)" on the first refusal, then at most once a
minute. **Every other 502 still fails fast** (one attempt, no sleep): the reference warns a
502 can mean the command already ran. Boat's error `details` are parsed for matching only
and never logged.

## Verified live: restore speed is per source snapshot; box → sandbox rename (T10)

| What | Result | Status |
|---|---|---|
| Plain `boat fork <box>` | Commands API accepted nothing for **1,483 s (~25 min)**; state `idle` throughout | **VERIFIED** (owner) |
| `boat fork <base-box>` (base) | Commands accepted after **8 s**; `pi-boot-init` and `tailscale-rejoin` already active; `boat ssh` worked in 1 s | **VERIFIED** (owner) |
| Conclusion | Slow restores are specific to `<box>`'s snapshot (it carried "Restore incomplete … 504" this morning), not to Boat forks in general. The plugin's `from` setting is now **`<base-box>`** (also the code default) | Owner change |
| Refusal spelling | API: `box_direct_failed` / `box_restoring`. boat CLI: `sandbox_direct_failed` / error `sandbox_restoring`. **Boat is renaming box → sandbox** | **VERIFIED** (both seen) |

Note: T9's 12-min "commands accepted" bound would not have covered the 25-min
`<box>` fork. With the base as source (8 s) it's ample. If a slow source comes back,
raise the settle timeout rather than retrying other errors.

**Rename tolerance (T10).** Code comparisons go through `canonicalCode()` (lower-case;
`sandbox_*` reads as `box_*`). The restore refusal matches `box_restoring` or
`sandbox_restoring` (whole word) in message, details or a string `error`. The error code is
also read from `error.code` if Boat moves it. Covered: `box_direct_failed` |
`sandbox_direct_failed`, `box_restoring` | `sandbox_restoring`, `box_starting` |
`sandbox_starting`, `machine_not_running`, and the idempotency codes used by cleanup.
Response wrappers already accept `box`/`sandbox` and `boxes`/`sandboxes`. Tested with both
spellings (`test/t10.test.ts`); other direct failures stay non-retryable in both.

**Design note, not implemented: SSH as a fallback transport.** Owner observed `boat ssh`
working within 1 s on the base fork, while on slow restores the commands API refused for
minutes. The API has `POST /boxes/{id}/sshkey` (reference: verified reachable). A fallback
executor could register a per-machine ephemeral public key, then run the same argv over
SSH, with real stdin and streamed output, which the commands API lacks. Open questions
before building it:
- whether SSH is genuinely usable before the restore is handed over, or just reaches a
  partly hydrated disk (T2: files can still be missing);
- where the SSH endpoint comes from: it's a secret-bearing field (`sshEndpoint`) we
  deliberately drop at parse time, so it would need a narrow, server-side-only path;
- private-key storage (plugin secrets dir, never resources/inputs) and rotation/removal on
  `remove`;
- whether the hub can reach Boat's SSH endpoint at all (the hub egress).

Until then the commands API plus the T9 retry is the only transport.

## Verified live: fifth run, enrollment before Tailscale (T11)

Source = base `<base-box>`, plugin at `19fc5e7`.

| What | Result | Status |
|---|---|---|
| Fork + rename | `<box>`, renamed 12:36:44Z | **VERIFIED** |
| Commands accepted | "after 0 s": base forks restore fast | **VERIFIED** (confirms T10) |
| Conversion, identity | ok; "No copied runner identity" | **VERIFIED** |
| bb bootstrap | **Failed**: `curl: (6) Could not resolve host: <hub>.<tailnet>.ts.net` | Bug, fixed below |
| On the box afterwards | tailscale-ensure.log: "joining as <box-hostname> … 12:37:36Z", "up … 12:37:37Z", i.e. **~40 s after enrollment ran**. At +5 min: tailscale-rejoin active, BackendState Running, MagicDNS on, hub resolves; **pi-boot-init still `activating`** | Observed by owner |

### Root cause: the T8 probe parsed `systemctl show --value` by position

The T8 probe ran `systemctl show -p LoadState -p ActiveState -p Result -p
ExecMainStartTimestampMonotonic --value <unit>` and read the four values **positionally**.
`systemctl show` prints properties in **systemd's own order, not the `-p` order**:
- Verified on the hub (systemd 259): reversing the `-p` flags gives identical output.
- On the boxes (systemd 255), Service-interface properties print before Unit ones. Evidence
  from this repo's T1 run on `<box>`: `-p DropInPaths -p ActiveState -p NRestarts`
  came back as `NRestarts`, `ActiveState`, `DropInPaths`.

So the parser got `Result`'s value (`success`) as `LoadState`, and every boot unit was
classified **absent**. Absent units are never pending and never started by the plugin, so
settle passed immediately and bootstrap ran before `tailscale-rejoin` had joined.
Confidence: high, from the code plus that ordering evidence. The exact probe output on
`<box>` wasn't captured.

**Fix:** the probe prints `KEY=VALUE` (no `--value`) and the parser reads fields **by
name**, in any order. A line it can't read is `unknown`, which counts as pending (fail
closed). Verified by running the real probe on the hub: absent units read `absent`; a
real unit reads `done` even with reversed `-p` order. Tests cover the 255 order, the 259
order, the old positional misread, and the unknown case.

### Settle waits only for tailscale-rejoin; hard hub gate before bootstrap

- `REQUIRED_BOOT_UNITS = ["tailscale-rejoin"]`. `pi-boot-init` is **not** waited for
  (live: still `activating` at +5 min) and a failed `pi-boot-init` no longer fails create.
  All three units (`pi-boot-init`, `tailscale-rejoin`, `agents-update`) are still started by
  the plugin if Boat hasn't started them ~2 min after ready.
- **Hub gate** (`src/hubgate.ts`), run on the box right before bootstrap in **create and
  resume**, every 10 s for up to 6 min. All three must pass:
  1. `tailscale status --json` → `BackendState` = `Running` (only that field leaves the
     box; falls back to `sudo -n` if the user can't read status);
  2. `getent hosts <hub host>` resolves;
  3. `curl -sS -m 8 <hub>/health` answers 2xx.

  The hub URL comes from bb, not a constant: `bb.sdk.system.config().serverAccess.effectiveUrl`
  (the URL bb gives machines; with direct access it's the `machineServerUrl` setting). It is
  validated before going into the script: http(s), plain host, no credentials/query/fragment.
  Progress: "Waiting for the box to reach the bb hub over Tailscale (<host>)", then the
  failing check whenever it changes. Failure: "The box can't reach the bb hub after 6 min:
  <message> [check: tailscale|dns|health]". No URL configured: "bb has no machine server URL …".
  The real gate script was run on the hub: `ts=Running | dns=yes | health=200` → ok.

## Verified live: run 6, full lifecycle (T12)

Plugin `89bbf17`, source = base `<base-box>`.

| What | Result | Status |
|---|---|---|
| Create | ~2 min to `connected` / active | **VERIFIED** |
| Suspend | phase `suspended` | **VERIFIED** |
| **Resume** | `connected` again in ~2 min (T8 stamp move + T11 probe/hub gate hold) | **VERIFIED** |
| Threads on the runner | Failed at first; two causes found and fixed **by hand** on the test runner, then a claude-code thread succeeded (hostname / whoami / git log) | Fixed by hand, now encoded (below) |

### Fix 1: stale skill tree (empty skill-store entry)

Daemon log: "Failed to pull required injected skill tree … reason: ENOENT …
runtime/skill-store/<hash>/.last-used". The `<hash>` dir existed but was **empty**.
Healthy entries contain `.complete`, `.last-used` and `content/`. A failed first pull leaves the
empty dir behind and the daemon never retries. Hand fix: `find <data-dir>/runtime/skill-store
-mindepth 1 -maxdepth 1 -type d -empty -delete`; the next pull completed. **Plugin:** the same
cleanup (`src/boxprep.ts`, user-level, all `~/.bb-machines/*` data dirs, prints a count only)
runs before every bootstrap in create and resume. Only empty dirs are removed, never a
non-empty one that might be mid-pull.

**Upstream note for bb (host daemon):** the skill-store treats an existing
`runtime/skill-store/<hash>/` directory as present even when the pull that created it failed.
Afterwards the daemon tries to read `.last-used`, gets ENOENT, logs "Failed to pull required
injected skill tree", and never re-pulls. Suggested fix: treat a `<hash>` dir **without
`.complete`** as absent (remove it and pull again), or write into a temp dir and rename it into
place only once complete. Seen with bb 0.45.0 on a Boat runner, 2026-10-04.

### Fix 2: provider auth for the bb daemon (agent env)

Claude Code on Boat boxes authenticates through `CLAUDE_CODE_OAUTH_TOKEN` in
`/run/ascii-secrets/env.sh` (no `~/.claude/.credentials.json`). The `bb-host-daemon-*` user
unit's environment had only `HOME`, so threads failed with "Not logged in · Please run /login".
The base's own `bb-app.service` solved this by sourcing `env.sh` and `bws-providers.sh`.
**Plugin** (`agentEnvScript`, root via `sudo -n`), as verified by hand:
- generates `/run/bb-runner/agent-env` from `/run/ascii-secrets/env.sh` +
  `/run/ascii-secrets/bws-providers.sh` with
  `sed -nE 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/\2=\3/p'`. There
  is **no `export ` prefix**, because systemd logs invalid lines *with their values* (Paseo
  learning). The dir is user-owned 0700 and the file 0600, made private before any content is
  written, then atomically `mv`d into place;
- **my addition:** drops `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `PWD`, `XDG_RUNTIME_DIR`,
  `DBUS_SESSION_BUS_ADDRESS`. Systemd doesn't expand `$VAR` in an `EnvironmentFile`, so an
  `export PATH="$PATH:…"` line would break the daemon's PATH;
- installs the prefix drop-in `~/.config/systemd/user/bb-host-daemon-.service.d/20-agent-env.conf`
  (`[Service]` / `EnvironmentFile=-/run/bb-runner/agent-env`), next to `boat-guard.conf`, then
  runs a user `daemon-reload`;
- restarts running `bb-host-daemon-*` units **only when the content hash changed** since it
  was last applied (`/run/bb-runner/agent-env.applied`);
- prints only `agent-env=ok vars=<n> hash=<16 hex> changed=… restarted=<n> claude=yes|no
  bws=yes|no`, never values.

`/run` is tmpfs, so this runs on **every create and resume, after the hub gate**: order
`hub gate → skill-store cleanup → agent env (restart allowed) → bootstrap`. Restart is safe
there because no thread can run during create/resume. `bws-providers.sh` appears only when
`pi-boot-init` finishes, which can take minutes. A background watcher (after bootstrap, every
60 s, ≤15 min, stopped on plugin dispose) regenerates without restarting. When the content
changed, it restarts the daemon **only if bb counts no starting/active thread on the host**
(`threads.count`); otherwise it logs "restart deferred (N thread(s) running)" and retries next
minute. `runner-ensure` now creates `/run/bb-runner` user-owned 0700 (it used to `chmod 755`
it each boot); the daemon guard still reads `verified` there as the user.

## Verified live: runs 7 and 8 (T13)

Plugin `c6d3b11`, source = base. **Create, suspend, resume and remove work every time now**
(VERIFIED, both runs). Threads did not:

| Run | Thread | When | Result |
|---|---|---|---|
| 7 | claude | +2 min after create | error |
| 7 | claude | +2 min after resume | error |
| 7 | pi | +15 min after create | OK |
| 8 | pi and claude | +4 min after create, +2 min after resume | error within ~10 s at `thread.start` |

Errors: `ENOENT … runtime/skill-store/<hash>/.last-used` or `EIO: i/o error, rename
'…/runtime/skill-store/.<tmp>' -> '…'`. The daemon installs an injected skill tree by building
`.tmp-…`, `rename()`-ing it into `runtime/skill-store/<hash>`, then writing `.last-used`
(host-daemon dist `oWe`/`RM`, read by the reviewer and confirmed in the 0.45 bundle:
`fetchSkillTree` → `.tmp-…` → `rename`). The same EIO hit `npm` renames in agents-update.

### Hypotheses (state of knowledge, 2026-10-04)

1. ~~"While Boat lazily restores, all directory renames under /home fail with EIO."~~
   **Not confirmed.** Owner measurement on a fresh base fork (`<box>`, deleted): commands
   accepted at 9 s; a mkdir+file+`mv` probe in `~/.cache` succeeded from 12 s on, 0 failures,
   6 in a row by 64 s.
2. **Current (UNVERIFIED):** Boat restores the disk block by block, on demand. Operations that
   touch not-yet-restored blocks can fail with EIO when Boat's fetch fails (cf. the "Restore
   incomplete … 504" errors in T1/T2). So the failures are **location-dependent, not
   universal**. A probe somewhere else can pass while the skill store still fails. Run 8's EIO at
   +4 min (create) and +2 min (resume) is real either way.

### What the plugin does (T13)

1. **Disk-settled gate** (`src/fsgate.ts`), create **and** resume, before the hub gate. Order:
   **fs gate → hub gate → skill-store cleanup → agent env → bootstrap**. Each attempt, as the
   box user:
   - **where:** inside the daemon's data dir when it exists
     (`~/.bb-machines/<server>/runtime/.bb-rename-probe`, i.e. resume, the location that
     failed). On create there's no data dir before bootstrap, so it uses
     `~/.bb-machines/.rename-probe` on the same filesystem. The output says which (`where=`).
   - **what:** mkdir a fresh dir, write a file, `mv` it to a new name, delete it. Only an error
     code and step leave the box (`err=EIO step=rename`).
   - **kernel I/O errors since boot:** `sudo -n journalctl -k -b` (else `dmesg`), counting lines
     matching `I/O error|blk_update_request|EIO`, in total and on `vda`. Shown in the progress
     line. When the count is readable, a sample counts toward the streak only if the count **did
     not grow** since the previous sample. Unreadable = ignored.
   - **pass:** `renameProbeOk` in a row (default 6), 10 s apart; bound
     `renameProbeTimeoutMinutes` (default 20). On timeout create/resume fails with "Boat is still
     restoring the disk after N min: last problem: … ; kernel I/O errors …".
   - progress: "Waiting for Boat to finish restoring the disk (directory renames still fail: EIO;
     kernel I/O errors since boot: N (vda M))" or "(renames work, but kernel I/O errors … still
     increasing)"; the pass is logged with the time, location and count.
   - The probe area is removed after the gate (and by the pre-bootstrap cleanup).
2. **Cleanup before bootstrap** now also removes `runtime/skill-store/.tmp-*` leftovers (half-built
   trees from a failed rename), besides empty `<hash>` dirs.
3. **Machine ready only after the gate:** bootstrap, and with it bb's "connected/active", comes
   after it. **Resume pays this wait again** (the restore is lazy after every resume). On a
   healthy fresh base fork that's about 60–70 s (6 × 10 s); longer while the restore is still
   busy.
4. **Warm-up: not possible through public API.** The daemon pulls injected skill trees only
   internally, at `thread.start` (`mee` → `RM` → `fetchSkillTree`). There's no `bb` CLI command
   or SDK call to trigger it; `bb skill list` lists skills and doesn't pull trees. The only way to
   force it would be a throwaway thread on the new machine (costs a model turn). Not done.
   Instead, the **post-enroll watcher** (every 60 s, ≤15 min) re-runs the skill-store cleanup
   (empty `<hash>` dirs; `.tmp-*` older than 10 min, so it can't race a pull in progress). If a
   thread start still hits ENOENT/EIO, the leftovers are gone and the next start pulls again,
   which is the run-6 recovery path.

**Uncertainty:** the gate is a timing heuristic over hypothesis 2. It reduces but may not
eliminate failures: a probe at one location passing doesn't prove the skill store's blocks are
local. The kernel count is a second, location-independent signal; whether Boat's failed block
fetches show up there is **unverified** (the first live run will tell, since the count is in the
progress line). Default timeout 20 min is a placeholder until the reviewer's measured EIO window
lands.

## Verified live: run 9, threads work; remove blocked by interrupted hooks (T14)

Plugin `7c7cc90`, source = base.

| What | Result | Status |
|---|---|---|
| Create | ~5.5 min to connected/active, including the disk-settled gate | **VERIFIED** |
| Resume | ~6 min | **VERIFIED** |
| Threads | **All passed:** pi before suspend, claude ×2, pi after resume, claude after resume | **VERIFIED** |
| Disk-settled gate (T13) | Held; **no skill-store failures this run** | **VERIFIED** (one run) |
| agents-update marker | Arrived on the runner: all ok | **VERIFIED** |
| **Remove** | Core blocked it: "Environment hook outcome is unknown after interruption. Automatic cleanup is blocked; inspect the workspace before recovering it." Three worktree environments (archived test threads) in phase `teardown`, teardown status `failed` (attempt 8) | Bug, fixed below |

`bb guide environments`: "Hook state is held only in daemon memory; a daemon restart leaves an
interrupted hook outcome unknown." The test script archived threads and suspended within
seconds, so the environments' teardown hooks were cut by the stop. The plugin's agent-env
watcher can also restart the daemon (T12), with the same effect.

### Fix: never interrupt environment hooks (`src/envguard.ts`)

The plugin reads environments on the host with `bb.sdk.environments.list({ hostId })`
(`status`: creating | provisioning | ready | error | destroyed; `lifecycle.phase`: active |
retiring | teardown | destroyed; `lifecycle.retireAt`; `lifecycle.teardown.{status, attempt}`).

- **Never restart the runner daemon** (agent-env refresh) and **never request a suspend**
  (idle / pre-TTL policy) while any environment on the host is creating/provisioning, in
  `teardown` (running **or** failed, since core retries a failed one), or `retiring`. A retiring
  environment starts its teardown when its grace ends; for these actions all retiring ones count,
  which covers "retireAt within the next ~2 min". Logged as "… deferred (environment teardown
  running: env_x teardown failed, …)". A deferred **pre-TTL** suspend extends Boat's TTL instead,
  so Boat's auto-stop can't do what the plugin just refused. If the environment list itself fails,
  the action is deferred (fail safe).
- **Suspend and remove callbacks** wait, before stopping/deleting the box, for environments to
  leave provisioning / teardown / imminent retirement (`retireAt` within 2 min). Bounded at 3 min,
  10 s polls, with progress "Waiting for environments on the machine to finish before stopping
  the box: …". After the bound it proceeds with a warning; for a failed teardown it says that bb
  has no supported recovery (below). Waiting forever isn't an option: core has already drained
  threads and asked for the stop.

**Limit:** the plugin can't prevent an interruption it doesn't cause (for example, a script that
archives and suspends within seconds, if core itself doesn't wait for teardown). It can only avoid
being the cause and make the stop wait a little. Core's own suspend/remove path may still cut a
hook, and then there is no supported way out (below).

### Recovery: none supported (correction, run 10)

**The run-9 "manual recovery" was wrong.** `bb environment cleanup <id>` returned `ok` but did
**not** clear the stuck environments: their teardown attempts kept rising (8 → 14) with the same
"Environment hook outcome is unknown after interruption" message. `bb thread unarchive` didn't
reset them either.

Why (bb 0.45.0, `server/dist/start-server.js`, `cancelPendingEnvironmentHook`; confirmed by
reading the code): every environment hook has a row in the `environment_hook_operations` table.
Teardown and machine suspend call the daemon's `environment.hook.cancel` for each unfinished
row. A restarted daemon has no memory of the hook and answers `status: "unknown"`. The server
then throws the "outcome is unknown" error **before** the statement that sets `finishedAt`, so
the row never finishes and every retry fails the same way. No CLI command or SDK call marks
such a row finished.

**State of things:**
- There is **no supported recovery**. The stuck environment and machine records stay (teardown
  retrying, removal blocked) until bb fixes this, or until the row is marked finished in bb's
  database. That is an owner decision about editing bb's database directly; it isn't automated
  and the plugin will not do it.
- Before any such decision, inspect the workspaces (`bb environment list --host <machine>
  --json`, then `git status` in each worktree) so no work is lost. In run 9 all three had 0
  changes.
- Prevention is all the plugin can do (rules above). Upstream report:
  [UPSTREAM-BB-BUGS.md](UPSTREAM-BB-BUGS.md).

## Boat page: Delete (T16, owner request)

v1 had no delete; now every box **except the base / configured fork source** has a **Delete**
action (hidden on the base, and refused server-side by `configuredNotBase`, like the other
state-changing actions). RPC `boat_delete {boxId, confirmBoxId, mode}`:

- **Typed confirmation:** the user must type the exact box id. The dialog says it's permanent
  (disk and that box's snapshots). A mismatch is refused in the page *and* on the server, before
  any bb or Boat call.
- **Box linked to a bb machine:** the dialog names the machine. The default, **"Remove machine
  and box"**, calls bb's machine removal (`bb.sdk.hosts.delete({hostId})`), so **core tears down
  the machine's environments first**. Then:
  - plugin machine: core calls this provider's `remove`, which deletes the box (T7/T14 delete
    path, including the wait for environment hooks);
  - manual machine (e.g. `<box-hostname>`): bb only revokes it, so the page records a **pending box
    delete**, and the plugin's minute schedule deletes the box once bb lists the machine as gone
    (`destroyed` or absent). Deleting the box earlier would kill the daemon that core needs for
    the teardown.
- **"Delete box only"** appears only when the linked machine is **stuck** (not `connected`, or
  phase `removing` / `cleanup-failed`). The dialog warns that the bb machine record stays until bb
  can clean it up. For a connected, healthy machine the server refuses box-only.
- **Box-only / unlinked delete** uses the existing `deleteBox`: `X-Ascii-Confirm-Delete`, then
  poll until `GET /boxes/{id}` 404s (verified live T7/T8), bounded at 90 s inside the RPC. Boat
  finishes on its own after that, and the page says so.

### Machines stuck in "removing" with "Host is not connected" (live, 2026-10-04)

Two machines sat in `removing`: `<box-hostname>` (plugin machine) and `<box-hostname>` (manual). Core
must tear down their worktree environments **on the host** before it can finish removal, and both
boxes were stopped, so there was no daemon to do it. bb has no force-remove.
- **Do:** resume the box (Boat page → Resume, or `boat resume <box>`). The daemon reconnects with
  its own identity (runner-ensure keeps it) and core finishes the teardown and the removal. For
  the plugin machine the provider then deletes the box. For a manual machine, delete the box
  afterwards (Boat page → Delete).
- **If a teardown is stuck on "Environment hook outcome is unknown after interruption"** (T15),
  resuming won't help: bb 0.45.0 has no supported recovery. The remaining option is an
  owner-approved fix in bb's database (marking the hook operation finished). It isn't automated.
- "Delete box only" stops the Boat billing but leaves the bb records.

## Fork as a bb runner; Boat in the New Thread picker (T17, owner request)

Live: the owner clicked **Fork** on the Boat page expecting a bb runner. It made a plain Boat fork
(`<box>`) that never became a bb machine.

**Boat page Fork, now two actions:**
- **"Fork as bb runner"** (first, default): RPC `boat_fork_runner {boxId, requestId}` calls bb core's
  `bb.sdk.hosts.experimental_create({ machineProviderId: "boat", key: "boat-page-fork-<requestId>",
  inputs: { source: "fork", from: <boxId> }, wait: false })`. Core then runs the normal create path
  (fork → disk check → conversion → hub check → enrollment), and the machine shows up in Machines.
  The key is stable per click (a UUID from the page), so a retried request can't create two machines
  (core's create is idempotent by key). The page notice links to the new machine
  (`/settings/machines/<hostId>`). It's allowed on the base box, the normal source. The source box
  isn't changed.
- **"Plain fork (no bb runner)"**: the old behaviour (direct Boat fork, Idempotency-Key per click),
  clearly labelled.

**"Make bb runner" (adopt an existing box): skipped, by design.** bb's machine-provider contract
assumes the machine *owns* the compute it creates: a failed or cancelled create runs
`reconcileCleanup`/`remove`, and removing the machine deletes its box. Adopting a box the owner
created separately would let any of those paths **delete that box**. Guarding it (an "adopted" flag
that makes remove/cleanup skip the delete) would split the provider into two ownership models and make
removal behave differently per machine. Forking the box as a runner reaches the same goal without that
risk.

**Environment compositions.** Machine registration alone adds no picker option. bb shows a machine
provider in the New Thread environment picker only through an environment composition
(plugin-api-docs, machine-providers; the bundled Modal plugin does the same). The plugin registers:

| Composition id (`--environment-provider`) | Name | Machine | Environment |
|---|---|---|---|
| `boat` | Boat sandbox | `boat` | `git-worktree` |
| `boat-checkout` | Boat sandbox (project checkout) | `boat` | `project-checkout` |

Core creates the machine, prepares the project checkout once it connects, then asks the environment
provider for the workspace. **Each such thread gets a new Boat box** (bills; `ephemeral: false`, so
it stays until removed). CLI: `bb thread spawn --project <id> --environment-provider boat --prompt …`
(optional `--machine-inputs '{"source":"fork","from":"bx_…","type":"large"}'`). A machine-inputs control
(`app.slots.experimental_machineProviderInputs`) offers "Fork from" (blank = the plugin's default, shown
as placeholder via RPC `boat_machine_defaults`) and size. Blank inputs are `{}`, which the provider's
schema accepts.

**Settings → Machines → "Add a machine" will still not offer Boat.** In bb-app 0.45.0
(`app/dist/assets/MachineRenameDialog-*.js`) that dialog hard-codes the manual provider: it calls
`hosts.experimental_create({ machineProviderId: "manual", inputs: null, … })` (`xe = "manual"`) and shows
the enrollment command. There is no provider picker there, for any plugin (Modal included). Standalone
Boat machines are created from the Boat page ("Fork as bb runner") or `bb machine create --provider boat`.
Threads get them through the compositions above.

## Project runners: several repos per machine (T18, owner request)

**Projects live in the plugin.** Plugin storage (`bb.storage.kv`, key `projects/v1`) holds
`{ name, repos: [{ name, url, branch? }] }`. On first read it is seeded once with `SEED_PROJECTS`
(empty in the published plugin). Deleting seeded projects afterwards sticks.
Boat page → **Projects** lists them and can create, rename and delete a project (typing the name to
confirm a delete), and add, edit and remove repos. Typed RPCs: `projects_list`, `project_create`,
`project_rename`, `project_delete`, `project_repo_add`, `project_repo_update`, `project_repo_remove`.
Repo URLs must be plain `https://github.com/<owner>/<repo>(.git)`. No credentials, other hosts, ports or
queries are allowed. The server re-validates every URL and stores the canonical `.git` form.

**Repo picker.** bb's builtin GitHub plugin exposes no RPC, so the plugin doesn't use it. RPC
`repos_list {refresh}` runs `gh repo list <owner> --limit 300 --json name,url,isPrivate,defaultBranchRef`
on the bb server for each owner in the setting `githubOwners` (default empty). Results are cached
for 10 min per owner set ("Refresh" forces a new fetch). Only name, URL with credentials stripped,
private flag and default branch are returned, never tokens. If gh is missing, logged out or fails,
it returns `{status:"unavailable", reason}`, and the dialog falls back to manual URL entry, which is
always available.

**Machine input `project`.** The New Thread machine-inputs control has a "Project repos" select
(None or a stored project). `bb machine create --provider boat --inputs '{"project":"webapp"}'` works
the same way. An unknown project, or one with no repos, is refused **before** a box is allocated. The box
keeps the normal `bb-runner-…` name (no `proj-*` rename).

**Create flow (after the hub gate and enrollment, before `create` returns):**
1. Write the project's repos to `~/.project-repos.txt` as the box user, in `name url` lines with a
   trailing newline. A quoted heredoc writes a temp file, then `mv` replaces the manifest. This is
   safe because content is validated, and the shell keeps the trailing newline that the file API
   would strip. Expect `manifest-written=N`.
2. `sudo -n systemctl start --no-block project-repos.service`, i.e. the base's own sync (below).
3. Every 10 s for up to 10 min, a read-only probe lists each manifest line and whether
   `~/workspace/repos/<name>/.git` exists. Progress shows "Cloning <project> repos (n/m)". At the
   limit the create fails with `Cloning <project> repos did not finish in 10 min: missing repos: …`
   (core then cleans up as for any failed create).
4. For each repo, match a bb project by git remote. Normalisation ignores scheme, credentials,
   scp form, port, trailing `/` and `.git`, and case. Then call
   `bb.sdk.projects.sources.add({projectId, type:"local_path", hostId, path:"/home/user/workspace/repos/<name>"})`.
   No clone is involved. A project that already has a source on this host is left alone. Unmatched
   repos are logged. With the setting `createMissingProjects` (default off), the plugin creates a bb
   project from the local path instead. Remotes matching two bb projects are logged as ambiguous and
   skipped.

**Resume** doesn't write the manifest or start the sync, because the sync removes repos that aren't
in the manifest. It re-runs the probe and fails if the manifest or any repo is missing. It then
re-adds any source that's gone (normally all are "present").

**Why sources registered in create are reused (verified in bb-app 0.45.0 server code,
`start-server.js`).** `askMachineLaunch` answers "wait" while the host phase is `creating`, which is
until the provider's `create` returns. Only after that does `resolveProviderOperationContext` call
`getProjectSourceByHost(thread.projectId, host.id)`. It falls through to
`ensureProjectSourceOnHost` → `recoverOrCloneProjectSource` (the clone) only when no source exists,
and that function returns an existing source first. So a `project-checkout` thread on a project
runner uses `~/workspace/repos/<name>` and doesn't clone a second copy. The add-source route only
rejects destroyed hosts, so a host that is still `creating` is accepted (read in code, **not yet seen
live**).

**What the base's sync does.** Source: the owner notes (2026-09-19);
records it as unchanged. The script itself wasn't re-read, by the base-box rule.
`project-repos.service` runs `project-repos-provision.sh` (ExecStartPre), then
`/usr/local/bin/project-repos-sync.sh`:
- The provisioner only installs a manifest for boxes named `proj-*` whose manifest is empty. For
  our runners (named `bb-runner-…`, manifest already written) it does nothing.
- The sync reads `~/.project-repos.txt` and clones or updates each repo into
  `~/workspace/repos/<name>`. It skips dirty repos, removes repos absent from the manifest, and
  purges stray root-level copies. Auth is gh with the box's `GITHUB_TOKEN`.
- A 5-min timer runs it again as a fallback, so the clones also arrive if the `--no-block` start is
  lost.

**Verified vs not verified**
- Verified: unit tests (`test/t18.test.ts`), which cover:
  - the manifest writer and the probe, run for real in a temp HOME, including an unterminated
    last line and credentials stripped on the box;
  - wait/progress/timeout, remote matching and the source plan;
  - the create order (bootstrap → manifest → sync → wait → sources, no `proj-*` rename) and resume;
  - store and RPC CRUD, and gh parsing, caching and unavailable paths.
- Verified: core's source-reuse order (code reading, above).
- **Not verified live:**
  - the sync's exact clone command, and how long the clones take;
  - that **private repos** clone with the box's own `GITHUB_TOKEN`, untested until the first
    project runner;
  - `branch`: stored and shown, but the manifest has no branch column, so the sync clones the
    default branch (branch support in the sync is unknown);
  - `sources.add` on a host that is still `creating`;
  - whether bb's checkout then uses the source without touching it;
  - `gh` being installed and logged in on the hub for the picker.

## Verify on first live run (review 2026-10-04, items 3, 4, 6)

These are open questions, not guesses. The code doesn't depend on any particular answer
beyond what is stated; check each on the first live create/resume/remove and
record the result here.

- **Item 3, box `name` on create/fork. ANSWERED (T7): Boat ignores it.** Cleanup now
  uses intent + replay (above); the replay itself is unverified live.
- **Item 4, response shapes.** Partly answered (T7): the fork 202 body and
  `command.finished` parse (the live create got a box id and the conversion's
  stdout/exit code). Also unseen: the DELETE 202 body (the operation id is read from
  `deletionOperationId`, `operationId`, `operation.id` or `deletionOperation.id`) and
  the `GET /deletion-operations/{id}` status values are still unseen. Since T7 they
  only matter for fast failure; completion is the box's 404.
- **Item 6, `502 box_direct_failed` from the commands API.** Partly answered (T9): the
  `box_restoring` variant (seen live) is a refusal and is retried; every other 502 still
  fails fast as below. The reference says the
  command may still be running. The executor currently surfaces it as a failed
  exec (`BoatApiError`), and core's bootstrap may retry. That double-runs only
  idempotent bootstrap steps (install, enroll by key), which is believed safe but
  not observed. Check whether bootstrap retries after a 502 and what happens.

## Also not verified yet

- Live run against Boat. Specifically: the commands API's exact response shape
  (parsed as top-level or `.command`), whether it runs as `user`, `PUT /files`
  with base64, `POST /boxes` accepting `name` and `from` together, and fork +
  deterministic `Idempotency-Key` returning the same box on retry.
- `bootstrap` through this executor: output is not streamed, and installs longer
  than 600 s would time out (enrollment took ~10–30 s in T1/Phase 0).
- No environment composition is registered yet. Modal registers
  `{machineProviderId, environmentProviderId: "project-checkout"}` so
  `bb thread spawn --environment-provider boat` creates a box per thread. Add it
  once standalone create works.
- `hydrated` webhook as a settle signal.
