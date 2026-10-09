# Base box contract

The plugin never builds a box from scratch. It **forks one base box** (or creates from a
named snapshot) that you prepared once, then converts each fork into a bb runner. This file
lists what that base box must provide. The original setup used Ubuntu 24.04 Boat boxes
and systemd 255. A later Amp-orb hub test failed full automatic acceptance despite one
successful enrollment; see the [current coverage](README.md#live-acceptance-status).

The plugin only ever *forks* the base. It never resumes, stops, changes or deletes it, and
the Boat page refuses those actions on it.

## Required

| What | Why | How the plugin uses it |
|---|---|---|
| Linux with systemd (system and user managers) | Units for the bb host daemon and the runner guard | `systemctl`, `systemctl --user` via `runuser` |
| A login user named `user` (home `/home/user`) with passwordless sudo | Boat's default user; the conversion runs as root | `sudo -n bash -c …`; fails with "sudo -n refused?" if not allowed |
| A complete Node/npm installation, including npm's bundled node-gyp | bb's official installer installs the runner build and its native dependencies | Missing npm files can fail installation with `MODULE_NOT_FOUND node-gyp/bin/node-gyp.js`; the plugin does not repair them |
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
{ "src": ["tag:boat"], "dst": ["<hub-ip-or-tag>"], "ip": ["tcp:443"] }
```

This assumes Serve publishes bb over HTTPS 443; another deliberately selected HTTPS port
needs its corresponding narrow grant. Boxes never need to reach each other or anything
else on your tailnet. Hub-to-runner diagnostic access, if needed, is a separate rule.
Use the same current HTTPS origin in the hub's `BB_APP_URL`, `machineServerUrl` and Serve,
and select `defaultMachineAccess direct`. Require a real runner-to-hub `/health` HTTP 200
with TLS verification, not just an online node or an open port.

## npm integrity and update order

On the tested Node 24.19.0 image, healthy npm 11.17.0 has **1,938 registry files** and
bundled node-gyp v12.4.0. Extra Python cache files can raise the count; compare the package
manifest rather than treating every different count as corruption. After a restore npm
was observed with only 743 files, including missing npm and node-gyp binaries.

The base's `agents-update.service` runs global npm updates after every resume, for about
ten minutes on this image. Boat may report idle before systemd starts it. Poll about
every 30 seconds and check `systemctl show agents-update -p ActiveState -p Result
-p ExecMainStartTimestamp`: require an invocation from this resume to finish before
repairing npm or running an installer. An initial `inactive` result is insufficient.
`waitForAgentUpdates=true` is only a bounded marker wait **after conversion**, up to
15 minutes, and continues on timeout. It does not guarantee successful updates or
serialize all earlier conversion steps with the updater.

With owner authorization, run this as `user` on the base after its current updater has
finished. This repairs **global npm**, using the registry tarball to bypass missing npm
entry points, and verifies the tarball's SHA-512 integrity before running it:

```bash
set -euo pipefail
export HOME=/home/user
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsS https://registry.npmjs.org/npm/11.17.0 >"$tmp/metadata.json"
curl -fsS https://registry.npmjs.org/npm/-/npm-11.17.0.tgz >"$tmp/npm.tgz"
expected=$(jq -r .dist.integrity "$tmp/metadata.json")
actual="sha512-$(openssl dgst -sha512 -binary "$tmp/npm.tgz" | openssl base64 -A)"
test "$actual" = "$expected"
tar -xzf "$tmp/npm.tgz" -C "$tmp"
node "$tmp/package/bin/npm-cli.js" install -g npm@11.17.0
find "$HOME/.nvm/versions/node/v24.19.0/lib/node_modules/npm" -type f | wc -l
node "$HOME/.nvm/versions/node/v24.19.0/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js" --version
```

Expected immediately after this repair: 1,938 files and v12.4.0. Other npm versions have
different file counts. Verify the repair before archiving the base; a repaired snapshot
does not prove every subsequent lazy restore is complete. Do not work around this error
by installing an unrelated dependency or using an isolated npm copy for enrollment.

## Optional (used when present)

| What | Used for | If missing |
|---|---|---|
| Boot units `tailscale-rejoin`, `pi-boot-init`, `agents-update` (system units) | Boat sometimes doesn't start a fork's boot units; the plugin starts these if they're loaded but never started, and waits for `tailscale-rejoin` to finish before enrolling | Treated as absent; nothing waits for them |
| `/run/ascii-secrets/bws-providers.sh` | Extra provider keys (`KEY=value` / `export KEY=value`), merged into the agent env; re-applied when it appears later | Skipped |
| `/run/user/<uid>/agents-update.done` (one line, e.g. `<time> pi=ok codex=ok`) | Shown in the Boat page's Agents column; `waitForAgentUpdates` waits for it | Column shows "not seen" |
| `project-repos.service` + `/usr/local/bin/project-repos-sync.sh` | **Project runners** (several repos per machine). The plugin writes `~/.project-repos.txt` (`<name> <https-url>` per line) and starts the service; it then waits until every repo is at `~/workspace/repos/<name>` | Project runners fail with "missing repos"; everything else works. A reference sync script and unit are in [`runner/reference/`](runner/reference/) |
| git credentials for private repos (e.g. `GITHUB_TOKEN` + `gh auth setup-git`) | Cloning private repos on the box | Private clones fail |
| Its own bb server (`bb-app.service`, `/usr/local/sbin/bb-ensure.sh`) | Nothing: if the base runs a standalone bb server, the conversion turns it off on every runner and unpublishes it from the tailnet | Conversion skips those steps |

**Sharp edge (verified live 2026-10-09):** the base's `project-repos-sync.sh`
deletes any `~/workspace/repos/<name>` that is *not* named in
`~/.project-repos.txt` at boot ("removed foreign repo", `rm -rf`). If you add
a bb project source on the box whose checkout lives inside
`~/workspace/repos`, register it in the manifest first or place the checkout
outside that directory; otherwise the next boot silently removes it and
`bb thread spawn` fails with "This project checkout has no usable git branch".

Conversion verifies that the standalone server is unpublished. The Amp-orb test twice
failed that check with `bb-server-still-on-tailnet` after the server stopped; a later
identical Serve reset succeeded. **Mechanism confirmed by the 2026-10-09 pass run:** it
is a boot-publication race — settle waits only for `tailscale-rejoin`, but
`pi-boot-init` can still be running and calls `bb-ensure.sh`, whose
`tailscale serve --https=443 → 127.0.0.1:38886` republish lands between the
conversion's `serve off/reset` and its verify. `chmod -x` and the `sed -i`
marker guard cannot stop an already-running `bb-ensure.sh` instance (bash
keeps executing the old inode). Do not treat this check as passed merely
because `bb-app.service` is inactive.

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
