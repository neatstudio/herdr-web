package server

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// releaseSource is a fake release host: one asset and its checksum.
func releaseSource(t *testing.T, payload []byte, sum string) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, ".sha256") {
			if sum == "" {
				http.NotFound(w, r)
				return
			}
			_, _ = w.Write([]byte(sum + "  " + selfPlatform() + "\n"))
			return
		}
		_, _ = w.Write(payload)
	}))
	t.Cleanup(server.Close)
	return server
}

// fakeExecutable points the update at a file it may replace.
func fakeExecutable(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "herdr-web")
	if err := os.WriteFile(path, []byte(content), 0o755); err != nil {
		t.Fatal(err)
	}
	previous := selfExecutable
	selfExecutable = func() (string, error) { return path, nil }
	t.Cleanup(func() { selfExecutable = previous })
	return path
}

func checksum(content []byte) string {
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:])
}

func TestSelfUpdateReplacesTheRunningBinary(t *testing.T) {
	current := []byte("old binary")
	next := []byte("new binary, genuinely different")
	path := fakeExecutable(t, string(current))
	source := releaseSource(t, next, checksum(next))

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/herdr-web/update",
		strings.NewReader(`{"from":"`+source.URL+`"}`))
	handleSelfUpdate(recorder, request)

	body := recorder.Body.String()
	if recorder.Code != http.StatusOK || !strings.Contains(body, `"updated":true`) {
		t.Fatalf("status=%d body=%s", recorder.Code, body)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(next) {
		t.Fatalf("binary = %q, want the downloaded bytes", got)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm()&0o111 == 0 {
		t.Fatal("the replacement is not executable")
	}
	// It must not claim to have restarted itself: the answer to this request is
	// running on the old process.
	if !strings.Contains(body, "restart") {
		t.Fatalf("body=%s does not say how to start the new build", body)
	}
}

func TestSelfUpdateLeavesTheBinaryAloneWhenItIsCurrent(t *testing.T) {
	current := []byte("the same bytes")
	path := fakeExecutable(t, string(current))
	source := releaseSource(t, current, checksum(current))

	recorder := httptest.NewRecorder()
	handleSelfUpdate(recorder, httptest.NewRequest(http.MethodPost, "/api/v1/herdr-web/update",
		strings.NewReader(`{"from":"`+source.URL+`"}`)))

	body := recorder.Body.String()
	if !strings.Contains(body, `"updated":false`) {
		t.Fatalf("body=%s", body)
	}
	got, _ := os.ReadFile(path)
	if string(got) != string(current) {
		t.Fatalf("binary changed to %q", got)
	}
}

func TestSelfUpdateRefusesAMismatchedChecksum(t *testing.T) {
	current := []byte("old binary")
	path := fakeExecutable(t, string(current))
	// The source claims a checksum that its own payload does not match: this is
	// the case that matters, because it is what a tampered download looks like.
	source := releaseSource(t, []byte("tampered"), checksum([]byte("something else")))

	recorder := httptest.NewRecorder()
	handleSelfUpdate(recorder, httptest.NewRequest(http.MethodPost, "/api/v1/herdr-web/update",
		strings.NewReader(`{"from":"`+source.URL+`"}`)))

	body := recorder.Body.String()
	if !strings.Contains(body, `"ok":false`) || !strings.Contains(body, "did not match its checksum") {
		t.Fatalf("body=%s", body)
	}
	got, _ := os.ReadFile(path)
	if string(got) != string(current) {
		t.Fatal("a failed update replaced the running binary")
	}
}

func TestSelfUpdateRefusesASourceWithoutAChecksum(t *testing.T) {
	current := []byte("old binary")
	path := fakeExecutable(t, string(current))
	source := releaseSource(t, []byte("new"), "")

	recorder := httptest.NewRecorder()
	handleSelfUpdate(recorder, httptest.NewRequest(http.MethodPost, "/api/v1/herdr-web/update",
		strings.NewReader(`{"from":"`+source.URL+`"}`)))

	body := recorder.Body.String()
	if !strings.Contains(body, `"ok":false`) || !strings.Contains(body, "no checksum") {
		t.Fatalf("body=%s", body)
	}
	got, _ := os.ReadFile(path)
	if string(got) != string(current) {
		t.Fatal("an unverified download replaced the running binary")
	}
}

func TestSelfReleaseNamesTheRunningBuild(t *testing.T) {
	payload := []byte("binary bytes")
	fakeExecutable(t, string(payload))

	recorder := httptest.NewRecorder()
	handleSelfRelease(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/herdr-web/release", nil))

	body := recorder.Body.String()
	if !strings.Contains(body, checksum(payload)) {
		t.Fatalf("body=%s does not carry the checksum of the running binary", body)
	}
	if !strings.Contains(body, selfPlatform()) {
		t.Fatalf("body=%s does not carry the platform", body)
	}
}
