# bb-plugin-boat

**Run [bb](https://getbb.app) threads on [Boat](https://boat.dev) sandboxes.** Each new
thread can get its own fresh cloud box, forked from a base box you prepared once, with your
agents, credentials and repos ready. bb on your own machine stays the hub; the boxes are
disposable runners.

> **Status: experimental, v0.1.** Built and tested on **one** setup (one bb hub, one Boat
> team, one base box). It works end to end there; it will need adjusting for yours. Read the
> [base box contract](BOX-CONTRACT.md) first. Feedback and PRs welcome.

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
   Tailscale Serve :3888 (tailnet only)       claude / codex / pi … run the thread here
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
  agent CLIs with credentials in Boat's box environment, passwordless sudo.

## Install

On the hub:

```bash
# 1. Publish bb to your tailnet only, and tell bb that URL.
tailscale serve --bg --https=3888 http://127.0.0.1:38886
bb settings general machineServerUrl https://<hub>.<tailnet>.ts.net:3888

# 2. Install the plugin (pin a tag).
bb plugin install git:github.com/WyrdWerk/bb-plugin-boat@v0.1.0

# 3. Configure it.
bb plugin config boat set apiKey <boat-api-key>      # stored as a secret
bb plugin config boat set org "<boat org id or name>"
bb plugin config boat set source fork
bb plugin config boat set from bx_xxxxxxxx           # your base box
bb plugin config boat set githubOwners <you>,<your-org>   # optional: repo picker
```

Then, in bb: **New thread → pick a project with a Git remote → environment
"Boat sandbox"**, or:

```bash
bb machine create --provider boat --json
bb thread spawn --project <id> --environment-provider boat --model <model> --prompt "…"
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

## Known issues

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
