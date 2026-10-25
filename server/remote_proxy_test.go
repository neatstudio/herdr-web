package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRemoteProxyForwardsKnownPeer(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/health" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{"status":"ok","peer":true}`))
	}))
	defer target.Close()

	console := NewServer("", nil)
	console.fleetSeeds = []string{target.URL}
	handler := console.Handler()
	host := strings.TrimPrefix(target.URL, "http://")

	response := do(t, handler, http.MethodGet, "/api/v1/remote/"+host+"/api/health", "")
	if response.Code != http.StatusOK {
		t.Fatalf("proxy = %d: %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"peer":true`) {
		t.Fatalf("body = %s", response.Body.String())
	}

	unknown := do(t, handler, http.MethodGet, "/api/v1/remote/10.0.0.1:5000/api/health", "")
	if unknown.Code != http.StatusForbidden {
		t.Fatalf("unknown peer = %d", unknown.Code)
	}
}
