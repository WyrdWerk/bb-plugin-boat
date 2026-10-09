# bb-plugin-boat

**Run [bb](https://getbb.app) threads on [Boat](https://boat.dev) sandboxes.** Each new
thread can get its own fresh cloud box, forked from a base box you prepared once, with your
agents, credentials and repos ready. bb on your own machine stays the hub; the boxes are
disposable runners.

> **Status: experimental, v0.1.** An earlier hub completed the end-to-end lifecycle, but
> the **2026-10-09 Amp-orb hub acceptance test failed**. Automatic enrollment succeeded
> once; no LLM thread ran and automatic reconnect did not pass. See the
> [acceptance record](#live-acceptance-status) and [base box contract](BOX-CONTRACT.md).
> Manual enrollment and mocked tests do not establish that the automatic path works.

## What it does

- **Machine provider `boat`**: `bb machine create --provider boat` forks the base box,
  converts the fork into a bb runner, and enrolls it as a bb machine. Suspend, resume and
  remove map to Boat stop, resume and delete.
- **"Boat sandbox" in the New Thread picker**: two environment options,
  **Boat sandbox** (Git worktree) and **Boat sandbox (project checkout)**. Each creates a
  new box for that thread.
- **Project runners**: define projects (a name plus a set of GitHub repos) on the Boat page.
  Pick one when creating a thread or machine and its repos are cloned on the box and
  registered as bb project sources.
- **Boat page** in bb's sidebar: every box on the account with state, auto-stop, health and
  its bb machine; resume, stop, fork (plain or as a bb runner), set TTL, save snapshot and
  delete, each confirmed first. Plus the Projects editor with a GitHub repo picker.
- **Lifecycle**: suspends idle machines, and extends or suspends before Boat's auto-stop
  (TTL) so work isn't cut off.

How it fits together:

```
 your machine (bb hub) ──── Tailscale ────  Boat box (runner, forked from your base box)
   bb server :38886                           bb host daemon ← installed by bb at enrollment
   Tailscale Serve :443 (tailnet only)        claude / codex / pi … run the thread here
   this plugin → Boat REST API                repos in ~/workspace/repos/<name>
```

The model, files and commands for a thread all live on the box. The hub sends prompts and
shows output.

## Requirements

- **bb ≥ 0.45** (plugin SDK 0.6.15).
- **A Boat account** with an API key, ideally scoped to a team wallet.
- **Tailscale** on the hub and on the boxes. The hub's bb server is published to the tailnet
  only (Tailscale Serve), and boxes may reach only that port. See
  [BOX-CONTRACT.md](BOX-CONTRACT.md#required) for the policy.
- **A base box** that meets the [contract](BOX-CONTRACT.md): Tailscale joining per box,
  agent CLIs with credentials in Boat's box environment, passwordless sudo, and a complete
  npm installation. The plugin does not repair npm missing files after a restore.

## Install

On the hub:

```bash
# 1. Set BB_APP_URL in the bb service to this same HTTPS origin, then restart bb.
# Use your actual bb HTTP port in place of 38886 if it differs.
tailscale serve --bg --https=443 http://127.0.0.1:38886
bb settings general machineServerUrl 'https://<hub>.<tailnet>.ts.net'
bb settings general defaultMachineAccess direct

# 2. Install the plugin (pin a tag).
bb plugin install git:github.com/WyrdWerk/bb-plugin-boat@v0.1.0

# 3. Enter the Boat API key manually in bb's plugin settings. Do not put it in argv.
# Configure the non-secret settings here or in the UI.
bb plugin config boat set org "<boat org id or name>"
bb plugin config boat set source fork
bb plugin config boat set from bx_xxxxxxxx           # your base box
bb plugin config boat set githubOwners '<you>,<your-org>' # optional: repo picker
```

For bb 0.45, `BB_APP_URL`, `machineServerUrl` and Tailscale Serve must agree on the
current origin. A reachable TLS endpoint can still return `403 forbidden_host` if they
disagree. During a temporary tailnet test the Portal hostname may therefore be rejected.
Restore the original service environment and machine URL at the end, restart only the
bb service, reset temporary Serve bindings, and disconnect the temporary node. Do not
leave service startup dependent on an on-demand Tailscale connection.

The `apiKey` setting is hidden from frontend read-back. In bb 0.45 it is stored as plaintext
in a private, mode-0600 hub file; “secret” does **not** mean encrypted on disk. Keep it out
of screenshots, logs, command arguments and Git.

Then, in bb: **New thread → pick a project with a Git remote → environment
"Boat sandbox"**, or:

```bash
bb machine create --provider boat --key '<unique-test-key>' --no-wait --json
# Wait for the returned machine to connect, then use that machine, not another fork.
bb thread spawn --project '<project-id>' --machine '<machine-id>' \
  --new-environment worktree --provider '<provider>' --model '<model>' --prompt "…"
```

## Settings

| Key | Default | Meaning |
|---|---|---|
| `apiKey` | — | Boat API key (secret, never sent to the frontend) |
| `org` | — | Boat org new boxes bill to |
| `source` | `fork` | `fork` a box, or create from a named `snapshot` |
| `from` | — | Base box id (fork) or snapshot name |
| `type` | `default` | Box size |
| `ttlHours` | 4 | Boat auto-stop set on create/resume |
| `idleMinutes` | 15 | Suspend idle machines (0 = never) |
| `preTtlMarginMinutes` | 15 | Act this long before auto-stop |
| `githubOwners` | — | Owners the repo picker lists (`gh repo list` on the hub) |
| `createMissingProjects` | off | Create bb projects for cloned repos that match none |
| `renameProbeOk` | 6 | Disk-settled gate: renames in a row before enrolling |
| `renameProbeTimeoutMinutes` | 20 | Give up on the gate after this long |
| `waitForAgentUpdates` | off | Wait for the base's agent-update marker before enrolling |

## Live acceptance status

The 2026-10-09 test used the stock v0.1 plugin on an Amp-orb bb 0.45 hub. Five owned
forks were attempted, and all five were removed afterwards:

| Path | Observed result |
|---|---|
| Automatic fork → conversion → enrollment | Passed once, including a real host-daemon session; two other forks failed with `Runner conversion failed: bb-server-still-on-tailnet` |
| Real remote LLM thread and independently checked result | **Not reached** |
| Plugin suspend → resume → reconnect | Suspend passed; reconnect failed. The orb exhausted its 3 GiB workload memory limit during the enrolled attempt; the bb and Tailscale processes were killed |
| Provider removal / failure cleanup | Passed for the failed or unused test machines; removal after an LLM thread and its environment cleanup was **not reached** |
| Two later creates and resume attempts | Failed with ``Boat API 502 box_direct_failed: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()`` |

The 502 cause remains unresolved. Runner-to-hub HTTPS was later verified with TLS
validation and HTTP 200, so broadening the access rule or disabling TLS verification is
not an established fix. The separate earlier manual enrollment/remote-command/reconnect
test passed, but does not validate automatic conversion or an LLM thread.

For a complete acceptance run, use one owned runner at a time and:

1. Verify the base's npm installation and wait for any active agent updater before an
   installer. On the tested base it runs global npm updates for about ten minutes after
   every resume. See [npm checks and repair](BOX-CONTRACT.md#npm-integrity-and-update-order).
2. Configure matching hub origins and runner-to-hub TCP 443 only. Confirm `/health` from
   the runner with normal TLS verification before treating enrollment as ready.
3. Create through the **Boat provider**, not manual enrollment. Record the machine id,
   box id and a unique creation key; wait for a connected daemon and an active machine.
4. Check the runner's actual provider/model catalog (`bb provider models <provider>
   --machine <machine> --json`). Run a real thread against a remote Git project with a
   small asymmetric fixture. Check the exact output against an independently calculated
   result; a connected badge or a created thread row is insufficient.
5. Stop and resume through the plugin, verify the same box and machine reconnect, and run
   another command on that runner. Then remove it through the plugin and verify both the
   Boat box and bb machine are gone, including the thread's environment cleanup.
6. Clean up once at the end. Verify no owned runner remains, restore temporary hub
   settings/service overrides, reset temporary Serve bindings and disconnect Tailscale.
   Preserve unrelated boxes and the owner-entered key.

## Known issues

- **Restored npm can be incomplete.** `MODULE_NOT_FOUND node-gyp/bin/node-gyp.js` on the
  tested Node 24.19.0 image was caused by missing files in npm itself. Repair the global
  npm installation, not an isolated copy or an unrelated npm dependency.
- **Conversion can leave the standalone bb publication visible.** The test saw
  `bb-server-still-on-tailnet` even after the standalone server stopped. A later identical
  Serve reset succeeded; concurrent boot publication is suspected but unproven.
- **Boat direct-command 502 has an ambiguous outcome.** A command may have executed before
  its response was lost. Inspect the same box/machine and logs before retrying a command
  or creating another fork. Do not blindly replay side effects.
- **Temporary hub networking needs careful lifecycle handling.** Repeated certificates
  for one hostname can hit ACME rate limits; creating more boxes does not solve that.
  After an approved node rename, wait for its current DNS name before resetting and
  reapplying Serve. On Amp, restart the named bb service rather than all services during
  an on-demand Tailscale lease.
- **The enrolled test exhausted the orb workload memory limit.** It ran bb alongside
  several Amp plugin runtimes. A killed hub cannot validate reconnect; this observation
  does not establish that bb alone needs more memory.
- **Slow first start: ~6 min from "new thread" to a running agent** on our setup. Most of
  it is the disk-settled gate: Boat restores a fork's disk lazily, and until it settles bb
  can't install its skills (renames fail with EIO). Reusing an existing runner machine for
  the next thread avoids it. A warm pool of pre-forked runners is the planned fix.
- **The thread's bb project must have a Git remote** for Boat sandbox environments (a bb
  rule: "requires a project with a Git remote").
- Repos cloned by a project runner only become bb sources if a bb project with the same
  remote exists (or `createMissingProjects` is on).
- The per-repo `branch` field in Projects is stored but not yet used when cloning.
- Paths on the box (`/run/ascii-secrets/…`, user `user`) and the optional boot unit names
  are fixed in code, not settings.
- Settings → Machines → "Add a machine" only offers manual enrollment in bb 0.45; use the
  New Thread picker, the Boat page's "Fork as bb runner", or the CLI.
- Two bb bugs affect remote machines and are worked around here:
  [#4158](https://github.com/get-bb/bb/issues/4158) (an interrupted environment hook blocks
  cleanup forever) and [#4855](https://github.com/get-bb/bb/issues/4855) (a broken skill
  store fails every thread start). See [docs/UPSTREAM-BB-BUGS.md](docs/UPSTREAM-BB-BUGS.md).
- Tested only with Tailscale for connectivity; bb Connect was not tried.

## Development

```bash
npm install
npm test            # node --test; no Boat calls (fakes + the SDK's fake plugin host)
npm run typecheck
bb plugin build     # dist/server.js + dist/app.js
npm run gen         # after editing runner/*.sh (re-embeds them; a test checks drift)
```

| Path | Role |
|---|---|
| `server.ts` | Plugin entry: settings, provider + compositions, lifecycle schedule |
| `src/boat-api.ts` | Boat REST client (drops secret box fields at parse time) |
| `src/provider.ts` | create / suspend / resume / remove / cleanup |
| `src/conversion.ts` | Turns a fresh fork into a runner (root, idempotent, verified) |
| `src/policy.ts`, `fsgate.ts`, `hubgate.ts`, `boxprep.ts`, `envguard.ts` | Gates and box prep before enrollment |
| `src/lifecycle.ts` | Idle and pre-TTL sweep |
| `src/dashboard.ts`, `ui/`, `app.tsx` | Boat page (server RPCs + React UI) |
| `src/projects.ts`, `project-store.ts`, `github-repos.ts` | Project runners and the repo picker |
| `runner/` | Scripts installed on each runner; `runner/reference/` is an example repo sync |
| `components/`, `lib/`, `hooks/` | UI components vendored from bb's plugin scaffold (MIT) |
| `docs/DESIGN.md` | Design notes and the evidence log from building it |

## License

MIT. See [LICENSE](LICENSE). Vendored bb components: see [NOTICE](NOTICE).
Not affiliated with bb or Boat.
