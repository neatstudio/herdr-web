package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// A fleet is one hub and the consoles that follow it.
//
// The hub is a console like any other; the only difference is that it is the one
// the others name. Every console says hello to it on a timer, and every console
// asks it, on a longer timer, whether a newer build has been published. Nothing
// is pushed at anyone: a console that is asleep, offline or behind a relay simply
// misses a heartbeat and catches up on the next one, which is the behaviour a
// push-based broadcast cannot offer on a tailnet that drops.
const (
	// fleetHeartbeatInterval is how often a console says hello to the hub.
	fleetHeartbeatInterval = 30 * time.Second
	// fleetFollowInterval is how often a console asks whether the hub has a
	// newer build. Long enough to be invisible, short enough that an operator
	// who upgrades the hub sees the fleet follow within one coffee.
	fleetFollowInterval = 3 * time.Minute
	// fleetPeerStaleAfter is when a peer that stopped reporting is shown as
	// stale instead of present.
	fleetPeerStaleAfter = 3 * time.Minute
	// fleetStateFileName is where the hub keeps the list across restarts.
	fleetStateFileName = "fleet.json"
)

// fleetPeer is what a console says about itself.
type fleetPeer struct {
	ID       string `json:"id"`
	Addr     string `json:"addr"`
	Version  string `json:"version"`
	Platform string `json:"platform"`
	// Seen is unix seconds, set by the hub when the peer last said hello.
	Seen int64 `json:"seen"`
}

// fleetState is the hub's peer list.
type fleetState struct {
	mu    sync.Mutex
	peers map[string]fleetPeer
}

// fleetStatePathOverride keeps a test's fleet file out of the operator's home.
var fleetStatePathOverride string

func fleetStatePath() string {
	if fleetStatePathOverride != "" {
		return fleetStatePathOverride
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".local", "share", selfStateDirName, fleetStateFileName)
}

func (s *Server) loadFleet() {
	path := fleetStatePath()
	if path == "" {
		return
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var stored struct {
		Peers []fleetPeer `json:"peers"`
	}
	if json.Unmarshal(raw, &stored) != nil {
		return
	}
	s.fleet.mu.Lock()
	defer s.fleet.mu.Unlock()
	for _, peer := range stored.Peers {
		if peer.ID != "" {
			s.fleet.peers[peer.ID] = peer
		}
	}
}

func (s *Server) saveFleetLocked() {
	path := fleetStatePath()
	if path == "" {
		return
	}
	peers := make([]fleetPeer, 0, len(s.fleet.peers))
	for _, peer := range s.fleet.peers {
		peers = append(peers, peer)
	}
	raw, err := json.Marshal(struct {
		Peers []fleetPeer `json:"peers"`
	}{Peers: peers})
	if err != nil || os.MkdirAll(filepath.Dir(path), 0o755) != nil {
		return
	}
	_ = os.WriteFile(path, raw, 0o644)
}

// defaultFleetHub and defaultFleetAddr are what main configures once, the same
// way the other process-wide settings are set.
var (
	defaultFleetHub  string
	defaultFleetAddr string
)

// SetFleet names the hub this console follows, and the address it reports as its
// own. An empty hub means this console is the hub.
func SetFleet(hub, addr string) {
	defaultFleetHub = strings.TrimRight(strings.TrimSpace(hub), "/")
	defaultFleetAddr = strings.TrimSpace(addr)
}

// SetFleetForTest points this console at a hub. Only a test needs this: in the
// process it is SetFleet, called once before the server exists.
func (s *Server) SetFleetForTest(hub, addr string) {
	s.fleetHub = strings.TrimRight(strings.TrimSpace(hub), "/")
	s.fleetAddr = strings.TrimSpace(addr)
}

// fleetHubBase is the hub without its release suffix.
func (s *Server) fleetHubBase() string {
	hub := strings.TrimRight(s.fleetHub, "/")
	return strings.TrimSuffix(hub, "/release")
}

// fleetFollowEnabled reports whether this console should take the hub's build.
func fleetFollowEnabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("HERDR_WEB_FLEET_FOLLOW"))) {
	case "off", "0", "no", "false":
		return false
	default:
		return true
	}
}

// StartFleet begins the heartbeats and the follow loop. It returns immediately;
// both loops stop when ctx is cancelled.
func (s *Server) StartFleet(ctx context.Context) {
	s.loadFleet()
	if s.fleetHub == "" {
		// This console is the hub: it collects, and follows nobody.
		return
	}
	go s.fleetHeartbeatLoop(ctx)
	if fleetFollowEnabled() {
		go s.fleetFollowLoop(ctx)
	}
}

func (s *Server) fleetHeartbeatLoop(ctx context.Context) {
	// Say hello immediately: a console that just started should not be invisible
	// for a whole interval.
	s.fleetHeartbeat(ctx)
	ticker := time.NewTicker(fleetHeartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.fleetHeartbeat(ctx)
		}
	}
}

