package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// releaseTestVersion is what the fake sources publish as their version.
const releaseTestVersion = "v99.0.0"

// versionedBuild is an asset that answers -version the way the console does, so
// the update's "does the file name itself" check has something to ask.
func versionedBuild(version, tag string) []byte {
	return []byte("#!/bin/sh\n# " + tag + "\necho 'herdr-web " + version + "'\n")
}

// releaseSource is a fake release host: one asset, its checksum and a version.
func releaseSource(t *testing.T, payload []byte, sum string) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/version") {
			_, _ = w.Write([]byte(releaseTestVersion + "\n"))
			return
		}
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
	next := versionedBuild(releaseTestVersion, "new binary, genuinely different")
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

func TestSelfUpdateRefusesAFileThatCannotNameItsVersion(t *testing.T) {
	// The checksum matches, but the file does not answer -version. "Could not
	// ask" is not proof it is the promised build, so nothing may be replaced.
	current := []byte("old binary")
	next := []byte("not a program at all")
	path := fakeExecutable(t, string(current))
	source := releaseSource(t, next, checksum(next))

	recorder := httptest.NewRecorder()
	handleSelfUpdate(recorder, httptest.NewRequest(http.MethodPost, "/api/v1/herdr-web/update",
		strings.NewReader(`{"from":"`+source.URL+`"}`)))

	body := recorder.Body.String()
	if !strings.Contains(body, `"ok":false`) || !strings.Contains(body, "could not say which build") {
		t.Fatalf("status=%d body=%s", recorder.Code, body)
	}
	got, _ := os.ReadFile(path)
	if string(got) != string(current) {
		t.Fatal("an unidentifiable download replaced the running binary")
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

// otherPlatform is a release name that is never the platform the test runs on,
// because "linux-amd64" is the test's own platform when CI runs on Linux and the
// self branch answers instead of the directory.
const otherPlatform = "herdr-web-plan9-mips"

func TestReleaseServesTheChecksumOfANonSelfPlatform(t *testing.T) {
	// The release directory holds the other platforms. A client asking for
	// "<asset>.sha256" must get that file, not "<asset>.sha256.sha256".
	dir := t.TempDir()
	previous := os.Getenv("HERDR_WEB_RELEASE_DIR")
	if err := os.Setenv("HERDR_WEB_RELEASE_DIR", dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Setenv("HERDR_WEB_RELEASE_DIR", previous) })

	asset := otherPlatform
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

	t.Setenv(releaseUploadTokenEnv, "seed-secret")
	payload := []byte("a linux binary")
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/release/"+otherPlatform,
		bytes.NewReader(payload))
	request.Header.Set("X-Herdr-Release-Token", "seed-secret")
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
	for _, name := range []string{otherPlatform, otherPlatform + ".sha256"} {
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
	next := versionedBuild(releaseTestVersion, "new build")
	var hits int
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/version") {
			_, _ = w.Write([]byte(releaseTestVersion))
			return
		}
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

func TestSelfUpdateFallsThroughToAPeerWhenGitHubIsUnreachable(t *testing.T) {
	// The judgement the console is supposed to make for itself: GitHub is the
	// official source, but a console on the same tailnet serves the same files.
	current := []byte("old build")
	next := versionedBuild("v99.0.0", "newer build")
	path := fakeExecutable(t, string(current))
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/version") {
			_, _ = w.Write([]byte("v99.0.0"))
			return
		}
		if strings.HasSuffix(r.URL.Path, ".sha256") {
			_, _ = w.Write([]byte(checksum(next) + "  " + selfPlatform() + "\n"))
			return
		}
		_, _ = w.Write(next)
	}))
	t.Cleanup(peer.Close)

	// No remembered source, and GitHub pointed at a dead address.
	t.Setenv("HERDR_WEB_RELEASE_SOURCE", "")
	t.Setenv("HOME", t.TempDir())
	previousOfficial := selfOfficialSource
	selfOfficialSource = "http://127.0.0.1:1/release"
	t.Cleanup(func() { selfOfficialSource = previousOfficial })

	previousPeers := selfTailnetPeers
	selfTailnetPeers = func(context.Context) []selfCandidate {
		return []selfCandidate{{Source: peer.URL + "/release", Version: "v99.0.0"}}
	}
	t.Cleanup(func() { selfTailnetPeers = previousPeers })
	previousDelay := selfRetryDelay
	selfRetryDelay = time.Millisecond
	t.Cleanup(func() { selfRetryDelay = previousDelay })

	recorder := httptest.NewRecorder()
	handleSelfUpdate(recorder, httptest.NewRequest(http.MethodPost, "/api/v1/herdr-web/update", nil))

	body := recorder.Body.String()
	if !strings.Contains(body, `"updated":true`) {
		t.Fatalf("the peer was not used: %s", body)
	}
	if !strings.Contains(body, "used "+peer.URL+"/release") {
		t.Fatalf("body does not say where the build came from: %s", body)
	}
	got, _ := os.ReadFile(path)
	if string(got) != string(next) {
		t.Fatalf("binary = %q", got)
	}
	// And the choice is remembered, so the next update does not pay for GitHub
	// again.
	if state := readSelfState(); state.Source != peer.URL+"/release" {
		t.Fatalf("remembered source = %q", state.Source)
	}
	if state := readSelfState(); state.GitHubFailedAt == 0 {
		t.Fatal("a failed GitHub attempt was not remembered")
	}
}

