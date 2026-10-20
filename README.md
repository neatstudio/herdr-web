# herdr-web

A standalone web console for a [herdr](https://herdr.dev) daemon: one Go
binary that serves the UI and bridges it to the herdr unix socket.

It is deliberately small and self-contained. It talks to nothing but the
herdr socket API, embeds the frontend it was built with, and has no runtime
dependencies beyond the binary itself.

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
out. Nothing is stored, nothing is cached, and no state lives here that is not
in herdr.

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
  `+` splits the open pane (right on a wide window, down on a phone) and
  selects the new one. `Enter` sends, `Tab` flushes the line and asks the shell
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
- **Raw mode is one key away.** Press `Esc` in the composer and every key goes
  to the pane instead: Tab completes, arrows walk the shell's history, Ctrl-C
  interrupts, and a TUI's own menus appear. Those belong to the pane's line
  editor and a text box cannot stand in for them; `Esc` again leaves raw mode.

Enter sends, Shift+Enter writes a newline, and the box wraps and grows, so a
long message is readable before it goes out.

## herdr must be running, and it needs a terminal

This console talks to a herdr daemon; it cannot start one. herdr is a TUI
application, so its session starts from a terminal and the daemon lives inside
it — `herdr` cannot be started by a service unit of its own, and running it with
no tty reports `cannot attach without a usable terminal`.

On a server that means starting it inside a terminal multiplexer:

```
tmux new-session -d -s herdr -x 200 -y 50 'herdr'   # start
tmux attach -t herdr                                 # look at it
```

An update is a two-step operation for older servers. `herdr update` installs
the new binary but will not kill the sessions running in the old server; for a
server from before endpoint generation 1 it asks you to stop it and run the
update again:

```
herdr server stop     # ends the panes in that server
herdr update          # finishes the swap
tmux new-session -d -s herdr -x 200 -y 50 'herdr'   # start the new server
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
in a detached tmux session. Without the last step the console would be left
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

Everything the UI needs, and nothing else. The set is closed: an unknown
`/api` path returns 404 rather than falling through to the UI shell.

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

**This binary has no authentication.** Exposing it means anyone who can reach
the port can type into your panes, read files this user can read, and close
panes. Keep it on loopback or a private link. The file endpoints are read-only
and refuse anything that is not a regular file, and SVG is never served as an
image (it can carry script), but the console is as powerful as a shell.

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

## Releasing

`make release-archives` cross-compiles the four supported platforms into
`dist/release` with a `.sha256` beside each one. Pushing a `v*` tag runs
`.github/workflows/release.yml`, which builds the frontend, builds every
platform, runs the tests, publishes the tag and attaches `install.sh` — which is
the URL the curl line above points at.

## Requirements

Go 1.24+ and Node 24+ to build. At runtime, herdr is optional: without it the
console still serves, and offers to install it.
