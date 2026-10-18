package server

import (
	"bytes"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func postUpload(t *testing.T, handler http.Handler, name string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	var buf bytes.Buffer
	form := multipart.NewWriter(&buf)
	part, err := form.CreateFormFile("file", name)
	if err != nil {
		t.Fatalf("form: %v", err)
	}
	if _, err := part.Write(body); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := form.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/v1/herdr/uploads", &buf)
	request.Header.Set("Content-Type", form.FormDataContentType())
	got := httptest.NewRecorder()
	handler.ServeHTTP(got, request)
	return got
}

func TestUploadStoresTheFileAndAnswersWithItsPath(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HERDR_WEB_UPLOAD_DIR", dir)
	handler := newTestHandler(t, "/tmp/nonexistent.sock")

	got := postUpload(t, handler, "screenshot.png", []byte("\x89PNG\r\n\x1a\nfake"))
	if got.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", got.Code, got.Body.String())
	}
	body := decodeMap(t, got)
	path, _ := body["path"].(string)
	if path == "" {
		t.Fatalf("no path in %s", got.Body.String())
	}
	// The path must be readable by the agent, and the extension must survive:
	// that is how an agent decides how to read the file.
	if filepath.Dir(path) != dir {
		t.Fatalf("path %q is not inside %q", path, dir)
	}
	if !strings.HasSuffix(path, ".png") {
		t.Fatalf("extension lost: %q", path)
	}
	stored, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if string(stored) != "\x89PNG\r\n\x1a\nfake" {
		t.Fatalf("contents differ: %q", stored)
	}
	if bytes, _ := body["bytes"].(float64); int(bytes) != len(stored) {
		t.Fatalf("bytes=%v want %d", body["bytes"], len(stored))
	}
}

func TestUploadKeepsAClientNameInsideTheUploadDirectory(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HERDR_WEB_UPLOAD_DIR", dir)
	handler := newTestHandler(t, "/tmp/nonexistent.sock")

	for _, hostile := range []string{
		"../../../../etc/passwd",
		"/etc/passwd",
		`..\..\windows\system32\evil`,
		"a;rm -rf ~;b.png",
		"$(whoami).png",
		"....//....//escape.png",
	} {
		got := postUpload(t, handler, hostile, []byte("x"))
		if got.Code != http.StatusOK {
			t.Fatalf("name=%q status=%d", hostile, got.Code)
		}
		body := decodeMap(t, got)
		path, _ := body["path"].(string)
		if filepath.Dir(path) != dir {
			t.Fatalf("name=%q escaped to %q", hostile, path)
		}
		name := filepath.Base(path)
		if strings.ContainsAny(name, `;$( )'"`+"`\t") {
			t.Fatalf("name=%q kept shell characters: %q", hostile, name)
		}
		// Whatever was kept must still exist only under the upload directory.
		entries, err := os.ReadDir(dir)
		if err != nil {
			t.Fatalf("readdir: %v", err)
		}
		for _, entry := range entries {
			if entry.IsDir() {
				t.Fatalf("name=%q created a directory", hostile)
			}
		}
	}
}

func TestUploadRejectsAnEmptyOrMissingFile(t *testing.T) {
	t.Setenv("HERDR_WEB_UPLOAD_DIR", t.TempDir())
	handler := newTestHandler(t, "/tmp/nonexistent.sock")

	request := httptest.NewRequest(http.MethodPost, "/api/v1/herdr/uploads", strings.NewReader("not a form"))
	request.Header.Set("Content-Type", "multipart/form-data; boundary=nope")
	got := httptest.NewRecorder()
	handler.ServeHTTP(got, request)
	if got.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", got.Code, got.Body.String())
	}
	if method := do(t, handler, http.MethodGet, "/api/v1/herdr/uploads", ""); method.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET status=%d", method.Code)
	}
}

func TestSafeNameNeverProducesAnEmptyOrHiddenName(t *testing.T) {
	for input, want := range map[string]string{
		"":            "attachment",
		"   ":         "attachment",
		"...":         "attachment",
		".hidden.png": "hidden.png",
		"shot 1.png":  "shot_1.png",
		"a/b/c.png":   "c.png",
	} {
		if got := safeName(input); got != want {
			t.Fatalf("safeName(%q)=%q want %q", input, got, want)
		}
	}
}
