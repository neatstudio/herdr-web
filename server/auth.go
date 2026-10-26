package server

import (
	"context"
	"crypto/subtle"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
)

// consoleTokenEnv is an optional shared bearer token. It is empty by default so
// a private-bind console keeps working as before; once set, every API and model
// proxy request must present it. Fleet peers read the same variable, and the
// fleet/proxy request builders copy it, so one value authenticates the mesh.
const consoleTokenEnv = "HERDR_WEB_TOKEN"

// browserTokenEnv controls whether a same-origin browser needs the console
// token. Cookies are per-origin, so requiring it for every console means a
// manual /auth per host. The default trusts same-origin browser requests to the
// private-bind console; fleet peers, scripts, and cross-site pages still need
// the token. Set HERDR_WEB_TOKEN_BROWSER=require for the strict per-origin login.
const browserTokenEnv = "HERDR_WEB_TOKEN_BROWSER"

// trustedNetsEnv is the network perimeter. A peer inside one of these CIDRs is
// authenticated by the tailnet/LAN itself; the console token is for callers
// outside that perimeter. This is what makes a tailnet fleet feel like one
// machine instead of one login per origin.
const trustedNetsEnv = "HERDR_WEB_TRUSTED_NETS"

func consoleToken() string {
	return strings.TrimSpace(os.Getenv(consoleTokenEnv))
}

// tokenRequired reports whether a path is behind the console token. Health and
// provider webhooks are deliberately outside it: health is a liveness probe and
// webhooks carry their own HMAC over the raw body.
func tokenRequired(path string) bool {
	if path == "/api/health" || strings.HasPrefix(path, "/api/v1/webhooks/") {
		return false
	}
	return strings.HasPrefix(path, "/api/") || strings.HasPrefix(path, "/opendesign/")
}

func requestToken(r *http.Request) string {
	if value := strings.TrimSpace(r.Header.Get("Authorization")); value != "" {
		if len(value) >= 7 && strings.EqualFold(value[:7], "bearer ") {
			return strings.TrimSpace(value[7:])
		}
		return ""
	}
	if value := strings.TrimSpace(r.Header.Get("X-Herdr-Token")); value != "" {
		return value
	}
	if cookie, err := r.Cookie("herdr_web_token"); err == nil {
		return strings.TrimSpace(cookie.Value)
	}
	return ""
}

func trustedSource(r *http.Request) bool {
	raw := strings.TrimSpace(os.Getenv(trustedNetsEnv))
	if raw == "" {
		return false
	}
	host := r.RemoteAddr
	if parsed, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		host = parsed
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	if ip == nil {
		return false
	}
	for _, item := range strings.Split(raw, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		_, network, err := net.ParseCIDR(item)
		if err == nil && network.Contains(ip) {
			return true
		}
	}
	return false
}

func browserTokenExempt() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(browserTokenEnv))) {
	case "require", "strict", "off", "false", "0":
		return false
	default:
		return true
	}
}

// browserProvenanceSameOrigin recognizes the browser itself, not an API client
// that merely happens to be on the same network. Sec-Fetch-Site is the direct
// signal; WebSocket/EventSource use Origin. A request with neither is treated as
// a script and must present the token.
func browserProvenanceSameOrigin(r *http.Request) bool {
	switch strings.ToLower(strings.TrimSpace(r.Header.Get("Sec-Fetch-Site"))) {
	case "same-origin", "none":
		return true
	case "":
		// Older browsers may omit it for same-origin fetches; fall through to
		// Origin rather than trusting an unverifiable script request.
	default:
		return false
	}
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		return false
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Host == "" {
		return false
	}
	if strings.EqualFold(parsed.Host, r.Host) {
		return true
	}
	return isLoopbackHost(parsed.Host) && isLoopbackHost(r.Host)
}

func tokenMatches(supplied, expected string) bool {
	if supplied == "" || expected == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(supplied), []byte(expected)) == 1
}

// addConsoleToken attaches the shared token to an outbound request. It is a
// no-op when the operator did not configure one.
func addConsoleToken(r *http.Request) {
	if token := consoleToken(); token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
}

func newConsoleRequest(ctx context.Context, method, url string, body io.Reader) (*http.Request, error) {
	request, err := http.NewRequestWithContext(ctx, method, url, body)
	if err != nil {
		return nil, err
	}
	addConsoleToken(request)
	return request, nil
}
