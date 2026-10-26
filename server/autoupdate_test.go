package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func TestAutoUpdateEligibilityAndSwitches(t *testing.T) {
	t.Setenv("HERDR_WEB_AUTO_UPDATE", "")
	t.Setenv("HERDR_WEB_FLEET_FOLLOW", "")
	if !autoUpdateEnabled() {
		t.Fatal("auto update is off by default")
	}
	if autoUpdateEligible() {
		t.Fatal("a checkout binary must not auto-update by default")
	}
	t.Setenv("HERDR_WEB_AUTO_UPDATE", "force")
	if !autoUpdateEligible() {
		t.Fatal("force did not override the checkout guard")
	}
	t.Setenv("HERDR_WEB_AUTO_UPDATE", "off")
	if autoUpdateEnabled() {
		t.Fatal("HERDR_WEB_AUTO_UPDATE=off was ignored")
	}
	t.Setenv("HERDR_WEB_FLEET_FOLLOW", "off")
	t.Setenv("HERDR_WEB_AUTO_UPDATE", "")
	if autoUpdateEnabled() {
		t.Fatal("follow=off did not disable the default updater")
	}
}

func TestAutoUpdateIntervals(t *testing.T) {
	t.Setenv("HERDR_WEB_AUTO_UPDATE_FIRST_DELAY", "7s")
	t.Setenv("HERDR_WEB_AUTO_UPDATE_INTERVAL", "2h")
	if got := autoUpdateFirstDelay(); got != 7*time.Second {
		t.Fatalf("first delay = %v", got)
	}
	if got := autoUpdateInterval(); got != 2*time.Hour {
		t.Fatalf("interval = %v", got)
	}
	t.Setenv("HERDR_WEB_AUTO_UPDATE_FIRST_DELAY", "junk")
	if got := autoUpdateFirstDelay(); got != autoUpdateFirstDelayDefault {
		t.Fatalf("junk delay = %v", got)
	}
}

func TestAutoUpdateOnceInstallsAndRestarts(t *testing.T) {
	t.Setenv("HERDR_WEB_AUTO_UPDATE", "force")
	previousVersion := ConsoleVersion
	ConsoleVersion = "v0.3.1"
	t.Cleanup(func() { ConsoleVersion = previousVersion })
	current := []byte("old console")
	path := fakeExecutable(t, string(current))
	next := versionedBuild("v99.9.9", "new console")
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

	previousOfficial := selfOfficialSource
	selfOfficialSource = "http://127.0.0.1:1/release"
	t.Cleanup(func() { selfOfficialSource = previousOfficial })
	previousRestart := fleetRestart
	restarts := 0
	fleetRestart = func() error {
		restarts++
		return nil
	}
	t.Cleanup(func() { fleetRestart = previousRestart })

	console := fleetTestServer(t)
	console.SetFleetForTest(hub.URL, "100.89.0.4:5000")
	updated, err := console.autoUpdateOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !updated || restarts != 1 {
		t.Fatalf("updated = %v, restarts = %d", updated, restarts)
	}
	got, _ := os.ReadFile(path)
	if string(got) != string(next) {
		t.Fatalf("binary = %q", got)
	}
	status := console.autoUpdateSnapshot()
	if status.LastUpdated.IsZero() || status.LastError != "" {
		t.Fatalf("status = %+v", status)
	}
}

func TestAutoUpdateRefusesWhileJobsRun(t *testing.T) {
	t.Setenv("HERDR_WEB_AUTO_UPDATE", "force")
	console := fleetTestServer(t)
	console.ledger.started("", "w1", "w1:p1", "claude", "dev", "job", "")
	previousRestart := fleetRestart
	fleetRestart = func() error {
		t.Fatal("restarted while a job was running")
		return nil
	}
	t.Cleanup(func() { fleetRestart = previousRestart })

	updated, err := console.autoUpdateOnce(context.Background())
	if err != nil || updated {
		t.Fatalf("updated = %v, err = %v", updated, err)
	}
	if !strings.Contains(console.autoUpdateSnapshot().LastError, "jobs are running") {
		t.Fatalf("status = %+v", console.autoUpdateSnapshot())
	}
}

func TestAutoUpdateStatusEndpoint(t *testing.T) {
	t.Setenv("HERDR_WEB_AUTO_UPDATE", "off")
	console := fleetTestServer(t)
	recorder := httptest.NewRecorder()
	console.Handler().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/herdr-web/update/status", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), `"enabled":false`) {
		t.Fatalf("body = %s", recorder.Body.String())
	}
}
