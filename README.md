# herdr-web

A standalone web console for a [herdr](https://herdr.dev) daemon: one Go
binary that serves the UI and bridges it to the herdr unix socket.

It is deliberately small and self-contained. It talks to nothing but the
herdr socket API, embeds the frontend it was built with, and has no runtime
dependencies beyond the binary itself.

```
make build          # frontend + binary -> ./herdr-web
./herdr-web         # http://127.0.0.1:18080
```

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
-addr           host:port to listen on            (default 127.0.0.1:18080)
-herdr-socket   daemon socket path                (default ~/.config/herdr/herdr.sock)
```

To expose it beyond loopback, put it behind whatever already fronts your
private network — the binary has no authentication of its own, and anyone who
can reach it can type into your panes.

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