func TestSelfCandidatesPreferTheRememberedSource(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("HERDR_WEB_RELEASE_SOURCE", "")
	previousPeers := selfTailnetPeers
	selfTailnetPeers = func(context.Context) []selfCandidate {
		return []selfCandidate{{Source: "http://peer:5000/release", Version: "v99.0.0"}}
	}
	t.Cleanup(func() { selfTailnetPeers = previousPeers })

	writeSelfState(selfState{Source: "http://remembered:5000/release"})
	got := selfCandidates(context.Background(), "")
	if len(got) == 0 || got[0].Source != "http://remembered:5000/release" {
		t.Fatalf("candidates = %v, want the remembered source first", got)
	}

	// After a GitHub failure the peers come before it, which is what makes a
	// blocked link cost one slow attempt rather than every update.
	rememberGitHubFailure()
	got = selfCandidates(context.Background(), "")
	peerAt, githubAt := -1, -1
	for i, candidate := range got {
		if strings.HasPrefix(candidate.Source, "http://peer") {
			peerAt = i
		}
		if strings.Contains(candidate.Source, "github.com") {
			githubAt = i
		}
	}
	if peerAt < 0 || githubAt < 0 || peerAt > githubAt {
		t.Fatalf("candidates = %v, want the peer before github", got)
	}

	// An explicit source is a decision: nothing else is tried.
	got = selfCandidates(context.Background(), "http://explicit/release")
	if len(got) != 1 || got[0].Source != "http://explicit/release" {
		t.Fatalf("candidates = %v", got)
	}
}

func TestSelfUpdateRefusesAnOlderPeer(t *testing.T) {
	// The hash differs, so without a version comparison this would replace a
	// working console with an older build — which is exactly what happened once.
	current := []byte("current build")
	path := fakeExecutable(t, string(current))
	older := []byte("older build")
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, ".sha256") {
			_, _ = w.Write([]byte(checksum(older) + "  " + selfPlatform() + "\n"))
			return
		}
		_, _ = w.Write(older)
	}))
	t.Cleanup(peer.Close)

	t.Setenv("HOME", t.TempDir())
	t.Setenv("HERDR_WEB_RELEASE_SOURCE", "")
	previousOfficial := selfOfficialSource
	selfOfficialSource = "http://127.0.0.1:1/release"
	t.Cleanup(func() { selfOfficialSource = previousOfficial })
	previousPeers := selfTailnetPeers
	selfTailnetPeers = func(context.Context) []selfCandidate {
		// A version below the one this build reports.
		return []selfCandidate{{Source: peer.URL + "/release", Version: "v0.0.1"}}
	}
	t.Cleanup(func() { selfTailnetPeers = previousPeers })
	previousVersion := ConsoleVersion
	ConsoleVersion = "v0.2.0-22-gabcdef"
	t.Cleanup(func() { ConsoleVersion = previousVersion })
	previousDelay := selfRetryDelay
	selfRetryDelay = time.Millisecond
	t.Cleanup(func() { selfRetryDelay = previousDelay })

	recorder := httptest.NewRecorder()
	handleSelfUpdate(recorder, httptest.NewRequest(http.MethodPost, "/api/v1/herdr-web/update", nil))

	body := recorder.Body.String()
	if strings.Contains(body, `"updated":true`) {
		t.Fatalf("an older build was installed: %s", body)
	}
	if !strings.Contains(body, "not newer") {
		t.Fatalf("body does not explain the skip: %s", body)
	}
	got, _ := os.ReadFile(path)
	if string(got) != string(current) {
		t.Fatal("the binary was replaced by an older build")
	}
}

func TestSelfNewerUnderstandsUntaggedBuilds(t *testing.T) {
	// Two builds of the same release differ only by their commit count, and a
	// fleet that never tags relies on that being ordered.
	if !selfNewer("v0.2.0-22-g8916292", "v0.2.0-17-g32b94d0") {
		t.Error("a later commit count is not newer")
	}
	if selfNewer("v0.2.0-15-g6e049b7", "v0.2.0-22-g8916292") {
		t.Error("an earlier commit count is newer")
	}
	if selfNewer("v0.2.0-22-g8916292", "v0.2.0-22-g8916292") {
		t.Error("the same build is not newer")
	}
	if !selfNewer("v0.2.1", "v0.2.0-22-g8916292") {
		t.Error("a later release is not newer")
	}
	if selfNewer("v0.2.0", "v0.2.0-22-g8916292") {
		t.Error("the release a build sits on is not newer than that build")
	}
}

