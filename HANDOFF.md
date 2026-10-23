# Handoff — herdr-web

Written 2026-10-22 at `v0.6.7`, updated at `v0.6.10`. Two people are picking work up from here; the split
is at the bottom. Read the two sections above it first: the contracts are not
negotiable without a decision, and the pitfalls have each cost a debugging session
already.

## What this is

A standalone console for a herdr daemon: Go server, Vite + React Web client embedded
into the same binary with `go:embed`. Public repository:
<https://github.com/neatstudio/herdr-web>. One binary runs on every machine, serves a
private-address-only Web UI, and speaks to the local `herdr` daemon over its unix
socket.

The product idea: herdr gives you agent workspaces on one machine; this console makes
several machines feel like one — a fleet that knows itself, updates itself, and takes
a task to whichever machine can run it.

## Current state

| Thing | Value |
| --- | --- |
| Version | `v0.6.10` (`git describe`), tag pushed |
| Tests | `go test ./...` green; `npm --prefix web run test:unit` 102/102; Playwright 72/72 |
| Fleet | see below, all `v0.6.10` |
| herdr on the fleet | 0.9.5 everywhere; **tw1's daemon is currently stopped** |

Fleet as the hub reports it (`http://100.89.0.206:5000/api/v1/fleet`):

| Addr | Role | Agents installed | Notes |
| --- | --- | --- | --- |
| `100.89.0.206` | hub / seed | — | Singapore. only machine with reliable GitHub access (via the laptop pushing) |
| `100.89.0.4` | member | codex | tw1, herdr 0.9.5, **daemon stopped** |
| `100.89.0.11` | member | claude | cc1 |
| `100.89.0.2` | member | claude | vn |
| `100.89.0.200` | member | — | vn200 |
| `100.89.0.9` | member | — | m9, also the jump host for others |
| `100.89.0.10` | **not in fleet** | — | qlight-hk cannot reach the seeds; needs one it can reach |
| `100.89.0.3` | offline | — | m8s / home-m8; when it returns it needs a **push** (see below) |

The laptop (`100.89.0.116`) runs its own console as a development instance: no seeds,
so it is an entry point of one. It uses a launchd user agent, not a herdr service.

## Working in it

```sh
make go-build                 # build web + go, embed, produce ./herdr-web
make release-archives         # dist/release/* for both arches + .sha256
make go-test                  # go test ./...
npm --prefix web run test:unit
cd web && npx playwright test # 72 browser tests; starts its own vite dev server
./scripts/install-service.sh restart   # this machine's launchd unit
sh scripts/version.sh next patch       # version arithmetic (components count to 99)
sh scripts/version.sh tag patch        # annotated tag
```

Deploy:

```sh
# the hub is the release source: push to it first, followers pull on their own
scp -i ~/.ssh/server-zeabur dist/release/herdr-web-linux-amd64{,.sha256} install.sh \
    root@43.153.207.224:/root/hw-dist/
ssh -i ~/.ssh/server-zeabur root@43.153.207.224 \
    'cd /root/hw-dist && sh install.sh --from ./herdr-web-linux-amd64'

# a member that can reach the hub (either --via pull, or push when it cannot)
./scripts/deploy-remote.sh --jump root@43.153.207.224 \
    --identity ~/.ssh/server-zeabur --via http://100.89.0.206:5000/release \
    --fleet-seeds http://100.89.0.206:5000 root@100.89.0.11

# a member that cannot reach anything (m8s): push, compressed, resumable
./scripts/deploy-remote.sh --identity ~/.ssh/id_boot2docker gouki@100.89.0.3
```

Conventions: Conventional Commits (`feat:`, `fix:`, `test:`, `chore:`), stage files
explicitly, no secrets in the tree, UTF-8/LF. Version policy: **a component counts to
99 and only then rolls over**, so `0.6.x` for a long while and `1.0` only after
`0.99` — use `scripts/version.sh`, never hand-edit a tag.

## Architecture, by file

Server (`package server`):

