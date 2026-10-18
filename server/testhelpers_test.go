package server

import (
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
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

func newTestHandler(t *testing.T, socket string) http.Handler {
	t.Helper()
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
