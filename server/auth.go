package server

import (
	"context"
	"crypto/subtle"
	"io"
	"net/http"
	"os"
	"strings"
)

// consoleTokenEnv is an optional shared bearer token. It is empty by default so
// a private-bind console keeps working as before; once set, every API and model
// proxy request must present it. Fleet peers read the same variable, and the
// fleet/proxy request builders copy it, so one value authenticates the mesh.
const consoleTokenEnv = "HERDR_WEB_TOKEN"

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
