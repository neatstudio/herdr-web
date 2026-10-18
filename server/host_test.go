package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestHostStatSaysWhetherAPathIsHere(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "chart.png")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	handler := newTestHandler(t, "/tmp/nonexistent.sock")

	got := do(t, handler, http.MethodGet, "/api/v1/herdr/host/stat?path="+file, "")
	if got.Code != http.StatusOK {
		t.Fatalf("status=%d", got.Code)
	}
	body := decodeMap(t, got)
	if body["exists"] != true || body["isDir"] != false {
		t.Fatalf("file body=%v", body)
	}

	dirBody := decodeMap(t, do(t, handler, http.MethodGet, "/api/v1/herdr/host/stat?path="+dir, ""))
	if dirBody["isDir"] != true {
		t.Fatalf("directory body=%v", dirBody)
	}

	// A path that is not here is the remote-pane case: an answer, not an error.
	missing := decodeMap(t, do(t, handler, http.MethodGet,
		"/api/v1/herdr/host/stat?path=/nope/on/this/host.png", ""))
	if missing["exists"] != false {
		t.Fatalf("missing body=%v", missing)
	}

	if bad := do(t, handler, http.MethodGet, "/api/v1/herdr/host/stat?path=relative", ""); bad.Code != http.StatusBadRequest {
		t.Fatalf("relative status=%d", bad.Code)
	}
	if method := do(t, handler, http.MethodPost, "/api/v1/herdr/host/stat?path=/tmp", ""); method.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST status=%d", method.Code)
	}
	_ = httptest.NewRecorder
}
