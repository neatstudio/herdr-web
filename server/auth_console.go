package server

import (
	"net/http"
	"strings"
)

// handleConsoleAuth turns the console token into an HttpOnly cookie. A browser
// cannot attach an Authorization header to EventSource or WebSocket, but it does
// send cookies, so visiting /auth?token=... once makes the existing UI work with
// the token without putting the secret in JavaScript.
func (s *Server) handleConsoleAuth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, "GET")
		return
	}
	token := consoleToken()
	if token == "" {
		http.Redirect(w, r, "/", http.StatusFound)
		return
	}
	if !tokenMatches(strings.TrimSpace(r.URL.Query().Get("token")), token) {
		writeError(w, http.StatusUnauthorized, "unauthorized", "a console token is required")
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     "herdr_web_token",
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		Secure:   r.TLS != nil,
	})
	http.Redirect(w, r, "/", http.StatusFound)
}
