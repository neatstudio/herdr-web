# herdr-web

A standalone web console for a [herdr](https://herdr.dev) daemon: one Go
binary that serves the UI and bridges it to the herdr unix socket.

It is self-contained and embeds the frontend it was built with. The local
console bridges the herdr socket; optional fleet features also contact peer
consoles and release sources. There are no runtime dependencies beyond the
binary itself.

Current behaviour and API shapes: [Fetures.md](Fetures.md). Product scope and
acceptance criteria: [docs/SPECS.md](docs/SPECS.md) (product direction confirmed;
implementation and remaining choices documented there).
Security, performance and logic findings: [docs/review-2026-10-24.md](docs/review-2026-10-24.md).

```
make build          # frontend + binary -> ./herdr-web
./herdr-web         # Tailscale :5000 and loopback :5001
```

Those two ports are deliberate: they are the ones the retired `tmuxd`
control plane used, so existing Tailscale links and local bookmarks keep
working. `-addr ""` or `-local-addr ""` drops whichever listener you do not
want.

## Why a bridge

Browsers cannot open unix sockets, and herdr's daemon speaks newline-delimited
JSON-RPC over `~/.config/herdr/herdr.sock` — there is no HTTP listener to point
a web page at. So this project is a thin translator: HTTP in, herdr JSON-RPC
out. Pane and workspace state belongs to herdr; fleet membership, local job
events, dispatch history and an update-source preference are persisted by
herdr-web itself.

## What the console does

The window is three things: a sidebar, a transcript, and a prompt.

- **Sidebar, in two halves.** Workspaces on top, listed in herdr's own order
  with no status of their own — a workspace is a place you attach to. The
  agents underneath, ordered by what needs a human and coloured to say so
  (green working, amber blocked, grey idle, blue finished). Plain shells are
  not listed there; the pane tabs reach them.
- **Pane tabs, above the transcript**, one per herdr tab. A tab that herdr has
  split shows its panes as tiles side by side; below the phone breakpoint they
  stack instead, because two 60-column panes on a phone leave neither readable.
  Dragging a tile edge asks herdr to move the split: herdr owns the step size
  and clamps at its own minimum, so the edge lands where herdr puts it.
- **The prompt sends to the pane you clicked**, and the caret is already in it.
  `+` adds a tab in the open workspace and selects its root pane. `Enter` sends,
  `Tab` flushes the line and asks the shell
  to complete it, `↑`/`↓` walk the send history.
- **Attachments by path.** herdr can only send text, so a dropped, pasted or
  picked file is stored under the system temp directory and its absolute path
  goes into the prompt — which is how a CLI agent takes an image anyway.
- **Path previews.** A path printed in the output is a link; clicking it shows
  the image or the text in a side panel. A path that is not on this machine
  says so, because herdr can drive panes elsewhere over SSH.
- **Renaming.** Panes and workspaces are renamed from the same menu, on
  right-click or long press. Panes can be cleared back to their id; a
  workspace has no unnamed state, so an empty name is refused.
- **Two themes**, both first-class: `paper` (light) and `carbon` (dark), with
  `auto` following the OS. The choice is applied before first paint by an
  inline script, so there is no flash. A full-screen app that paints its own
  dark canvas is mirrored on paper rather than punching a dark hole, and a
  band of highlighted output is not mistaken for a canvas.

On a phone the sidebar becomes one menu with a switch between its two lists,
and the transcript reflows to the screen width.

## The composer

The box at the bottom of a pane is a composer, not a terminal. That has costs,
and the design leans on two things to pay them:

- **A line is typed, not pasted.** `pane.send_text` is a paste, and a TUI that
  reads pasted text literally opens no menus for it: measured against an agent
  TUI, `/model` pasted does nothing while the same characters typed open the
  model picker. Plain ASCII therefore goes out key by key; anything a key
  cannot carry — non-ASCII, a multi-line block — goes out as text.
- **Completion and slash commands hand the line over.** `Tab` types the line
  into the pane and presses Tab there, then gives the keyboard to the pane: the
  completion belongs to the shell's line editor, and keeping a second copy in
  the box would make Enter send the stale one. A line starting with `/` is typed
  the same way but *without* Enter, because an agent's slash command opens a menu
  for the rest of the line — an Enter here would pick the first entry before it
  was ever seen.
- **Ctrl+letter belongs to the terminal.** `Ctrl-C` interrupts, `Ctrl-D` ends
  input, `Ctrl-Z` suspends, `Ctrl-L` clears — typed in the composer, they go
  straight to the pane. With text selected they are left to the browser, because
  then `Ctrl-C` means copy.
- **Raw mode is one key away.** Press `Esc` and every key goes to the pane
  instead: Tab completes, arrows walk the shell's history, Ctrl-C interrupts, and
  a TUI's own menus are driven from there. A TUI's own mode switch is
  `Shift+Tab` (BackTab, `^[[Z` at the pane): it is forwarded here and from the
  composer, and the daemon takes it as `shift+tab`. `Shift+Esc` leaves raw
  mode — plain `Esc` is forwarded, because it is how a menu is cancelled and how
  insert mode is left, and taking it here made a slash command impossible to
  back out of.

Enter sends, Shift+Enter writes a newline, and the box wraps and grows, so a
long message is readable before it goes out.

### Wide panes

The transcript has four layouts. **auto** (the default) wraps ordinary output
and keeps a pane with its own full-screen canvas in exact mode; **wrap** reflows
text to the viewport; **exact** keeps one terminal row per line and scrolls
sideways; **fit** scales down to a 10px floor and then scrolls, showing the
column count. A full-screen TUI's box drawing cannot be reflowed without
breaking it, so rule and border lines are clipped to one row in wrap and fit,
and exact keeps them scrollable.

Absolute truecolor is pulled into a readable luma against the page — a bright
agent green becomes a dark green on paper — and a line with a full-width
background paints that background on the row itself, so a wrapped line does not
show seams between its rows.
herdr owns the pane's terminal width (`pane.read` has no width argument, and
`pane.resize` moves a split rather than setting columns), so a pane much wider
than the window is best read in exact mode; narrow the pane or split in herdr
if the TUI itself should reflow.