func TestReleaseServesItsOwnChecksum(t *testing.T) {
	// "herdr-web-<platform>.sha256" starts with "herdr-", so a herdr-prefixed
	// branch placed first swallowed the console's own assets and the update
	// failed with "not on this host".
	payload := []byte("binary bytes")
	path := fakeExecutable(t, string(payload))

	recorder := httptest.NewRecorder()
	handleRelease(recorder, httptest.NewRequest(http.MethodGet, "/release/"+selfPlatform()+".sha256", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), checksum(payload)) {
		t.Fatalf("body = %q", recorder.Body.String())
	}
	_ = path
}

func TestSelfUpdateRefusesAFileThatIsNotTheBuildItNames(t *testing.T) {
	// A source can publish a version file that does not match the asset it serves
	// — a macOS console serving an old Linux archive under its own version once
	// downgraded four machines, with a perfectly valid checksum. The downloaded
	// binary is run before it replaces anything.
	if runtime.GOOS == "windows" {
		t.Skip("the check runs the downloaded binary")
	}
	fakeExecutable(t, "old build")
	// A real, current binary: this test binary cannot be exec'd as herdr-web, so
	// the asset is a shell script that answers -version the way the console does.
	asset := []byte("#!/bin/sh\necho 'herdr-web v0.1.0'\n")
	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/release/version":
			_, _ = w.Write([]byte("v9.9.9\n"))
		case strings.HasSuffix(r.URL.Path, ".sha256"):
			_, _ = w.Write([]byte(checksum(asset) + "  " + selfPlatform() + "\n"))
		default:
			_, _ = w.Write(asset)
		}
	}))
	t.Cleanup(hub.Close)

	previousOfficial := selfOfficialSource
	selfOfficialSource = "http://127.0.0.1:1/release"
	t.Cleanup(func() { selfOfficialSource = previousOfficial })
	console := fleetTestServer(t)
	console.SetFleetForTest(hub.URL, "100.89.0.4:5000")
	previousRestart := fleetRestart
	fleetRestart = func() error { return nil }
	t.Cleanup(func() { fleetRestart = previousRestart })

	updated, err := console.fleetFollowOnce(context.Background())
	if err == nil && updated {
		t.Fatal("a binary that claims another version was installed")
	}
}

func TestSelfUpdateRefusesADevelopmentBuild(t *testing.T) {
	// A console on a developer's machine publishes whatever it was built from, and
	// the fleet must not adopt a tree with uncommitted changes.
	fakeExecutable(t, "current build")
	hub := releaseSource(t, []byte("dev build"), "")
	_ = hub
	asset := []byte("development")
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/release/version":
			_, _ = w.Write([]byte("v0.7.0-dirty\n"))
		case strings.HasSuffix(r.URL.Path, ".sha256"):
			_, _ = w.Write([]byte(checksum(asset) + "  " + selfPlatform() + "\n"))
		default:
			_, _ = w.Write(asset)
		}
	}))
	t.Cleanup(source.Close)

	previousOfficial := selfOfficialSource
	selfOfficialSource = "http://127.0.0.1:1/release"
	t.Cleanup(func() { selfOfficialSource = previousOfficial })
	console := fleetTestServer(t)
	console.SetFleetForTest(source.URL, "100.89.0.4:5000")
	previousRestart := fleetRestart
	fleetRestart = func() error {
		t.Fatal("a development build was installed")
		return nil
	}
	t.Cleanup(func() { fleetRestart = previousRestart })

	updated, err := console.fleetFollowOnce(context.Background())
	if err == nil || updated {
		t.Fatalf("updated = %v, err = %v", updated, err)
	}
}

func TestReleaseUploadRequiresItsOwnSecret(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HERDR_WEB_RELEASE_DIR", dir)
	t.Setenv(releaseUploadTokenEnv, "")

	disabled := httptest.NewRecorder()
	handleRelease(disabled, httptest.NewRequest(http.MethodPost, "/release/"+otherPlatform,
		strings.NewReader("x")))
	if disabled.Code != http.StatusForbidden {
		t.Fatalf("disabled = %d: %s", disabled.Code, disabled.Body.String())
	}

	t.Setenv(releaseUploadTokenEnv, "seed-secret")
	missing := httptest.NewRecorder()
	handleRelease(missing, httptest.NewRequest(http.MethodPost, "/release/"+otherPlatform,
		strings.NewReader("x")))
	if missing.Code != http.StatusUnauthorized {
		t.Fatalf("missing = %d: %s", missing.Code, missing.Body.String())
	}

	wrong := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/release/"+otherPlatform, strings.NewReader("x"))
	request.Header.Set("X-Herdr-Release-Token", "wrong")
	handleRelease(wrong, request)
	if wrong.Code != http.StatusUnauthorized {
		t.Fatalf("wrong = %d: %s", wrong.Code, wrong.Body.String())
	}

	// The console token must not work as the seed secret.
	console := httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodPost, "/release/"+otherPlatform, strings.NewReader("x"))
	request.Header.Set("Authorization", "Bearer seed-secret")
	handleRelease(console, request)
	if console.Code != http.StatusUnauthorized {
		t.Fatalf("console bearer = %d: %s", console.Code, console.Body.String())
	}
}
