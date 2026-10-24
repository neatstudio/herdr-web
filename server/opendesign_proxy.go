package server

import (
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
)

const defaultOpenDesignBase = "https://amr-link.open-design.ai"

// openDesignProxy forwards /opendesign/* to the OpenAI-compatible opendesign
// endpoint. zerostack's rustls/h2 client is closed by that host's Cloudflare
// edge, while Go's net/http works; embedding the proxy in the console removes
// the separate process. The API key still travels in the Authorization header
// from the caller, so this proxy stores no secret.
//
// HERDR_WEB_OPENDESIGN_BASE overrides the upstream (tests, or another gateway).
func (s *Server) openDesignProxy() http.Handler {
	base := strings.TrimSpace(os.Getenv("HERDR_WEB_OPENDESIGN_BASE"))
	if base == "" {
		base = defaultOpenDesignBase
	}
	target, err := url.Parse(base)
	if err != nil {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			writeError(w, http.StatusInternalServerError, "opendesign_proxy", "invalid upstream")
		})
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	director := proxy.Director
	proxy.Director = func(request *http.Request) {
		director(request)
		// Cloudflare routes by Host; the caller's Host is 127.0.0.1:PORT.
		request.Host = target.Host
		request.URL.Path = strings.TrimPrefix(request.URL.Path, "/opendesign")
		if request.URL.Path == "" {
			request.URL.Path = "/"
		}
	}
	proxy.ErrorLog = log.Default()
	return proxy
}