## herdr runs its own server, headless

`herdr` (the TUI) needs a terminal, but **`herdr server` does not**: it is a
headless daemon with its own socket, and it is what this console talks to.
Wrapping it in tmux, as this project first did, was one multiplexer hosting
another for no reason.

```
herdr server          # the daemon, no terminal needed
herdr status          # it answers once it is up
```

The installer registers it as `dev.herdr` when asked (`--herdr-service`), so a
server comes back after a reboot with both the console and its daemon running —
no tmux, no login.

An update is a two-step operation for older servers. `herdr update` installs
the new binary but will not kill the sessions running in the old server; for a
server from before endpoint generation 1 it asks you to stop it and run the
update again:

```
herdr server stop     # ends the panes in that server
herdr update          # finishes the swap
herdr server          # start the new server (the service does this for you)
```

The console notices the daemon going away and keeps showing the last state; it
reconnects on its own when herdr comes back, so there is no need to reload the
page. The status panel spells out which command is next when a daemon is
stopped or still on an older build.

## Running without herdr

The console does not need herdr to start: it serves the UI, reports that the
daemon is not reachable, and keeps the last state it saw. That last part
matters — herdr restarting is not herdr empty, so a failed poll holds the view
and an "herdr is not reachable" strip says why, instead of showing a console
with nothing in it.

Updating from the panel is a sequence, because one command is not enough on an
older server: the daemon is stopped first (an update on a server from before
endpoint generation 1 needs that final stop), then updated, then started again
as a headless `herdr server`. Without the last step the console would be left
talking to nothing — which is exactly what happened on a deployed host. A failed
update still ends with the daemon running, on the version that is still on disk.
The same panel can restart the daemon by itself.

The masthead's daemon state opens a panel with what herdr is on this machine:
the binary, its version and channel, whether the daemon is running, whether a
restart is pending, how it was installed, and the newest release. From there it
can install herdr when it is missing, or update it when a newer release exists.

Install and update run one fixed command on the host — `curl -fsSL
https://herdr.dev/install.sh | sh` and `herdr update`, or `brew upgrade herdr`
for a Homebrew copy. A Nix copy is deliberately not offered a button: `herdr
update` would fight the store. Nothing typed into the panel reaches a command.

## Routes

The original local bridge routes are listed below; the current fleet, job,
release and maintenance routes are indexed in [Fetures.md](Fetures.md).
Unknown `/api` paths return 404 rather than falling through to the UI shell.