| File | Responsibility |
| --- | --- |
| `server/bridge.go` | HTTP routes, JSON over the herdr unix socket, host/pane/workspace endpoints |
| `server/release.go` | `/release/*` serving and `POST` seeding; serves the console binary, `herdr-<os>-<arch>`, `install.sh`, `version` |
| `server/selfupdate.go` | the console updating itself: version gate, checksum, atomic replace, `.previous` |
| `server/selfsource.go` | which sources to try, remembered source, version comparison (`selfNewer`) |
| `server/fleet.go` | peer list exchanged pairwise (no leader), heartbeat, follow-the-newest-build loop |
| `server/jobs.go` | a job on this machine: workspace/worktree + agent start + prompt + status |
| `server/fleetjob.go` | dispatch one prompt to several consoles; status is asked of the machine running it |
| `server/herdrhost.go` | herdr install/update/restart on this host, headless `herdr server` under the service manager |
| `server/run.go` | listeners, shutdown, start of the background loops |

Client: `web/src/App.tsx` (state and polling), `components/` (Masthead, Sidebar,
PaneTabs, Scope, PromptBar, HerdrPanel, NewWorkspace, DispatchSheet, TargetMenu),
`lib/` (herdr API client, fleet, ansi rendering, theme, paths).

Scripts: `install.sh` (installer, writes the unit), `scripts/deploy-remote.sh` (push
or pull deploy, fallback to push), `scripts/version.sh` (version arithmetic),
`Makefile` (entry points above).

## Contracts that must not break

1. **Private addresses only.** The server refuses a wildcard bind; there is no
   authentication of its own. Do not add a public listener, and do not put secrets in
   the fleet bus (it is tailnet-only by construction).
2. **An update is a strictly newer build with a matching checksum.** Not "a different
   hash". A downgrade once replaced a working build; `selfNewer` is the fix.
3. **The replaced build is kept** as `herdr-web.previous`; `POST
   /api/v1/herdr-web/rollback` puts it back. Keep both.
4. **A job's state lives on the machine running it.** The dispatching console only
   remembers what it sent. Do not move job state into the dispatcher.
5. **Nothing restarts the operator's herdr daemon unasked.** Pane loss is data loss.
   The stop → update → start sequence is explicit and confirmed in the UI.
6. **tmux is legacy compatibility, not a feature.** It appears folded away, and only
   when sessions exist. Reading a session uses `capture-pane` (no client, no resize);
   attaching is a deliberate takeover with `-d`.

## Pitfalls, each of which already cost a session

1. **launchd/systemd do not inherit `PATH`.** Always pass absolute paths; this has
   caused outages.
2. **Root gets a system unit, a user gets `--user` + `loginctl enable-linger`.** A
   user unit under root sits in `activating`; a restart aimed at the wrong manager
   fails silently while the file on disk is already new.
3. **`systemctl enable --now` does not restart a running unit.** Always `restart`.
4. **herdr's daemon idle-exits after ~44 minutes.** Units need `Restart=always`.
5. **Release asset prefixes:** `herdr-web-*` also starts with `herdr-`. Order the
   checks so the console's own assets are not swallowed.
6. **Updates need a `version` file from the source** (`/release/version`). GitHub
   releases publish one; a peer serves it automatically.
7. **Playwright** runs against a vite dev server: an `<img>` preview needs a real
   (tiny) PNG mocked, otherwise it fires `onError` and disappears mid-assertion.
8. **herdr keys** are validated as a batch; `space` is `"space"`, not `" "`.
9. **tmux `attach` resizes the session** to the newest client. Use `capture-pane` to
   look, `attach -d` to take over.
10. **A tailnet clock can be off by more than the heartbeat interval**; never settle a
    conflict by timestamp alone when a build number is available.
11. **systemd gives a system service no `HOME`.** `DefaultSocketPath` fell back to
    the relative `herdr.sock` and the console reported a missing daemon. Resolve the
    account's home from `/etc/passwd`, and put `Environment=HOME=` in the unit.
12. **A form does not expand `~`.** herdr takes a directory literally, so a workspace
    made with `~` in the field failed; the server expands a leading `~` (its own user
    only) and the dialog shows the daemon's own error text.

## Open work

### Owner A — the agent that wrote this file

