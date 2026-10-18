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

## Routes

Everything the UI needs, and nothing else. The set is closed: an unknown
`/api` path returns 404 rather than falling through to the UI shell.

| Method | Path | herdr call |
| --- | --- | --- |
| GET | `/api/health` | — (liveness only, no daemon needed) |
| GET | `/api/v1/herdr/status` | `ping` |
| GET | `/api/v1/herdr/workspaces` | `workspace.list` |
| GET | `/api/v1/herdr/workspaces/{id}` | `workspace.list` + `pane.list` |
| GET | `/api/v1/herdr/panes/{id}/read?lines=&format=` | `pane.read` + `pane.get` |
| POST | `/api/v1/herdr/panes/{id}/input` | `pane.send_text` |
| POST | `/api/v1/herdr/panes/{id}/keys` | `pane.send_keys` |

`{id}` is URL-encoded; pane ids contain a colon (`w1:p1` → `w1%3Ap1`).

`pane.read` does not report agent status, so the read route enriches its
answer with one `pane.get`. That is the only route that makes two daemon
calls.

## Flags

```
-addr           Tailscale-facing listen address   (default: first Tailscale IPv4 on :5000)
-local-addr     loopback listen address           (default 127.0.0.1:5001)
-herdr-socket   daemon socket path                (default ~/.config/herdr/herdr.sock)
```

Both listeners serve the same console. Pass `""` to skip one.

Only loopback, RFC1918, Tailscale CGNAT and IPv6 ULA addresses are accepted;
a wildcard or public bind is refused at startup. This binary has no
authentication, so exposing it means anyone who can reach the port can type
into your panes.

## Running as a service (macOS)

```
make install-service     # launchd unit dev.herdr-web, starts at login
make service-status
make uninstall-service
```

The unit logs to `~/.local/share/herdr-web/herdr-web.log`. It runs the binary
from this directory, so rebuild before restarting:

```
make build && make service-restart
```

This console replaces the retired `tmuxd` control plane on this machine: that
launchd unit is unloaded and its plist renamed to `*.plist.disabled-*`, so a
reboot cannot make it fight for ports 5000/5001. To bring it back, rename the
plist and `launchctl bootstrap gui/$(id -u) <plist>` after unloading this one.


## Layout

```
main.go              entry point: flags, embed, shutdown
server/bridge.go     the seven routes and their JSON shapes
server/static.go     embedded SPA, cache headers, 404 for missing assets
server/herdr.go      herdr JSON-RPC client over the unix socket
web/                 Vite + React + TypeScript frontend
```

## Development

```
make web            # build the frontend into web/dist
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
- `web/src/lib/*.test.ts` are DOM-free unit suites (node:test).
- `web/tests/*.spec.ts` drive the real UI in Chrome with the bridge mocked at
  the HTTP boundary. They cover grouping, polling, the prompt, Tab completion,
  the pane menu and theme switching.

## UI notes

Two themes, both first-class: `paper` (light) and `carbon` (dark), with an
`auto` setting that follows the OS. The choice is applied before first paint
by an inline script, so there is no flash.

Right-click a pane id — in the tab strip or the header — for the pane menu.
It is bound to those elements only, so a right-click on the output does
nothing and a nested surface cannot trigger it twice.

The herdr API has no pane-kill or workspace-delete, so the menu does not
pretend to offer them.