| Method | Path | herdr call |
| --- | --- | --- |
| GET | `/api/health` | — (liveness only, no daemon needed) |
| GET | `/api/v1/herdr/status` | `ping` |
| GET | `/api/v1/herdr/workspaces` | `workspace.list` |
| GET | `/api/v1/herdr/workspaces/{id}` | `workspace.list` + `pane.list` |
| POST | `/api/v1/herdr/workspaces/{id}/rename` | `workspace.rename` |
| GET | `/api/v1/herdr/panes` | `pane.list` (every pane, one call) |
| GET | `/api/v1/herdr/panes/{id}/read?lines=&format=` | `pane.read` + `pane.get` |
| GET | `/api/v1/herdr/panes/{id}/layout` | `pane.layout` |
| POST | `/api/v1/herdr/panes/{id}/input` | `pane.send_text` |
| POST | `/api/v1/herdr/panes/{id}/keys` | `pane.send_keys` |
| POST | `/api/v1/herdr/panes/{id}/rename` | `pane.rename` (`null` clears) |
| POST | `/api/v1/herdr/panes/{id}/split` | `pane.split` |
| POST | `/api/v1/herdr/panes/{id}/close` | `pane.close` |
| POST | `/api/v1/herdr/panes/{id}/resize` | `pane.resize` |
| POST | `/api/v1/herdr/uploads` | — (stores one attachment) |
| GET | `/api/v1/herdr/file?path=` | — (metadata for one path) |
| GET | `/api/v1/herdr/file/raw?path=` | — (image bytes) |
| GET | `/api/v1/herdr/host/stat?path=` | — (is this path on this host) |
| GET | `/api/v1/herdr/host` | `herdr status --json` + the release feed |
| POST | `/api/v1/herdr/host/update` | — (runs `herdr update` / `brew upgrade herdr`) |
| POST | `/api/v1/herdr/host/install` | — (runs the official installer) |

`{id}` is URL-encoded; pane ids contain a colon (`w1:p1` → `w1%3Ap1`).

`pane.read` does not report agent status, so the read route enriches its
answer with one `pane.get`. That is the only route that makes two daemon
calls.

## Flags

```
-addr           Tailscale-facing listen address   (default: first Tailscale IPv4 on :5000)
-local-addr     loopback listen address           (default 127.0.0.1:5001)
-herdr-socket   daemon socket path                (default ~/.config/herdr/herdr.sock)
-herdr-bin      herdr binary to inspect, install and update
                (default: herdr on PATH, then ~/.local/bin/herdr)
```

Both listeners serve the same console. Pass `""` to skip one.

Only loopback, RFC1918, Tailscale CGNAT and IPv6 ULA addresses are accepted;
a wildcard or public bind is refused at startup.

**Without `HERDR_WEB_TOKEN` the console has no authentication.** Exposing it
means anyone who can reach the port can type into your panes, read files this
user can read, and close panes. Keep it on loopback or a private link. The file
endpoints are read-only and refuse anything that is not a regular file, and SVG
is never served as an image (it can carry script), but the console is as
powerful as a shell.

Set `HERDR_WEB_TOKEN` to require a bearer token on `/api/` and `/opendesign/`
requests from fleet peers, scripts, and curl. A same-origin browser is exempt by
default: the UI's fetch/EventSource/WebSocket already carries
`Sec-Fetch-Site: same-origin` or a matching Origin, so there is no per-console
`/auth` visit. The token still closes the cross-site, DNS-rebinding, and
unauthenticated-script paths; the remaining boundary is the private bind plus
the tailnet/LAN ACL. Set `HERDR_WEB_TOKEN_BROWSER=require` if you want the strict
per-origin login instead; then `/auth?token=...` sets the HttpOnly cookie as
before. `/api/health` and provider webhooks stay open (webhooks verify their own
HMAC). Fleet peers read the token for heartbeats, dispatch, and the remote proxy.
Set the same token on every console in a fleet; do not expose a console to the
public internet.

The browser boundary is checked separately: a request must address a host this
console answers on (the bound address, `localhost`, a single-label LAN name,
MagicDNS/`.local`, or a name in `HERDR_WEB_ALLOWED_HOSTS`), and browser
mutations must be same-origin and `application/json`. That keeps a visited page
or a DNS-rebinding name from driving the API; it does not authenticate a
tailnet peer that can reach the port directly. A reverse proxy that forwards a
different Host needs that name in `HERDR_WEB_ALLOWED_HOSTS`.

