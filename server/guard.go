package server

import (
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
)

// allowedHostsEnv names extra Host values this console accepts, comma separated.
// It exists for a reverse proxy or a stable DNS name; the listener addresses and
// common tailnet/local names are accepted without it.
const allowedHostsEnv = "HERDR_WEB_ALLOWED_HOSTS"

// requestGuard closes the browser boundary of a console that deliberately has no
// authentication of its own.
//
// The private-bind check (netaddr.go) protects against a listener on a public
// interface. It does not protect against a browser: any page can send a
// "simple" cross-origin POST (text/plain, no preflight) to a reachable private
// address, and DNS rebinding can turn a public name into a private address for
// reads. Three checks make that surface useless:
//
//   - Host must be an address this console listens on, a loopback/local name, or
//     a name explicitly allowed by HERDR_WEB_ALLOWED_HOSTS. Rebinding presents
//     the attacker's own domain as Host, which is refused.
//   - A mutation (anything but GET/HEAD/OPTIONS) with a browser Origin or
//     Sec-Fetch-Site must be same-origin. Cross-site and same-site are refused.
//   - A JSON API mutation with a body must say application/json. A form or a
//     text/plain fetch cannot, and a cross-origin JSON request would need a
//     preflight this server never answers.
//
// Requests without browser headers (the fleet peers, install/deploy scripts,
// curl) keep working: they are the trusted side of the tailnet contract. Adding
// a token or a chain of trust is a separate decision, not something this guard
// pretends to solve.
type requestGuard struct {
	exact map[string]bool // listener IP (or explicit host:port), lower-cased
	names map[string]bool // explicit or common local DNS names
}

// GuardRequests wraps the console handler with the browser-boundary checks.
func GuardRequests(next http.Handler, listeners []net.Listener) http.Handler {
	guard := newRequestGuard(listeners, os.Getenv(allowedHostsEnv))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !guard.hostAllowed(r.Host) {
			writeError(w, http.StatusForbidden, "forbidden_host",
				"this console does not answer to that host")
			return
		}
		if isMutation(r.Method) {
			if !guard.sameOrigin(r) {
				writeError(w, http.StatusForbidden, "cross_origin",
					"cross-origin changes are refused")
				return
			}
			if needsJSONContentType(r) {
				writeError(w, http.StatusUnsupportedMediaType, "unsupported_media_type",
					"JSON requests must use application/json")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func newRequestGuard(listeners []net.Listener, extraHosts string) *requestGuard {
	guard := &requestGuard{
		exact: map[string]bool{},
		names: map[string]bool{},
	}
	for _, listener := range listeners {
		if listener == nil {
			continue
		}
		address, ok := listener.Addr().(*net.TCPAddr)
		if !ok {
			continue
		}
		port := strconv.Itoa(address.Port)
		guard.exact[strings.ToLower(net.JoinHostPort(address.IP.String(), port))] = true
		if address.IP.IsLoopback() {
			guard.exact["localhost:"+port] = true
			guard.exact[strings.ToLower(net.JoinHostPort("::1", port))] = true
		}
	}
	for _, item := range strings.Split(extraHosts, ",") {
		item = strings.ToLower(strings.TrimSpace(item))
		if item == "" {
			continue
		}
		guard.names[item] = true
		if host, _, err := net.SplitHostPort(item); err == nil && host != "" {
			guard.names[strings.TrimSuffix(host, ".")] = true
		}
	}
	return guard
}

func isMutation(method string) bool {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return false
	default:
		return true
	}
}

// needsJSONContentType reports whether a mutation carries a body that must be
// JSON. Uploads are multipart; /release/ accepts raw bytes and is not an API.
func needsJSONContentType(r *http.Request) bool {
	if !strings.HasPrefix(r.URL.Path, "/api/") {
		return false
	}
	if r.URL.Path == "/api/v1/herdr/uploads" {
		return false
	}
	if r.ContentLength == 0 && len(r.TransferEncoding) == 0 {
		return false
	}
	mediaType, _, err := mime.ParseMediaType(strings.TrimSpace(r.Header.Get("Content-Type")))
	return err != nil || !strings.EqualFold(mediaType, "application/json")
}

// sameOrigin allows requests that carry no browser provenance (fleet peers,
// curl, service scripts) and same-origin browser requests. It refuses cross-site
// and same-site browser requests, which is exactly the CSRF surface.
//
// A loopback-to-loopback mismatch is the Vite dev proxy: the browser's origin is
// 127.0.0.1:5175, while changeOrigin makes the backend see 127.0.0.1:18080.
// A remote page cannot present a loopback Origin, and a local page on another
// port is already refused by Sec-Fetch-Site: same-site. A configured host name
// is also accepted as an Origin so a reverse proxy can keep its public name.
func (g *requestGuard) sameOrigin(r *http.Request) bool {
	if site := strings.ToLower(strings.TrimSpace(r.Header.Get("Sec-Fetch-Site"))); site != "" {
		switch site {
		case "same-origin", "none":
		default:
			return false
		}
	}
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		return true
	}
	if strings.EqualFold(origin, "null") {
		return false
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Host == "" {
		return false
	}
	if strings.EqualFold(parsed.Host, r.Host) {
		return true
	}
	if isLoopbackHost(parsed.Host) && isLoopbackHost(r.Host) {
		return true
	}
	host := parsed.Host
	if withoutPort, _, splitErr := net.SplitHostPort(host); splitErr == nil {
		host = withoutPort
	}
	host = strings.TrimSuffix(strings.ToLower(host), ".")
	return g.names[host]
}

func isLoopbackHost(hostport string) bool {
	host := hostport
	if withoutPort, _, err := net.SplitHostPort(hostport); err == nil {
		host = withoutPort
	}
	host = strings.TrimSuffix(strings.ToLower(host), ".")
	if host == "localhost" {
		return true
	}
	if ip := net.ParseIP(host); ip != nil {
		return ip.IsLoopback()
	}
	return false
}

func (g *requestGuard) hostAllowed(hostport string) bool {
	value := strings.TrimSpace(hostport)
	if value == "" {
		return false
	}
	if g.exact[strings.ToLower(value)] {
		return true
	}
	host, port, err := net.SplitHostPort(value)
	if err != nil {
		host = value
		port = ""
	}
	host = strings.TrimSuffix(strings.ToLower(host), ".")
	if ip := net.ParseIP(host); ip != nil {
		// An IP literal must be the exact address:port this console was bound
		// to. A loopback request that reaches a proxied console arrives as the
		// proxy's name, which is handled below.
		if port == "" {
			return false
		}
		return g.exact[strings.ToLower(net.JoinHostPort(ip.String(), port))]
	}
	if host == "localhost" || g.names[host] {
		return true
	}
	// A DNS-rebinding page presents its own multi-label domain here. Single-label
	// LAN names, MagicDNS and mDNS names are not attacker-controlled.
	if !strings.Contains(host, ".") {
		return true
	}
	return strings.HasSuffix(host, ".ts.net") || strings.HasSuffix(host, ".local")
}