func (s *Server) fleetHeartbeat(ctx context.Context) {
	hub := s.fleetHubBase()
	if hub == "" {
		return
	}
	payload, err := json.Marshal(fleetPeer{
		ID:       s.fleetSelfID(),
		Addr:     s.fleetAddr,
		Version:  ConsoleVersion,
		Platform: runtime.GOOS + "-" + runtime.GOARCH,
	})
	if err != nil {
		return
	}
	requestCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodPost, hub+"/api/v1/fleet/hello", bytes.NewReader(payload))
	if err != nil {
		return
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := selfClient.Do(request)
	if err != nil {
		return
	}
	_ = response.Body.Close()
}

// fleetSelfID is stable across restarts: the host name, so a re-addressed console
// updates its own row instead of adding another.
func (s *Server) fleetSelfID() string {
	host, err := os.Hostname()
	if err != nil || strings.TrimSpace(host) == "" {
		host = "console"
	}
	return strings.TrimSpace(host)
}

func (s *Server) fleetFollowLoop(ctx context.Context) {
	ticker := time.NewTicker(fleetFollowInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.fleetFollowOnce(ctx)
		}
	}
}

// fleetFollowOnce takes the hub's build when it is newer than this one.
func (s *Server) fleetFollowOnce(ctx context.Context) (bool, error) {
	hub := s.fleetHubBase()
	if hub == "" {
		return false, errors.New("this console is the hub")
	}
	versionText := mustSelfText(ctx, hub+"/release/version")
	version := strings.TrimSpace(versionText)
	if version == "" {
		return false, fmt.Errorf("the hub %s did not say which version it runs", hub)
	}
	if !selfNewer(version, ConsoleVersion) {
		return false, nil
	}
	execPath, err := selfExecutable()
	if err != nil {
		return false, err
	}
	execPath, err = filepath.EvalSymlinks(execPath)
	if err != nil {
		return false, err
	}
	// The hub is the source, and the checksum is verified exactly as it is for an
	// operator pressing the button.
	result, err := selfUpdateFrom(ctx, execPath, hub+"/release")
	if err != nil {
		return false, err
	}
	if !result.Updated {
		return false, nil
	}
	fmt.Fprintf(os.Stderr, "herdr-web: following the hub %s: installed %s, restarting\n", hub, version)
	if err := fleetRestart(); err != nil {
		return true, fmt.Errorf("installed %s but could not restart: %w", version, err)
	}
	return true, nil
}

// fleetRestart starts the new binary through the service manager, which is the
// only thing that can restart the process serving this request.
var fleetRestart = func() error {
	switch runtime.GOOS {
	case "linux":
		return spawnDetached("systemctl", []string{"--user", "restart", "dev.herdr-web"})
	case "darwin":
		return spawnDetached("launchctl", []string{"kickstart", "-k", "gui/" + currentUID() + "/dev.herdr-web"})
	default:
		return errors.New("no service manager")
	}
}

func currentUID() string {
	return fmt.Sprintf("%d", os.Getuid())
}

// handleFleetHello records a console that said hello. It is what the hub is for.
func (s *Server) handleFleetHello(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, "POST")
		return
	}
	var peer fleetPeer
	if !decodeBody(w, r, &peer) {
		return
	}
	peer.ID = strings.TrimSpace(peer.ID)
	if peer.ID == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "id is required")
		return
	}
	peer.Seen = time.Now().Unix()
	s.fleet.mu.Lock()
	s.fleet.peers[peer.ID] = peer
	s.saveFleetLocked()
	s.fleet.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"hub":     true,
		"version": ConsoleVersion,
		"follow":  fleetFollowEnabled(),
	})
}

// handleFleet reports the fleet as this console sees it: who is in it, which
// build each runs, and whether the hub is what this console follows.
func (s *Server) handleFleet(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, "GET")
		return
	}
	now := time.Now().Unix()
	s.fleet.mu.Lock()
	peers := make([]fleetPeer, 0, len(s.fleet.peers))
	for _, peer := range s.fleet.peers {
		peers = append(peers, peer)
	}
	s.fleet.mu.Unlock()
	sortFleetPeers(peers)

	out := make([]map[string]any, 0, len(peers))
	for _, peer := range peers {
		out = append(out, map[string]any{
			"id":       peer.ID,
			"addr":     peer.Addr,
			"version":  peer.Version,
			"platform": peer.Platform,
			"seen":     peer.Seen,
			"stale":    now-peer.Seen > int64(fleetPeerStaleAfter/time.Second),
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"self": map[string]any{
			"id":       s.fleetSelfID(),
			"addr":     s.fleetAddr,
			"version":  ConsoleVersion,
			"platform": runtime.GOOS + "-" + runtime.GOARCH,
		},
		"hub":    s.fleetHub != "",
		"hubUrl": s.fleetHubBase(),
		"follow": fleetFollowEnabled(),
		"peers":  out,
	})
}

// sortFleetPeers orders by address so the list does not reshuffle between reads.
func sortFleetPeers(peers []fleetPeer) {
	for index := 1; index < len(peers); index++ {
		for back := index; back > 0 && peers[back].Addr < peers[back-1].Addr; back-- {
			peers[back], peers[back-1] = peers[back-1], peers[back]
		}
	}
}