### Release and checkout boundaries

`/release/` serves release files publicly (an installer has to fetch them), but
writing it is disabled unless `HERDR_WEB_RELEASE_UPLOAD_TOKEN` is set. The upload
must present that token in `X-Herdr-Release-Token`; the console token is not
accepted for this. This is separate from `HERDR_WEB_TOKEN` on purpose: a token
that is forwarded to fleet peers must not also authorize publishing a binary.

A worktree job must use a branch and base branch matching
`[A-Za-z0-9][A-Za-z0-9._/-]*` with no `..`, `.lock`, or leading dash. A clone URL
must be `https`, `ssh`, or private `http`; `file:`, `ext::`, and credential-bearing
URLs are refused. New checkouts may only be created under
`HERDR_WEB_CHECKOUT_ROOTS` (default `~/.local/share/herdr-web/checkouts`) or the
registered repository's checkout. Existing git checkouts remain usable.
`HERDR_WEB_ALLOW_FILE_CLONE=1` is a deliberate test-only escape hatch for a local
bare mirror; never set it on a network-exposed console.

`tokenEnv` names are limited to `GITHUB_TOKEN`, `GITEA_TOKEN`, `GITLAB_TOKEN`, and
names listed in `HERDR_WEB_ALLOWED_TOKEN_ENVS`. `HERDR_WEB_TOKEN`,
`HERDR_WEB_NATS_TOKEN`, `AWS_*`, `PATH`, and `LD_PRELOAD` are always refused. A
repository provider URL must be `https` or private `http`.

### Fleet and ledger proof

Fleet hellos and peer rows carry an ed25519 signature over every field except
`Seen`. The node id is the public key, so an unsigned or forged peer is rejected.
`Seen` is stamped by the receiver, the hello path is capped at the same 64 peers
as the merge path, and repeated hellos throttle the fleet-file write.
`HERDR_WEB_TRUSTED_PEERS` optionally limits accepted peer public keys. Dispatch
targets must be this console, a known seed/peer, or loopback, and are capped at
16; release downloads and tailnet discovery never receive the console token.

Ledger `claim`, `heartbeat`, `release`, `cancel`, and `fail_merge` require an
ed25519 proof from the named node, in addition to the attestation signature. The
canonical bytes are:

```text
op \0 taskID \0 role \0 node \0 version \0 leaseSeconds \0 reason
```

signed with the node key and sent as base64url. The HTTP endpoints take the proof
in `signature`. A command job's completion marker now contains a per-job nonce;
an agent job is completed only by herdr's agent status, never by a string in its
output. A failed job is not attested as successful, and the first terminal status
is cached so a scrolled-out marker cannot flip a finished job back to running.
The dev attestation records the workspace HEAD commit, and the merge lock keys on
`Repo`/`CloneURL` before falling back to `Cwd`.

Markdown links are rendered only for `http:`, `https:`, and `mailto:`; other
schemes are shown as text.

## Files

Attachments are written to `herdr-web-uploads` under the system temp directory
(`$TMPDIR`, or `/tmp` on Linux) and are named so that the path needs no
quoting: no whitespace, no shell metacharacters, no separators. Because `/tmp`
is world-writable, the directory is checked before every write — it must not
be a symlink, must be a directory, must belong to this user, and is tightened
to `0700`. `HERDR_WEB_UPLOAD_DIR` overrides the location.

## Installing on a machine

One command installs the binary and registers the service, so the console comes
back after a reboot without anyone logging in:

```
curl -fsSL https://github.com/neatstudio/herdr-web/releases/latest/download/install.sh | sh
```

The binary is self-contained: the frontend is embedded, so nothing else is
downloaded and the target needs no Go, Node or network.

**When GitHub is out of reach** — a private network, a locked-down host — copy
the release binary over and install from the file instead:

```
sh install.sh --from ./herdr-web-linux-amd64
sh install.sh --url https://your-mirror/herdr-web-linux-amd64
```

The installer says this in its own error message, so a failed download is a
pointer to the offline path rather than a dead end. It also refuses to replace
a `dev.herdr-web` service that points somewhere else, so installing over a
machine that already runs the console from a checkout cannot silently steal the
service.

