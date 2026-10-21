package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
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

func TestReleaseServesTheChecksumOfANonSelfPlatform(t *testing.T) {
	// The release directory holds the other platforms. A client asking for
	// "<asset>.sha256" must get that file, not "<asset>.sha256.sha256".
	dir := t.TempDir()
	previous := os.Getenv("HERDR_WEB_RELEASE_DIR")
	if err := os.Setenv("HERDR_WEB_RELEASE_DIR", dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Setenv("HERDR_WEB_RELEASE_DIR", previous) })

	asset := "herdr-web-linux-amd64"
	if err := os.WriteFile(filepath.Join(dir, asset), []byte("binary"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, asset+".sha256"), []byte("abc123  "+asset+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	recorder := httptest.NewRecorder()
	handleRelease(recorder, httptest.NewRequest(http.MethodGet, "/release/"+asset+".sha256", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", recorder.Code)
	}
	if got := recorder.Body.String(); !strings.Contains(got, "abc123") {
		t.Fatalf("body = %q", got)
	}
}

func TestReleaseUploadSeedsAServingHost(t *testing.T) {
	// A network with no way out still needs the files: the reachable machine is
	// seeded by hand and serves the rest of its segment from /release.
	dir := t.TempDir()
	previous := os.Getenv("HERDR_WEB_RELEASE_DIR")
	if err := os.Setenv("HERDR_WEB_RELEASE_DIR", dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Setenv("HERDR_WEB_RELEASE_DIR", previous) })

	payload := []byte("a linux binary")
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/release/herdr-web-linux-amd64",
		bytes.NewReader(payload))
	handleRelease(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", recorder.Code, recorder.Body.String())
	}
	var body struct {
		SHA256 string `json:"sha256"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	// The checksum comes from what arrived, not from the request.
	if body.SHA256 != checksum(payload) {
		t.Fatalf("sha256 = %s, want %s", body.SHA256, checksum(payload))
	}

	// And it is served back, with the checksum file the installer looks for.
	for _, name := range []string{"herdr-web-linux-amd64", "herdr-web-linux-amd64.sha256"} {
		got := httptest.NewRecorder()
		handleRelease(got, httptest.NewRequest(http.MethodGet, "/release/"+name, nil))
		if got.Code != http.StatusOK {
			t.Fatalf("%s: status = %d", name, got.Code)
		}
		if !strings.Contains(got.Body.String(), "linux binary") &&
			!strings.Contains(got.Body.String(), body.SHA256) {
			t.Fatalf("%s: body = %q", name, got.Body.String())
		}
	}
}

func TestReleaseUploadRefusesAnythingElse(t *testing.T) {
	dir := t.TempDir()
	previous := os.Getenv("HERDR_WEB_RELEASE_DIR")
	if err := os.Setenv("HERDR_WEB_RELEASE_DIR", dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Setenv("HERDR_WEB_RELEASE_DIR", previous) })

	for _, name := range []string{"../../etc/passwd", "notes.txt", ""} {
		recorder := httptest.NewRecorder()
		handleRelease(recorder, httptest.NewRequest(http.MethodPost, "/release/"+name,
			strings.NewReader("x")))
		if recorder.Code == http.StatusOK {
			t.Fatalf("%q was accepted", name)
		}
	}
}

func TestSelfUpdateRetriesADroppedChecksum(t *testing.T) {
	// A body cut short is what a CDN redirect looks like on a flaky link, and
	// one attempt used to be the verdict: the panel reported a missing checksum
	// for a file that exists.
	current := []byte("old build")
	path := fakeExecutable(t, string(current))
	next := []byte("new build")
	var hits int
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, ".sha256") {
			hits++
			if hits == 1 {
				// Announce a length, then send less: the client sees unexpected EOF.
				w.Header().Set("Content-Length", "128")
				_, _ = w.Write([]byte("truncated"))
				return
			}
			_, _ = w.Write([]byte(checksum(next) + "  " + selfPlatform() + "\n"))
			return
		}
		_, _ = w.Write(next)
	}))
	t.Cleanup(source.Close)

	previousDelay := selfRetryDelay
	selfRetryDelay = time.Millisecond
	t.Cleanup(func() { selfRetryDelay = previousDelay })

	recorder := httptest.NewRecorder()
	handleSelfUpdate(recorder, httptest.NewRequest(http.MethodPost, "/api/v1/herdr-web/update",
		strings.NewReader(`{"from":"`+source.URL+`"}`)))

	if !strings.Contains(recorder.Body.String(), `"updated":true`) {
		t.Fatalf("a dropped body should be retried, got %s", recorder.Body.String())
	}
	if hits < 2 {
		t.Fatalf("checksum fetched %d times, want a retry", hits)
	}
	got, _ := os.ReadFile(path)
	if string(got) != string(next) {
		t.Fatalf("binary = %q", got)
	}
}

func TestSelfUpdateNamesAnUnreachableSourceAsSuch(t *testing.T) {
	// "No checksum published" and "could not reach the source" are different
	// problems; reporting the first for the second sends the operator looking
	// for a file that is not missing.
	fakeExecutable(t, "old build")
	recorder := httptest.NewRecorder()
	handleSelfUpdate(recorder, httptest.NewRequest(http.MethodPost, "/api/v1/herdr-web/update",
		strings.NewReader(`{"from":"http://127.0.0.1:1/release"}`)))

	body := recorder.Body.String()
	if strings.Contains(body, "published no checksum") {
		t.Fatalf("a connection failure was reported as a missing checksum: %s", body)
	}
	if !strings.Contains(body, "could not be read") {
		t.Fatalf("body = %s", body)
	}
}

func TestSelfSourceFallsBackToAConfiguredMirror(t *testing.T) {
	t.Setenv("HERDR_WEB_RELEASE_SOURCE", "http://mirror.example:5000/release")
	// A host that cannot trust GitHub pins its own source once, instead of
	// naming it on every update.
	if got := selfSourceURL(""); got != "http://mirror.example:5000/release" {
		t.Fatalf("source = %q", got)
	}
	if got := selfSourceURL("http://explicit/release/"); got != "http://explicit/release" {
		t.Fatalf("an explicit source must win, got %q", got)
	}
}
