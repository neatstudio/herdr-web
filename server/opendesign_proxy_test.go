package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestOpenDesignProxyRewritesPathAndHost(t *testing.T) {
	var gotPath, gotHost string
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotHost = r.URL.Path, r.Host
		_, _ = io.WriteString(w, `{"ok":true}`)
	}))
	defer target.Close()
	t.Setenv("HERDR_WEB_OPENDESIGN_BASE", target.URL)

	console := NewServer("", nil)
	proxy := httptest.NewServer(console.openDesignProxy())
	defer proxy.Close()

	response, err := http.Get(proxy.URL + "/opendesign/v1/models")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", response.StatusCode)
	}
	if gotPath != "/v1/models" {
		t.Fatalf("upstream path = %q", gotPath)
	}
	if want := strings.TrimPrefix(target.URL, "http://"); gotHost != want {
		t.Fatalf("upstream host = %q, want %q", gotHost, want)
	}
}
