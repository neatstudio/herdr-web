# A three-node NATS ledger

The shared task ledger is only as durable as its NATS JetStream cluster. This is
the layout used by the current fleet: one server per machine, a private CA, a
shared client token, and JetStream replicas set to three.

## Topology

| node | client | cluster |
| --- | --- | --- |
| `m9` | `tls://127.0.0.1:4222`, `tls://192.168.31.62:4222` | routes to `m8s` |
| `m8s` | `tls://127.0.0.1:4222`, `tls://192.168.31.46:4222` | route to `m9` |
| `laptop` | `nats://127.0.0.1:4222` (loopback only) | routes to `m9` and `m8s` |

The laptop's client listener is plain only on loopback because the macOS Go
client's platform verifier rejects a private CA as "not standards compliant";
its cluster listener and both remote routes still use TLS. Linux clients verify
the private CA normally. A host that reaches the cluster entirely through TLS
should use only `tls://` client URLs.

Routes are deliberately asymmetric where a host cannot dial the other direction:
the machine that can reach the peer starts the route. NATS deduplicates the
opposite connection if both sides configure it; `no_advertise: true` keeps the
route list explicit.

## Certificates

Generate one CA and one leaf per node. The leaf needs `serverAuth` and
`clientAuth`, a critical `basicConstraints=CA:FALSE`, a critical `keyUsage`, and
every name/IP a peer uses in `subjectAltName`. Without those extensions Go on
macOS reports `x509: certificate is not standards compliant`.

```sh
openssl genrsa -out ca.key 4096
openssl req -x509 -new -nodes -key ca.key -sha256 -days 3650 \
  -subj '/CN=herdr-nats-ca' -out ca.crt
# per node: node.key, node.csr, node.ext
openssl x509 -req -in node.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out node.crt -days 3650 -sha256 -extfile node.ext
```

Put `ca.crt`, `node.crt`, and `node.key` in `~/.config/nats/` with mode 0600 on
the key. The console reads the CA from `HERDR_WEB_NATS_CA`.

## Server configuration

Client auth is a token; cluster auth is a separate user/password. Both travel
inside TLS.

```conf
server_name: m9
listen: 0.0.0.0:4222
http: 127.0.0.1:8222
authorization { token: "<client-token>" }
tls {
  cert_file: "/home/gouki/.config/nats/m9.crt"
  key_file:  "/home/gouki/.config/nats/m9.key"
  ca_file:   "/home/gouki/.config/nats/ca.crt"
  verify: false
}
jetstream {
  store_dir: "/home/gouki/.local/share/nats"
  max_mem_store: 1GB
  max_file_store: 20GB
}
cluster {
  name: herdr
  listen: 0.0.0.0:6222
  no_advertise: true
  authorization { user: "route"; password: "<route-token>" }
  tls {
    cert_file: "/home/gouki/.config/nats/m9.crt"
    key_file:  "/home/gouki/.config/nats/m9.key"
    ca_file:   "/home/gouki/.config/nats/ca.crt"
    verify: false
  }
  routes = [
    tls://route:<route-token>@192.168.31.62:6222
  ]
}
```

Run it under the user's service manager (`~/.config/systemd/user/nats-server.service`
on Linux; a LaunchAgent on macOS) with `Restart=always`. Only bind the monitoring
port to loopback.

## Console environment

```sh
HERDR_WEB_LEDGER_NATS=tls://127.0.0.1:4222,tls://192.168.31.62:4222
HERDR_WEB_NATS_TOKEN=<client-token>
HERDR_WEB_NATS_REPLICAS=3
HERDR_WEB_NATS_CA=/home/gouki/.config/nats/ca.crt
HERDR_WEB_TOKEN=<console-api-token>
```

The console retries JetStream stream/KV creation for 90 seconds while a new
cluster elects a metadata leader, so a service restart during cluster startup
does not turn into a crash loop.

## Verify

```sh
curl -s http://127.0.0.1:8222/routez | jq '.num_routes'
openssl s_client -connect 192.168.31.46:4222 -CAfile ~/.config/nats/ca.crt -servername m9 </dev/null | grep 'Verify return code'
curl -s -H "Authorization: Bearer $HERDR_WEB_TOKEN" \
  http://100.89.0.9:5000/api/v1/ledger/tasks
```

A task created through one console must appear in the other consoles' list; the
smoke command used in this deployment does exactly that and cancels the task
afterward.
