# Base box contract

The plugin never builds a box from scratch. It **forks one base box** (or creates from a
named snapshot) that you prepared once, then converts each fork into a bb runner. This file
lists what that base box must provide. Everything here was true of the one setup the plugin
has been tested on (Ubuntu 24.04 Boat boxes, systemd 255); other setups are untested.

The plugin only ever *forks* the base. It never resumes, stops, changes or deletes it, and
the Boat page refuses those actions on it.

## Required

| What | Why | How the plugin uses it |
|---|---|---|
| Linux with systemd (system and user managers) | Units for the bb host daemon and the runner guard | `systemctl`, `systemctl --user` via `runuser` |
| A login user named `user` (home `/home/user`) with passwordless sudo | Boat's default user; the conversion runs as root | `sudo -n bash -c …`; fails with "sudo -n refused?" if not allowed |
| **Tailscale** installed, and every box joining your tailnet **as its own node** at boot | The bb host daemon on the box connects back to the hub | Hub gate before enrollment: `tailscale` BackendState `Running`, hub name resolves, `GET <hub>/health` answers |
| Agent CLIs installed (Claude Code, Codex, Pi, …) | bb runs threads with the providers installed on the machine | bb's own provider discovery |
| Agent credentials in Boat's box environment file `/run/ascii-secrets/env.sh` | The bb host daemon's user unit doesn't read your shell profile | Copied (`KEY=value` lines only) into `/run/bb-runner/agent-env` (0600), loaded by a drop-in. For Claude Code: `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) |

**Tailscale on forks.** A fork copies the base's disk, including Tailscale's node state. If
the fork reuses it, two machines claim one node. Your base must make each box join as a new
node, e.g. a boot unit that notices the box id changed (Boat writes `BOAT_ID` into
`/run/ascii-secrets/env.sh`), clears `/var/lib/tailscale`, and runs
`tailscale up --auth-key=<ephemeral, reusable, tagged key>`. Keep that key out of the
snapshot (load it from your secret store at boot).

**Network policy.** Give boxes a tag (e.g. `tag:boat`) and let that tag reach only the hub's
machine port:

```jsonc
// tailnet policy (grants)
{ "src": ["tag:boat"], "dst": ["<hub-ip>"], "ip": ["tcp:3888"] }
```

Boxes never need to reach each other or anything else on your tailnet.

## Optional (used when present)

| What | Used for | If missing |
|---|---|---|
| Boot units `tailscale-rejoin`, `pi-boot-init`, `agents-update` (system units) | Boat sometimes doesn't start a fork's boot units; the plugin starts these if they're loaded but never started, and waits for `tailscale-rejoin` to finish before enrolling | Treated as absent; nothing waits for them |
| `/run/ascii-secrets/bws-providers.sh` | Extra provider keys (`KEY=value` / `export KEY=value`), merged into the agent env; re-applied when it appears later | Skipped |
| `/run/user/<uid>/agents-update.done` (one line, e.g. `<time> pi=ok codex=ok`) | Shown in the Boat page's Agents column; `waitForAgentUpdates` waits for it | Column shows "not seen" |
| `project-repos.service` + `/usr/local/bin/project-repos-sync.sh` | **Project runners** (several repos per machine). The plugin writes `~/.project-repos.txt` (`<name> <https-url>` per line) and starts the service; it then waits until every repo is at `~/workspace/repos/<name>` | Project runners fail with "missing repos"; everything else works. A reference sync script and unit are in [`runner/reference/`](runner/reference/) |
| git credentials for private repos (e.g. `GITHUB_TOKEN` + `gh auth setup-git`) | Cloning private repos on the box | Private clones fail |
| Its own bb server (`bb-app.service`, `/usr/local/sbin/bb-ensure.sh`) | Nothing: if the base runs a standalone bb server, the conversion turns it off on every runner and unpublishes it from the tailnet | Conversion skips those steps |

## What the plugin installs on each runner (never on the base)

- `/etc/bb-runner-mode` marker and a `bb-app.service` drop-in that keeps a standalone bb
  server off.
- `/usr/local/sbin/runner-ensure.sh` + `bb-runner-ensure.service`: on every boot, wipes a bb
  machine identity that was copied from another box (fork identity guard) and stamps this
  box's id in `~/.config/bb-runner/boat-id`.
- `/usr/local/sbin/bb-runner-guard.sh` as `ExecStartPre` of the bb host daemon.
- `/run/bb-runner/agent-env` + drop-in `bb-host-daemon-.service.d/20-agent-env.conf`.
- Then bb's own machine bootstrap installs the bb host daemon.

Sources: [`runner/`](runner/), `src/conversion.ts`, `src/boxprep.ts`, `src/policy.ts`.