### Versions count to 99

A component counts to 99 and only then rolls over: small fixes bump the patch, a
batch of features bumps the minor, and the major moves only once the minor is
already at 99. `scripts/version.sh` does the arithmetic (`next patch|minor|major`,
`tag`), so the version creeps upward instead of leaping to 1.0 on a good
afternoon.

The binary reports the newest tag verbatim, never a git-describe count or hash:
`v0.6.14` stays `v0.6.14` across rebuilds. Releases are cut by tagging before a
build; two builds of the same tag are the same release and do not auto-update
over each other.

### A fleet with no centre

Several consoles can know each other: `--fleet-seeds http://hub:5000` is an entry
point, not an authority. Every console keeps its own list and exchanges it with
its seeds and a few known peers every 30 seconds, so the list survives the loss of
any machine. A console started with no seeds is an entry point: it discovers the
tailnet's consoles itself (`93a088d`), so it joins rather than standing alone.

The listener is the switch. A console with a Tailscale bind is a fleet member: it
discovers peers and may follow a newer build. A console with only loopback binds
is local-only: it does not run the heartbeat or probe the tailnet, but the
hourly updater still uses GitHub or `HERDR_WEB_RELEASE_SOURCE`. A
tailnet-facing console accessed through `127.0.0.1` is still the same fleet
member; for a truly local-only instance bind `-addr 127.0.0.1 -local-addr ''`.
A one-machine tailnet has no peer source: its update comes from GitHub, an
explicit source, or a seeded release.

A machine shared into another tailnet has two addresses: the interface it binds
(its own `100.64.x.x`) and the address peers use (the shared `100.89.x.x`). Set
`HERDR_WEB_ADVERTISE_ADDR=100.89.0.3:5000` and bind both listeners:

```sh
herdr-web -addr 100.64.0.8:5000 -local-addr 192.168.1.44:5000
```

The advertised address is what this console reports in fleet heartbeats, so a
peer does not keep dialing an address it cannot route. The Host guard also
accepts it automatically.

Every installed console checks for a newer build **45 seconds after start, then
hourly**. The check uses the remembered source, GitHub, and reachable consoles;
it adopts only a strictly newer, checksum-verified build, keeps
`herdr-web.previous`, and never replaces a checkout binary unless
`HERDR_WEB_AUTO_UPDATE=force`. A running job suppresses the restart (the check
may be skipped) so an agent turn is not dropped. After installing, the console
asks its service manager to restart, or `syscall.Exec`s itself when no supervisor
exists. Controls:

```text
HERDR_WEB_AUTO_UPDATE=off|force     disable, or allow a checkout binary
HERDR_WEB_AUTO_UPDATE_FIRST_DELAY=45s
HERDR_WEB_AUTO_UPDATE_INTERVAL=1h
GET  /api/v1/herdr-web/update/status
POST /api/v1/herdr-web/restart      restart onto the binary on disk
```

`HERDR_WEB_FLEET_FOLLOW=off` still disables the default updater (use
`HERDR_WEB_AUTO_UPDATE=on` to override on a machine that wants updates).
`POST /api/v1/herdr-web/rollback` puts back `herdr-web.previous`; restart after
it. Safe defaults: nothing is adopted that is not strictly newer, nothing that
fails its checksum, and a build that cannot name its version is refused.

Each hello also carries what a machine can offer a task: its agents, tools, declared
models (`HERDR_WEB_MODELS`), and its capacity (`running` out of `maxTasks`).
`HERDR_WEB_MAX_JOBS` is the operator's concurrency cap. Unset defaults to one,
because many fleet machines are 1C/1G and an agent plus its build is the resource
hog; set it explicitly to zero only when you mean no cap. At the cap the target
answers `429 at_capacity`, and the dispatch sheet shows the machine as full instead
of preselecting it. `GET /api/v1/herdr/jobs/ledger` returns that
machine's start/stop events. This is a capability and capacity registry, not a
chain: there is no global queue or consensus, and the claim is the task id plus
the offer/start gate. The ledger is an append-only JSONL file under
`~/.local/share/herdr-web/jobs`, and the dispatch board is `dispatch.json`; both
are loaded on restart, so the running count and the task board survive a console
restart (herdr keeps the workspaces).

