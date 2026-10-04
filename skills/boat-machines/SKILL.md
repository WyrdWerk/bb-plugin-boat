---
name: boat-machines
description: Create, suspend, resume and remove bb machines backed by Boat sandboxes (boat.dev) through the experimental Boat machine provider.
---

# Boat machines (experimental)

The `boat` machine provider runs bb threads on Boat sandboxes enrolled as bb
machines. Core does enrollment, checkout setup and the machine record; the
plugin allocates, stops, resumes and deletes boxes.

## Setup

Plugin settings (`bb plugin config boat`): `apiKey` (secret, a team-wallet Boat
key), `org` (team wallet id or name, never personal), `source` (`snapshot` or
`fork`), `from` (named snapshot or source box id), `type`, `ttlHours`,
`idleMinutes`, `preTtlMarginMinutes`, `waitForAgentUpdates` (default off),
`renameProbeOk` (default 6), `renameProbeTimeoutMinutes` (default 20),
`githubOwners`, `createMissingProjects`. Never print the key.

New machines are **forks of the base box** named in `from` (with `source=fork`).
The base is never modified: only forked. What the base box must provide is in the
plugin's `BOX-CONTRACT.md`. At
create the provider converts the fork into a runner: the box's own bb server is
blocked (`/etc/bb-runner-mode`), it's unpublished from the tailnet, runner-ensure is
installed, and the result is verified. A failed conversion fails the create with
`Runner conversion failed: <reason>`. The fork joins the tailnet itself
(`tailscale-ensure.sh`), so the hub's machine URL must be reachable over it.

## Use

```bash
bb machine create --provider boat --json                    # settings defaults
bb machine create --provider boat --inputs '{"source":"fork","from":"bx_abc123","type":"large"}' --json
bb machine suspend <machine> ; bb machine resume <machine>
bb machine remove <machine> --yes --json                    # deletes the box
```

## Rules the provider enforces

- The base box only ever gets *forked*. The Boat page refuses resume, stop, TTL and
  snapshot on it.
- A forked or snapshot-created box never starts a copied bb identity: before
  bootstrap it wipes runner state not stamped with its own box id.
- After create and resume it waits until Boat's restore has settled
  (`runner-ensure` ran and bb repos are clean, or match what was dirty at
  suspend, on two samples ≥10 s apart). It refuses a box whose Boat `error` says
  `Restore incomplete`. Its files may be missing.
- If Boat hasn't started the box's boot units (`pi-boot-init`, `tailscale-rejoin`,
  `agents-update`) ~2 min after ready, the provider starts them. A failed
  `pi-boot-init`/`tailscale-rejoin` fails create/resume (no provider keys, no
  Tailscale).
- After create **and** resume the provider waits until the box's disk has settled
  (directory renames in the daemon's data dir work 6 times in a row, no new kernel I/O
  errors) before enrolling. Boat restores lazily, and bb can't install skills while
  renames fail. Expect ~1 min on a healthy box, longer right after a fork or resume. If a
  thread still fails at start with a skill-store ENOENT/EIO, retry it a minute later.
- Agent updates on the box finish ~8–10 min after ready. The result line
  (`pi=ok codex=ok …`) shows in the machine progress or the plugin log and in the
  Boat page's "Agents" column. Machines don't wait for it unless
  `waitForAgentUpdates` is on.
- Before Boat's auto-stop (TTL) it extends the TTL while work is running and
  otherwise suspends through bb. Idle machines suspend after `idleMinutes`.

## Boat page

The sidebar's **Boat** page (`/plugins/boat/boat`) lists every box on the account
with its state, auto-stop, health, snapshot status and bb machine, plus wallet
limits and named snapshots. Resume, stop, fork, set TTL and save snapshot are
there, each confirmed first (delete is below). A human uses this page; agents
should use `bb machine …` and ask before any state change.

## Environment hooks: don't interrupt them (there is no recovery)

