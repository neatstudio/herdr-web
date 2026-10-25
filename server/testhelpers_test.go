package server

import (
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

func testWebFS() fs.FS {
	return fstest.MapFS{
		"index.html":          {Data: []byte("<!doctype html><title>herdr</title>")},
		"assets/index-abc.js": {Data: []byte("console.log('herdr')")},
	}
}

// isolateState gives one test its own durable ledger and task board, so a job
// started here cannot leak into the next test through the operator's state dir.
func isolateState(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	previousLedger, previousDispatch := ledgerPathOverride, dispatchStatePathOverride
	previousRepos := repoStatePathOverride
	ledgerPathOverride = filepath.Join(dir, "ledger.jsonl")
	dispatchStatePathOverride = filepath.Join(dir, "dispatch.json")
	repoStatePathOverride = filepath.Join(dir, "repos.json")
	t.Cleanup(func() {
		ledgerPathOverride = previousLedger
		dispatchStatePathOverride = previousDispatch
		repoStatePathOverride = previousRepos
	})
}

func newTestHandler(t *testing.T, socket string) http.Handler {
	t.Helper()
	isolateState(t)
	return NewServer(socket, testWebFS()).Handler()
}

func do(t *testing.T, handler http.Handler, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func decodeMap(t *testing.T, response *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode %q: %v", response.Body.String(), err)
	}
	return out
}

func decodeList(t *testing.T, response *httptest.ResponseRecorder) []any {
	t.Helper()
	var out []any
	if err := json.Unmarshal(response.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode %q: %v", response.Body.String(), err)
	}
	return out
}