The shared task ledger is the other cross-machine state. Wire it with
`HERDR_WEB_LEDGER_NATS` (one URL, or a comma-separated cluster list) and the same
`HERDR_WEB_NATS_TOKEN` on every console; `HERDR_WEB_NATS_REPLICAS` sets the
JetStream replica count (default: number of URLs, capped at three). For TLS use
`tls://` URLs and point `HERDR_WEB_NATS_CA` at the private CA; every address a
client uses must be in the server certificate's SAN list. Each console
signs its attestations with an ed25519 key at
`~/.local/share/herdr-web/jobs/node.key` (override with `HERDR_WEB_NODE_KEY`);
the node id is the public key, and the ledger rejects an unsigned, forged, or
replayed result. There is no anonymous write path.

A repo task carries its checkout URL, base branch, and test command. Before a
worktree job starts, the target clones the repository if the directory is
missing, or fetches the base branch and refuses to switch a dirty checkout. When
the dev job reports done, the console pushes its branch before attesting, so the
review/merge stages see a real remote head. A repo's `testCommand` makes the
test role a deterministic command job rather than an agent opinion. Review,
test, and audit leases must be taken by a node other than the developer; merge
failures retry up to three times and then become `merge_blocked` for a human
instead of looping forever.

Dispatch has two strategies. `fanout` (the default) runs the same prompt
independently on every selected machine. `single` offers the task to all selected
machines; a target declines if it lacks the agent or is at capacity, and the
freest accepting target runs it. A task id makes a retried start idempotent, and a
lost start response is checked against the target's task endpoint before another
machine is tried. A task that has already started is not silently re-run on
another machine if its host disappears: the row shows the loss, and retrying is an
operator decision.

#### Sending a task

