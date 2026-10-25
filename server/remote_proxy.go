package server

import (
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
)

// handleRemoteProxy forwards /api/v1/remote/<host>/<path> to a known fleet
// peer. The browser only sees this console's origin, so the local UI can use
// same-origin HTTP and WebSocket without CORS. The peer must already be in the
// fleet or configured as a seed: this is not an open proxy.
func (s *Server) handleRemoteProxy(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/v1/remote/")
	host := rest
	path := "/"
	if index := strings.IndexByte(rest, '/'); index >= 0 {
		host = rest[:index]
		path = rest[index:]
	}
	host = strings.TrimSpace(host)
	if host == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "peer host is required")
		return
	}
	if !s.knownPeerHost(host) {
		writeError(w, http.StatusForbidden, "unknown_peer", "peer is not part of the fleet")
		return
	}
	target, err := url.Parse("http://" + host)
	if err != nil || target.Host == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "invalid peer host")
		return
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	director := proxy.Director
	proxy.Director = func(request *http.Request) {
		director(request)
		addConsoleToken(request)
		request.URL.Path = path
		request.Host = target.Host
	}
	// -1 flushes every write: SSE and WebSocket frames must not wait for a
	// buffer to fill.
	proxy.FlushInterval = -1
	proxy.ErrorLog = log.Default()
	proxy.ServeHTTP(w, r)
}

func (s *Server) knownPeerHost(host string) bool {
	host = strings.TrimSpace(host)
	for _, candidate := range append(s.fleetConsoles(), "http://"+s.fleetAddr) {
		parsed, err := url.Parse(candidate)
		if err != nil {
			continue
		}
		if strings.EqualFold(parsed.Host, host) {
			return true
		}
	}
	return false
}
