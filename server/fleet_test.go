package server

import (
	"context"
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

func fleetTestServer(t *testing.T) *Server {
	t.Helper()
	fleetStatePathOverride = filepath.Join(t.TempDir(), "fleet.json")
	t.Cleanup(func() { fleetStatePathOverride = "" })
	return NewServer(filepath.Join(t.TempDir(), "herdr.sock"), nil)
}

func TestFleetHelloShowsTheConsoleInTheList(t *testing.T) {
	console := fleetTestServer(t)
	handler := console.Handler()

	hello := httptest.NewRequest(http.MethodPost, "/api/v1/fleet/hello",
		strings.NewReader(`{"id":"tw1","addr":"100.89.0.4:5000","version":"v0.3.1","platform":"linux-amd64"}`))
	hello.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, hello)
	if recorder.Code != http.StatusOK {
		t.Fatalf("hello status = %d: %s", recorder.Code, recorder.Body.String())
	}

	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/fleet", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("list status = %d", recorder.Code)
	}
	var body struct {
		Hostish  bool `json:"hub"`
		PeerList []struct {
			ID      string `json:"id"`
			Addr    string `json:"addr"`
			Version string `json:"version"`
			Stale   bool   `json:"stale"`
		} `json:"peers"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.PeerList) != 1 || body.PeerList[0].ID != "tw1" {
		t.Fatalf("peers = %+v", body.PeerList)
	}
	if body.PeerList[0].Version != "v0.3.1" || body.PeerList[0].Stale {
		t.Fatalf("peer = %+v", body.PeerList[0])
	}
	// The hub keeps the list across restarts, because a console that rebooted
	// should not have to wait for every peer to say hello again.
	raw, err := os.ReadFile(fleetStatePathOverride)
	if err != nil || !strings.Contains(string(raw), "tw1") {
		t.Fatalf("state file = %q, err = %v", raw, err)
	}
}

func TestFleetHelloRefusesAnEmptyIdentity(t *testing.T) {
	console := fleetTestServer(t)
	recorder := httptest.NewRecorder()
	console.Handler().ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/api/v1/fleet/hello",
		strings.NewReader(`{"addr":"100.89.0.4:5000"}`)))
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d", recorder.Code)
	}
}

func TestFleetFollowsANewerHubBuild(t *testing.T) {
	// The point of the fleet: upgrading the hub upgrades everybody, without
	// anybody being told to.
	current := []byte("old console")
	path := fakeExecutable(t, string(current))
	next := []byte("new console")
	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/release/version":
			_, _ = w.Write([]byte("v99.9.9\n"))
		case strings.HasSuffix(r.URL.Path, ".sha256"):
			_, _ = w.Write([]byte(checksum(next) + "  " + selfPlatform() + "\n"))
		default:
			_, _ = w.Write(next)
		}
	}))
	t.Cleanup(hub.Close)

	var restarts int
	previousRestart := fleetRestart
	fleetRestart = func() error {
		restarts++
		return nil
	}
	t.Cleanup(func() { fleetRestart = previousRestart })

	console := fleetTestServer(t)
	console.SetFleetForTest(hub.URL, "100.89.0.4:5000")

	updated, err := console.fleetFollowOnce(context.Background())
	if err != nil {
		t.Fatalf("follow: %v", err)
	}
	if !updated || restarts != 1 {
		t.Fatalf("updated = %v, restarts = %d", updated, restarts)
	}
	got, _ := os.ReadFile(path)
	if string(got) != string(next) {
		t.Fatalf("binary = %q", got)
	}

	// A second pass has nothing to do: the build is no longer newer.
	updated, err = console.fleetFollowOnce(context.Background())
	if err != nil || updated || restarts != 1 {
		t.Fatalf("second pass: updated = %v, err = %v, restarts = %d", updated, err, restarts)
	}
}

func TestFleetDoesNotFollowAnOlderHubBuild(t *testing.T) {
	// A stamped build, because "dev" is deliberately older than anything numbered.
	previousVersion := ConsoleVersion
	ConsoleVersion = "v0.3.1"
	t.Cleanup(func() { ConsoleVersion = previousVersion })
	current := []byte("current console")
	path := fakeExecutable(t, string(current))
	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("v0.0.1\n"))
	}))
	t.Cleanup(hub.Close)

	previousRestart := fleetRestart
	fleetRestart = func() error {
		// A restart here would replace a good console with a worse one.
		t.Fatal("restarted for an older build")
		return nil
	}
	t.Cleanup(func() { fleetRestart = previousRestart })

	console := fleetTestServer(t)
	console.SetFleetForTest(hub.URL, "100.89.0.4:5000")
	updated, err := console.fleetFollowOnce(context.Background())
	if err != nil || updated {
		t.Fatalf("updated = %v, err = %v", updated, err)
	}
	got, _ := os.ReadFile(path)
	if string(got) != string(current) {
		t.Fatalf("binary = %q", got)
	}
}

func TestFleetFollowIsOffWhenDisabled(t *testing.T) {
	// A console that must not move on its own says so, and the loop is not
	// started at all.
	t.Setenv("HERDR_WEB_FLEET_FOLLOW", "off")
	if fleetFollowEnabled() {
		t.Fatal("follow is enabled with HERDR_WEB_FLEET_FOLLOW=off")
	}
	t.Setenv("HERDR_WEB_FLEET_FOLLOW", "")
	if !fleetFollowEnabled() {
		t.Fatal("follow is disabled by default")
	}
}

func TestFleetStalePeersAreMarkedButKept(t *testing.T) {
	console := fleetTestServer(t)
	console.fleet.mu.Lock()
	console.fleet.peers["old"] = fleetPeer{
		ID: "old", Addr: "100.89.0.9:5000", Version: "v0.3.0",
		Seen: time.Now().Add(-fleetPeerStaleAfter - time.Minute).Unix(),
	}
	console.fleet.mu.Unlock()

	recorder := httptest.NewRecorder()
	console.Handler().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/fleet", nil))
	if !strings.Contains(recorder.Body.String(), `"stale":true`) {
		t.Fatalf("a silent peer is not marked stale: %s", recorder.Body.String())
	}
}

func TestFleetRestartMatchesTheUnitScope(t *testing.T) {
	// A root console is a system unit; asking the user manager to restart it
	// leaves the old process running the new file, which is how a fleet came to
	// report one version and run another.
	var args []string
	previous := fleetSpawn
	fleetSpawn = func(name string, argv []string) error {
		args = append([]string{name}, argv...)
		return nil
	}
	t.Cleanup(func() { fleetSpawn = previous })

	if err := fleetRestart(); err != nil {
		t.Fatalf("restart: %v", err)
	}
	switch runtime.GOOS {
	case "linux":
		want := []string{"systemctl", "--user", "restart", "dev.herdr-web"}
		if os.Getuid() == 0 {
			want = []string{"systemctl", "restart", "dev.herdr-web"}
		}
		if strings.Join(args, " ") != strings.Join(want, " ") {
			t.Fatalf("args = %v, want %v", args, want)
		}
	case "darwin":
		if len(args) == 0 || args[0] != "launchctl" || !strings.Contains(strings.Join(args, " "), "kickstart") {
			t.Fatalf("args = %v", args)
		}
	}
}