1. Click **fleet** in the masthead (or the machine/status button, then "send a
   job to the fleet"). It is a full-screen page: the form is on the left and the
   task board on the right.
2. Fill the prompt, the repository (optional; a worktree is created per job), the
   branch (optional) and the agent.
3. Choose a **weight** — `light` (edits, no build), `standard`, or `heavy`
   (build/tests) — and **every machine** (fanout) or **one machine** (offer).
   The weight is a placement hint: a target declines when its free memory is
   below the floor, and the market ranks heavy work onto bigger machines and
   light work onto smaller free ones. It is not a sandbox; an agent can still
   start a build under a light task. Select the machines; this console is in the
   list too, so a one-machine fleet can run a task locally. A full machine or one
   without the agent is disabled.
4. Send. The task appears under "in flight" and polls every five seconds.

Each row shows the agent status, branch, commits, uncommitted files and the
`collect` fetch command. `stop` closes the workspace and discards its worktree;
`retry offer` re-offers a one-machine task that never started. A target must run
a console with the offer endpoint (the market build) for **one machine**; an older
console can still be used with **every machine**, which uses the plain start.

#### Projects and scale

The fleet registers agents, tools, declared models and capacity per **machine**,
not per project. A task carries a `cwd` and optional `branch`; the target must have
that repository at that path. Every task becomes a herdr workspace/worktree, and
the `HERDR_WEB_MAX_JOBS` cap is shared by all projects on that machine — there is no
per-project quota. The dispatching console keeps the last 20 tasks; each machine's
ledger is append-only. Many projects can run, but there is no project catalog,
global task board, per-project quota, or MCP adapter yet.

Weight is a declaration, not a measurement of what the agent will do. The floors
are: `light` 128 MiB free, `standard` 256 MiB, `heavy` 768 MiB and at least two
CPUs. They are checked when the offer is made and again when the job starts; an
unknown memory reading (a Mac) is not treated as zero. The agent runtime itself
is the baseline: a Node agent can sit around 200 MB before it does anything, so a
1C1G machine should run one light agent and no build; 2C2G is a realistic floor
for one heavy coding task.

Agent runtimes are not interchangeable on memory: `omp` is a native binary but
runs several processes (main, ACP and workers; a session can reach 300–500 MB),
while `pi` is a Node CLI like `opencode`. A no-build task still pays the agent
baseline. The console advertises the herdr-supported kinds found on its PATH;
launchd/systemd do not inherit a shell PATH, so a `pi` installed under Herd's nvm
needs a symlink into `~/.local/bin` or the unit's PATH. The HTTP API is small
enough to wrap in an MCP server later; the console itself is a REST bridge, not an
MCP server.

Scripted access uses the same API: `POST /api/v1/fleet/job` with
`{"prompt": "...", "kind": "claude", "cwd": "/repo", "branch": "job/name",
"strategy": "single", "targets": ["http://host:5000"]}`. `GET
/api/v1/fleet/jobs` on the dispatching console returns the board; the target's
`/api/v1/herdr/job/<workspace>` and `/job/<workspace>/diff` are the runner's own
status and result, and `/api/v1/herdr/jobs/ledger` is its local event log.

### When a host can reach nothing

Three paths, and the tooling tries them in this order rather than stopping at the
first one that does not work:

1. **Pull** — `--via <source>`: the target fetches the release itself. Fast, and
   the only one that scales, because the bytes travel between datacentres.
2. **Push** — automatic when the pull fails: the same binary goes over the ssh
   connection instead, by `rsync -az --partial` when both ends have it (only the
   difference is sent, and an interrupted transfer resumes) or as a compressed
   stream otherwise. This is what moves a machine that has no route out at all.
3. **Seed** — for a segment where no machine can reach anything: one reachable
   host stores the files and serves its neighbours.

   ```
   curl -X POST --data-binary @herdr-web-linux-amd64 \
        http://the-reachable-host:5000/release/herdr-web-linux-amd64
   ```

   The checksum is computed from what arrived, so what it serves later is exactly
   what was uploaded, and every machine in that segment installs from it with
   `--url http://the-reachable-host:5000/release`.

The reason this matters: a machine shared into a tailnet one way can be reached
but cannot reach back, so it can never fetch a release. Pushing works; pulling
does not. Measured on such a host, `herdr` (30 MiB) moved as ~10 MiB compressed
and took about fifty minutes — the fallback exists so that this is a slow path
rather than a dead end.

### Installing without GitHub

A running console is also a release source: it serves the installer it was
installed with, and the binary it is running.

```
curl -fsSL http://a-reachable-host:5000/release/install.sh | sh -s -- --url http://a-reachable-host:5000/release
```

It serves its own platform by itself. For a mixed fleet, put the other builds
where it reads them, and it serves those too:

```
make release-publish     # copies dist/release/* into ~/.local/share/herdr-web/releases
```

That is the whole fallback: one machine that can reach GitHub (or that has the
archives) becomes the source for every machine that cannot, and the files never
have to be copied by hand.

### Deploying to other machines

`scripts/deploy-remote.sh` copies the binary to hosts that are already reachable
by `ssh`, and registers the service there. Targets are `host` or `host:path`
names — an entry in `~/.ssh/config`, or a Tailscale/MagicDNS name. It does not
talk to the Tailscale API: a machine is a target because `ssh` already works on
it.

```
./scripts/deploy-remote.sh --list                 # ssh config hosts + tailnet peers
./scripts/deploy-remote.sh nas                    # install and register there
./scripts/deploy-remote.sh --dry-run desktop-7    # say what it would do
make deploy-remote TARGETS="nas desktop-7"
```

Two options exist because copying megabytes from a laptop to every machine over a
home link is slow:

```
# every target is reached through a jump host
./scripts/deploy-remote.sh --jump bastion nas desktop-7

# install from a reachable release source: one host holds the bytes, each
# target pulls them over the private link instead of receiving them from here
./scripts/deploy-remote.sh --via http://bastion:5000/release nas desktop-7
```

Each target gets the same guard the installer applies: a service pointing at
another path is left alone instead of being silently replaced.

## Running as a service

The service is registered by the installer, or by hand on a checkout:

```
make install-service     # launchd on macOS, a systemd user unit on Linux
make service-status
make uninstall-service
```

It comes back after a reboot: launchd runs it at load (`RunAtLoad`), and the
systemd user unit is enabled plus `loginctl enable-linger`, which is what makes
a user unit start at boot rather than at login.

The unit logs to `~/.local/share/herdr-web/herdr-web.log`. It runs the binary
from this directory, so rebuild before restarting:

```
make build && make service-restart
```

## Layout

```
main.go              entry point: flags, embed, shutdown
server/bridge.go     the routes and their JSON shapes
server/netaddr.go    which binds are allowed
server/uploads.go    attachment storage
server/file.go       read-only file metadata and image bytes
server/host.go       is a path on this machine
server/herdrhost.go  what herdr is here, and installing or updating it
server/static.go     embedded SPA, cache headers, 404 for missing assets
server/herdr.go      herdr JSON-RPC client over the unix socket
web/src/lib/         DOM-free logic: ANSI renderer, layout, paths, focus
web/src/components/  the shell: sidebar, tabs, tiles, viewer, prompt
web/                 Vite + React + TypeScript frontend
```

## Development

```
make build          # frontend + binary
make web            # frontend only
make go-build       # compile with the current web/dist embedded
make run            # run from source on :18080
make test           # Go tests + frontend unit tests
make e2e            # browser tests against a mocked bridge
make fmt vet clean
```

Frontend dev with hot reload, proxying `/api` to a running bridge:

```
cd web && VITE_BACKEND_URL=http://127.0.0.1:18080 npm run dev
```

`web/dist` is not committed; `web/dist/.gitkeep` keeps the `go:embed` pattern
valid before the first build. The binary reports a clear error for the UI if
it was built without a bundle, and the API still serves.

### Tests

- `server/*_test.go` run against an in-process fake herdr socket, so they
  assert the exact JSON-RPC the bridge emits.
- `web/src/lib/*.test.ts` are DOM-free unit suites (node:test), run by
  `make test-web`. The script globs every suite, so a new one is never
  silently skipped.
- `web/tests/app.spec.ts` drives the real UI in Chrome with the bridge mocked
  at the HTTP boundary: the sidebar, tabs and split tiles, the prompt and its
  focus rules, the pane menu, renames, attachments, previews, themes and the
  phone layout.

Nothing in the tests depends on the wall clock, and no test touches a real
herdr session: anything that would mutate panes is either mocked or run
against a throwaway `herdr --session`.

### A fleet, with a bastion

The pattern that works over a slow link: install once on the bastion, then let it
be the release source, so the megabytes travel datacentre to datacentre instead
of from the laptop.

```
# 1. bastion: copy the build over once and install it there
scp dist/release/herdr-web-linux-amd64 root@bastion:/root/
ssh root@bastion 'sh -s -- --from /root/herdr-web-linux-amd64' < install.sh

# 2. everywhere else: install from the bastion, through the bastion
./scripts/deploy-remote.sh \
  --jump root@bastion \
  --via http://bastion-tailscale-ip:5000/release \
  root@100.89.0.4 root@100.89.0.11 root@100.89.0.2 root@100.89.0.200
```

On a server reached as root the installer writes a system unit
(`/etc/systemd/system/dev.herdr-web.service`), because a user unit there needs a
lingering session to exist at all; anyone else gets a user unit.

That recipe is what installed this fleet: five hosts, every one of them pulling
the same build from one bastion and coming up `active` and `enabled`.

### Updating this console

The host panel's `update console` button replaces the running binary. Which
source it comes from is the console's own judgement, in this order: the source
that worked last time, GitHub, and the consoles it can reach on the tailnet —
each is probed as a release source, and the first one that answers wins. That is
how a host behind a link that drops GitHub's download updates itself: it pays for
one slow attempt, uses a peer, and remembers it. The panel says which source was
used.

A source also has to publish a **version**, and it must be newer: a differing
hash alone is not an update, and comparing hashes once replaced a working build
with an older release. Two untagged builds of the same base tag are ordered by
their commit count (`v0.2.0-22-g...` is newer than `v0.2.0-17-g...`), which is
what lets a fleet that never tags update itself from a peer. A source that cannot
say what it publishes is not used, and every download is checked against the
published checksum. `--from` (or
`HERDR_WEB_RELEASE_SOURCE`) still overrides the search when a source must be
pinned.

The new file is in place when the request returns; the process that answered is
still the old build, so the panel prints the command that starts the new one
(`make service-restart`, or the platform's own unit command).

## Releasing

`make release-archives` cross-compiles the four supported platforms into
`dist/release` with a `.sha256` beside each one. Pushing a `v*` tag runs
`.github/workflows/release.yml`, which builds the frontend, builds every
platform, runs the tests, publishes the tag and attaches `install.sh` — which is
the URL the curl line above points at.

## Requirements

Go 1.24+ and Node 24+ to build. At runtime, herdr is optional: without it the
console still serves, and offers to install it.
