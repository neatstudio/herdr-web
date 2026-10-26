package server

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// The hourly self-update check is deliberately independent of the fleet
// heartbeat. A console that is shared into another tailnet (m8s) can be reached
// by peers even though it cannot reach them; it must still update itself.
const (
	autoUpdateFirstDelayDefault = 45 * time.Second
	autoUpdateIntervalDefault   = time.Hour
)

type autoUpdateState struct {
	mu          sync.Mutex
	running     bool
	lastCheck   time.Time
	lastUpdated time.Time
	lastVersion string
	lastError   string
}

type autoUpdateStatus struct {
	Enabled        bool      `json:"enabled"`
	Eligible       bool      `json:"eligible"`
	Running        bool      `json:"running"`
	CurrentVersion string    `json:"currentVersion"`
	FirstDelay     string    `json:"firstDelay"`
	Interval       string    `json:"interval"`
	LastCheck      time.Time `json:"lastCheck,omitempty"`
	LastUpdated    time.Time `json:"lastUpdated,omitempty"`
	LastVersion    string    `json:"lastVersion,omitempty"`
	LastError      string    `json:"lastError,omitempty"`
}

// autoUpdateEnabled is the operator switch. HERDR_WEB_FLEET_FOLLOW=off keeps its
// old meaning for a development machine; HERDR_WEB_AUTO_UPDATE is the explicit
// switch for a production install.
func autoUpdateEnabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("HERDR_WEB_AUTO_UPDATE"))) {
	case "off", "0", "no", "false":
		return false
	case "on", "1", "yes", "true", "force":
		return true
	default:
		return fleetFollowEnabled()
	}
}

// autoUpdateEligible rejects a checkout binary by default. Replacing a developer
// build with a release is exactly the surprise this guard exists to prevent;
// HERDR_WEB_AUTO_UPDATE=force overrides it.
func autoUpdateEligible() bool {
	if strings.EqualFold(strings.TrimSpace(os.Getenv("HERDR_WEB_AUTO_UPDATE")), "force") {
		return true
	}
	execPath, err := selfExecutable()
	if err != nil {
		return false
	}
	if resolved, resolveErr := filepath.EvalSymlinks(execPath); resolveErr == nil {
		execPath = resolved
	}
	clean := filepath.ToSlash(execPath)
	if strings.Contains(clean, "/.local/share/herdr-web/app/herdr-web") {
		return true
	}
	home, _ := os.UserHomeDir()
	for _, candidate := range []string{
		filepath.ToSlash(filepath.Join(home, ".local", "bin", "herdr-web")),
		"/usr/local/bin/herdr-web",
		"/opt/homebrew/bin/herdr-web",
	} {
		if home != "" && clean == candidate {
			return true
		}
	}
	return false
}

func autoUpdateFirstDelay() time.Duration {
	return durationEnv("HERDR_WEB_AUTO_UPDATE_FIRST_DELAY", autoUpdateFirstDelayDefault)
}

func autoUpdateInterval() time.Duration {
	return durationEnv("HERDR_WEB_AUTO_UPDATE_INTERVAL", autoUpdateIntervalDefault)
}

func durationEnv(name string, fallback time.Duration) time.Duration {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(raw)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}

func (s *Server) autoUpdateLoop(ctx context.Context) {
	timer := time.NewTimer(autoUpdateFirstDelay())
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		if _, err := s.autoUpdateOnce(ctx); err != nil {
			fmt.Fprintf(os.Stderr, "herdr-web: auto update: %v\n", err)
		}
		timer.Reset(autoUpdateInterval())
	}
}

// autoUpdateOnce is one check. It refuses to replace/restart the binary while a
// job is running: an agent turn is not a good time to drop the console.
func (s *Server) autoUpdateOnce(ctx context.Context) (bool, error) {
	if !autoUpdateEnabled() || !autoUpdateEligible() {
		return false, nil
	}
	if s.ledger != nil && s.ledger.runningCount() > 0 {
		s.recordAutoUpdate("", "skipped: jobs are running")
		return false, nil
	}

	s.autoUpdate.mu.Lock()
	if s.autoUpdate.running {
		s.autoUpdate.mu.Unlock()
		return false, nil
	}
	s.autoUpdate.running = true
	s.autoUpdate.lastCheck = time.Now()
	s.autoUpdate.lastError = ""
	s.autoUpdate.mu.Unlock()
	defer func() {
		s.autoUpdate.mu.Lock()
		s.autoUpdate.running = false
		s.autoUpdate.mu.Unlock()
	}()

	updated, err := s.fleetFollowOnce(ctx)
	if err != nil {
		s.recordAutoUpdate("", err.Error())
		return false, err
	}
	if updated {
		s.autoUpdate.mu.Lock()
		s.autoUpdate.lastUpdated = time.Now()
		s.autoUpdate.lastVersion = ConsoleVersion
		s.autoUpdate.mu.Unlock()
	}
	return updated, nil
}

func (s *Server) recordAutoUpdate(version, failure string) {
	s.autoUpdate.mu.Lock()
	defer s.autoUpdate.mu.Unlock()
	s.autoUpdate.lastCheck = time.Now()
	if version != "" {
		s.autoUpdate.lastVersion = version
	}
	s.autoUpdate.lastError = failure
}

func (s *Server) autoUpdateSnapshot() autoUpdateStatus {
	s.autoUpdate.mu.Lock()
	defer s.autoUpdate.mu.Unlock()
	return autoUpdateStatus{
		Enabled:        autoUpdateEnabled(),
		Eligible:       autoUpdateEligible(),
		Running:        s.autoUpdate.running,
		CurrentVersion: ConsoleVersion,
		FirstDelay:     autoUpdateFirstDelay().String(),
		Interval:       autoUpdateInterval().String(),
		LastCheck:      s.autoUpdate.lastCheck,
		LastUpdated:    s.autoUpdate.lastUpdated,
		LastVersion:    s.autoUpdate.lastVersion,
		LastError:      s.autoUpdate.lastError,
	}
}

func (s *Server) handleAutoUpdateStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, "GET")
		return
	}
	writeJSON(w, http.StatusOK, s.autoUpdateSnapshot())
}

// handleSelfRestart lets an operator (or a manual-update button) start the new
// binary without waiting for the hourly loop. The response is sent before the
// process is replaced, so the caller sees an answer.
func (s *Server) handleSelfRestart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, "POST")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "restarting": true})
	go func() {
		time.Sleep(150 * time.Millisecond)
		if err := selfRestart(); err != nil {
			fmt.Fprintf(os.Stderr, "herdr-web: restart: %v\n", err)
		}
	}()
}