**A1. DONE (`v0.6.8`) — `+` adds a tab.** `POST /api/v1/herdr/tabs` wraps
`tab.create`; `newTab()` in `App.tsx` adds the tab and selects its root pane;
splitting stays on the pane menu. Verified on `100.89.0.200`:
`POST /api/v1/herdr/tabs {"workspaceId":"w1"}` → `{tabId:"w1:t2", paneId:"w1:p2"}`, and
`herdr tab close w1:t2` cleaned up.

**A2. DONE (`v0.6.9`/`v0.6.10`) — the work comes back.** `GET
/api/v1/herdr/job/<workspaceId>/diff` reads herdr's worktree for that workspace
(`workspace.get` → `worktree.checkout_path`) and reports branch, the last ten commits
and the uncommitted files; the dispatcher asks each target for it, and the panel shows
"2 commits on job/audit" and "1 uncommitted" per machine. Still open: a one-click
`git fetch` hint per machine (do **not** merge into the operator's repository from a
button).

**A3. Cancel.** `POST /api/v1/herdr/job/<workspaceId>/stop` exists and is untested
from the UI. Wire it into the dispatch panel per job, with the workspace id.
Acceptance: the button asks first, the workspace disappears from the target, and the
panel row says it was stopped rather than showing a stale status.

### Owner B — the other engineer

**B0. The hub's sshd is down (found `v0.6.8`).** `43.153.207.224` answers ping and
serves `:5000`, but `:22` is refused — the machine is fine, sshd is not. The console
kept working and even updated itself from a peer and restarted through systemd with
no login at all, which is the design working; the host still needs its sshd back
(`systemctl status sshd` on the console's own pane, or out-of-band access).


**B1. `100.89.0.10` is not in the fleet.** It cannot reach the seeds, so it neither
reports nor follows. Give it a seed it can reach (it can reach the laptop and this
consoles' peers in its own segment) or accept it is standalone. Verify with
`curl http://100.89.0.10:5000/api/v1/fleet` → `follow: true`, and that the hub lists
it within a minute.

**B2. m8s (`100.89.0.3`) when it comes back.** It is on `v0.6.x`? It was on a build
from before the fleet existed. Push, do not pull:
`./scripts/deploy-remote.sh --identity ~/.ssh/id_boot2docker gouki@100.89.0.3`.
The transfer is ~8 MB over a DERP relay (about ten minutes); the script compresses
and resumes. Confirm both `dev.herdr` and `dev.herdr-web` are `active` and
`enabled`, and `loginctl show-user gouki -p Linger` says yes.

**B3. Mobile is second-class.** On a phone (`max-width: 900px`) the sidebar is
hidden; workspaces are reachable only through the picker sheet. Verify on a real
iOS Safari: workspace switching, the prompt bar, the layout switch (`wrap/exact/fit`
are a 44px segmented control since `v0.6.6`), and the host panel. Fix what is
cramped; keep tap targets ≥ 44 px.

**B4. Legacy tmux: sending input without attaching.** `tmux send-keys -t <session>`
needs no client and does not resize anything, which is the safe way to answer a
prompt in a session that has live work in it. The read-only view already exists
(`GET /api/v1/herdr/tmux/output?session=&lines=`); the input box is the missing half.
The session name must be validated against `tmux list-sessions` before use.

**B5. License and release hygiene.** The public repository has no `LICENSE`. Decide,
add it, and check the GitHub release workflow still publishes four platform assets
plus `version` (`.github/workflows/release.yml`).

**B6. Unify herdr.** All hosts report 0.9.5, but tw1's daemon is **stopped** while
its binary is installed — that is a support question before it is a bug: check
`journalctl --user -u dev.herdr` (or the system unit) on `100.89.0.4`.

## Verification before shipping anything

```sh
go vet ./... && go test ./...
npm --prefix web run test:unit
cd web && npx playwright test
make go-build && ./herdr-web -version
# deploy to the hub, then confirm the fleet converges without touching members:
curl -s http://100.89.0.206:5000/api/v1/fleet | jq '.peers[] | [.addr, .version]'
```