bb keeps environment setup/teardown hook state only in the host daemon's memory. Stopping
the box or restarting the daemon mid-hook leaves the outcome unknown, and core then blocks
cleanup and machine removal with "Environment hook outcome is unknown after interruption".

- The provider never restarts the daemon or requests a suspend while an environment on the
  machine is provisioning, tearing down or retiring. Suspend and remove wait up to 3 min for
  them to finish.
- Don't archive threads and suspend/remove the machine within seconds yourself; give
  teardowns a minute.
- **There is no supported recovery** once it happens (bb 0.45.0). `bb environment cleanup`
  returns ok but doesn't clear it, and `bb thread unarchive` doesn't either: bb's server keeps
  retrying the teardown and keeps failing. The stuck environment and machine records stay until
  bb fixes it, or until the owner decides to mark the hook operation finished in bb's database.
  Don't attempt that yourself. Do inspect the workspaces
  (`bb environment list --host <machine> --json`, `git status`) so nothing is lost, and tell
  the owner. Upstream: https://github.com/get-bb/bb/issues/4158.

## Deleting boxes (Boat page)

Every box except the base/fork source has **Delete**. You must type the exact box id; it is
permanent (disk and that box's snapshots). For a box that is a bb machine the default is
**Remove machine and box**: bb removes the machine first (tearing down its environments),
then the box is deleted (by the provider for plugin machines; automatically once bb is done
for manual machines). **Delete box only** appears only for a stuck machine and leaves the bb
machine record behind. Agents: never delete without the owner asking for that box by name.

## Machines stuck in "removing" ("Host is not connected")

bb must tear down the machine's environments on the machine itself, so a stopped box can't
finish removal, and bb has no force-remove. **Resume the box** (Boat page → Resume) so the
daemon reconnects; bb then finishes the teardown and removal. If an environment is stuck on
"Environment hook outcome is unknown after interruption", resuming won't help: tell the owner
(only an owner-approved fix in bb's database clears it).

## Making runners (T17)

- **Boat page → Fork as bb runner** (any box, including the base): bb creates a new machine
  from a fork of that box and runs the full setup; it appears in Machines in a few minutes.
  **Plain fork (no bb runner)** only copies the box in Boat.
- **New thread on a fresh Boat box:** pick **Boat sandbox** (worktree) or **Boat sandbox
  (project checkout)** in the New Thread environment picker, or
  `bb thread spawn --project <id> --environment-provider boat --prompt "…"`
  (`boat-checkout` for the checkout variant; optional
  `--machine-inputs '{"source":"fork","from":"bx_…","type":"large"}'`). Each such thread
  creates a new box that bills until the machine is removed.
- Settings → Machines → "Add a machine" only offers manual enrollment in bb 0.45.0; Boat
  isn't listed there (bb limitation).
- There is no "adopt an existing box": fork it as a runner instead.

## Project runners (T18)

- Projects (a name plus a list of GitHub repos) are kept by the plugin. Boat page →
  **Projects** to create, rename or delete them (delete asks you to type the name) and to add,
  edit or remove repos. URLs must be `https://github.com/<owner>/<repo>`, with no tokens.
- "Pick from GitHub" lists repos via `gh` on the bb server (setting `githubOwners`). If it says
  unavailable, enter the URL by hand.
- To get a runner with those repos, pick the project under **Project repos** in the New Thread
  machine inputs, or run `bb machine create --provider boat --inputs '{"project":"<name>"}'`.
  Create waits (up to 10 min, "Cloning <project> repos (n/m)") until every repo is in
  `~/workspace/repos/<name>`. It then adds each repo as a source of the bb project with the same
  remote, so threads on that machine use those checkouts. Repos with no matching bb project are
  only logged, unless `createMissingProjects` is on.
- If create fails with "missing repos: …", the box couldn't clone them. Check the repo URL and
  access (private repos use the box's own GitHub token).
