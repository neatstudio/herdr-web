package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// A fleet is a set of consoles that know each other. It has no leader.
//
// The first version of this had a hub: one machine everything reported to and
// took its build from. That is a single point of failure in a set of machines
// whose whole value is being reachable when one of them is not, so membership is
// exchanged instead of collected: a console keeps its own list, says hello to its
// seeds and to a few peers it already knows, and merges whatever list comes back.
// Losing any machine costs the others nothing but that machine's row, and a
// console with no seeds at all still works — it simply knows only itself.
//
// The same reasoning decides where a build may come from: any console running a
// strictly newer build is a source, not just the one that was designated. A
// hostile or broken console cannot forge a build, because the checksum is
// verified, and it cannot talk the fleet backwards, because only newer builds are
// adopted.
const (
	// fleetHeartbeatInterval is how often a console exchanges lists with peers.
	fleetHeartbeatInterval = 30 * time.Second
	// fleetFollowInterval is how often a console looks for a newer build.
	fleetFollowInterval = 3 * time.Minute
	// fleetPeerStaleAfter is when a peer that stopped reporting shows as stale.
	fleetPeerStaleAfter = 3 * time.Minute
	// fleetPeerForgetAfter is when a silent peer is dropped from the list. Long,
	// because a machine that is merely off should not have to be rediscovered.
	fleetPeerForgetAfter = 7 * 24 * time.Hour
	// fleetExchangePeers bounds the gossip fan-out per beat: a tailnet is small,
	// but a heartbeat must not become a broadcast storm.
	fleetExchangePeers = 3
	// fleetPeerLimit bounds the list a console keeps.
	fleetPeerLimit = 64
	// fleetStateFileName is where the list is kept across restarts.
	fleetStateFileName = "fleet.json"
)

// fleetPeer is what a console says about itself.
type fleetPeer struct {
	ID       string `json:"id"`
	Addr     string `json:"addr"`
	Version  string `json:"version"`
	Platform string `json:"platform"`
	// Agents are the agent kinds this machine can start. A job has to run where
	// its agent exists, and that is not the same machine everywhere.
	Agents []string `json:"agents"`
	// What this machine can offer a task market: its operator-set concurrency
	// cap, what it is running now, the tools on PATH and the models it declares.
	MaxTasks int      `json:"maxTasks,omitempty"`
	Running  int      `json:"running,omitempty"`
	Tools    []string `json:"tools,omitempty"`
	Models   []string `json:"models,omitempty"`
	// Seen is unix seconds; each console stamps what it hears with its own clock,
	// which is enough for a list whose only question is "has this gone quiet".
	Seen int64 `json:"seen"`
}

// fleetState is this console's view of the fleet.
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
		if peer.ID != "" && peer.ID != s.fleetSelfID() {
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

// defaultFleetSeeds and defaultFleetAddr are configured once in main.
var (
	defaultFleetSeeds []string
	defaultFleetAddr  string
)

// SetFleet names the consoles this one starts from and the address it reports.
// Seeds are an entry point, not an authority: once a console has heard from one
// seed it knows the rest of the fleet by itself.
func SetFleet(seeds, addr string) {
	defaultFleetSeeds = parseFleetSeeds(seeds)
	defaultFleetAddr = strings.TrimSpace(addr)
}

// parseFleetSeeds reads a comma- or space-separated list of console URLs.
func parseFleetSeeds(raw string) []string {
	seeds := make([]string, 0, 4)
	for _, field := range strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == ' ' || r == '\t' || r == '\n'
	}) {
		seed := fleetBase(field)
		if seed != "" {
			seeds = append(seeds, seed)
		}
	}
	return seeds
}

// SetFleetForTest points this console at seeds; only a test needs it.
func (s *Server) SetFleetForTest(seeds, addr string) {
	s.fleetSeeds = parseFleetSeeds(seeds)
	s.fleetAddr = strings.TrimSpace(addr)
}

// fleetBase strips the release suffix from a console URL.
func fleetBase(url string) string {
	return strings.TrimSuffix(strings.TrimRight(strings.TrimSpace(url), "/"), "/release")
}

// fleetFollowEnabled reports whether this console may take a newer build on its
// own. The machine a console is developed on turns this off.
func fleetFollowEnabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("HERDR_WEB_FLEET_FOLLOW"))) {
	case "off", "0", "no", "false":
		return false
	default:
		return true
	}
}

// StartFleet begins the exchange and the follow loop. Both stop with ctx.
func (s *Server) StartFleet(ctx context.Context) {
	if !s.tailnetFacing {
		// A loopback-only console is an entry point of one. It updates from the
		// official source or an explicit source; it does not touch the tailnet.
		return
	}
	s.loadFleet()
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

// fleetConsoleURLs lists the consoles to look for when this one knows nobody. A
// seam, so a test can put a console at a URL it controls.
var fleetConsoleURLs = func(ctx context.Context) []string {
	addresses := tailnetConsoles(ctx)
	urls := make([]string, 0, len(addresses))
	for _, ip := range addresses {
		urls = append(urls, "http://"+net.JoinHostPort(ip, selfPeerPort))
	}
	return urls
}

// fleetDiscoverOnce looks for consoles on the tailnet.
//
// Seeds are an entry point, and an entry point that is gone must not stop a console
// from joining: any console that answers /api/v1/fleet can introduce the rest. This
// is what makes the fleet self-forming rather than dependent on one advertised
// address surviving.
func (s *Server) fleetDiscoverOnce(ctx context.Context) int {
	addresses := fleetConsoleURLs(ctx)
	if len(addresses) == 0 {
		return 0
	}
	var (
		wait  sync.WaitGroup
		mu    sync.Mutex
		found int
	)
	for _, ip := range addresses {
		wait.Add(1)
		go func(ip string) {
			defer wait.Done()
			probeCtx, cancel := context.WithTimeout(ctx, selfPeerProbeTimeout)
			defer cancel()
			request, err := http.NewRequestWithContext(probeCtx, http.MethodGet,
				strings.TrimRight(ip, "/")+"/api/v1/fleet", nil)
			if err != nil {
				return
			}
			response, err := selfClient.Do(request)
			if err != nil {
				return
			}
			defer func() { _ = response.Body.Close() }()
			if response.StatusCode != http.StatusOK {
				return
			}
			var answer struct {
				Self  fleetPeer   `json:"self"`
				Peers []fleetPeer `json:"peers"`
			}
			if json.NewDecoder(response.Body).Decode(&answer) != nil {
				return
			}
			if answer.Self.ID == "" {
				return
			}
			s.mergeFleet(append([]fleetPeer{answer.Self}, answer.Peers...))
			mu.Lock()
			found++
			mu.Unlock()
		}(ip)
	}
	wait.Wait()
	return found
}

// fleetSelfPeer is what this console tells others about itself.
func (s *Server) fleetSelfPeer() fleetPeer {
	return fleetPeer{
		ID:       s.fleetSelfID(),
		Addr:     s.fleetAddr,
		Version:  ConsoleVersion,
		Platform: runtime.GOOS + "-" + runtime.GOARCH,
		Agents:   selfAgentKinds(),
		MaxTasks: maxJobs(),
		Running:  s.ledger.runningCount(),
		Tools:    selfTools(),
		Models:   selfModels(),
		Seen:     time.Now().Unix(),
	}
}

// fleetSelfID is stable across restarts, so a re-addressed console updates its
// own row instead of adding another.
func (s *Server) fleetSelfID() string {
	host, err := os.Hostname()
	if err != nil || strings.TrimSpace(host) == "" {
		host = "console"
	}
	return strings.TrimSpace(host)
}

// fleetTargets is who to say hello to: the seeds, then a few known peers.
func (s *Server) fleetTargets() []string {
	seen := map[string]bool{}
	targets := make([]string, 0, len(s.fleetSeeds)+fleetExchangePeers)
	add := func(url string) {
		base := fleetBase(url)
		if base == "" || seen[base] {
			return
		}
		seen[base] = true
		targets = append(targets, base)
	}
	for _, seed := range s.fleetSeeds {
		add(seed)
	}

	s.fleet.mu.Lock()
	known := make([]string, 0, len(s.fleet.peers))
	self := s.fleetSelfID()
	for id, peer := range s.fleet.peers {
		if id == self || peer.Addr == "" {
			continue
		}
		known = append(known, "http://"+peer.Addr)
	}
	s.fleet.mu.Unlock()

	// A random few, so a large fleet does not cost every console every peer.
	rand.Shuffle(len(known), func(left, right int) { known[left], known[right] = known[right], known[left] })
	for index, url := range known {
		if index >= fleetExchangePeers {
			break
		}
		add(url)
	}
	return targets
}

// fleetHeartbeat exchanges lists with the targets. Each answer carries the
// target's view, which is how a console learns about machines it has never
// spoken to directly.
func (s *Server) fleetHeartbeat(ctx context.Context) {
	// A console that knows nobody has no one to say hello to. Rather than waiting
	// for a seed that may never come back, it looks around: the fleet is the set of
	// consoles that answer, not the set that was configured.
	if s.fleetPeerCount() == 0 {
		s.fleetDiscoverOnce(ctx)
	}
	payload, err := json.Marshal(s.fleetSelfPeer())
	if err != nil {
		return
	}
	for _, target := range s.fleetTargets() {
		s.fleetExchange(ctx, target, payload)
	}
}

func (s *Server) fleetExchange(ctx context.Context, target string, payload []byte) {
	requestCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodPost,
		target+"/api/v1/fleet/hello", bytes.NewReader(payload))
	if err != nil {
		return
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := selfClient.Do(request)
	if err != nil {
		return
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return
	}
	var answer struct {
		Peers []fleetPeer `json:"peers"`
	}
	if json.NewDecoder(response.Body).Decode(&answer) != nil {
		return
	}
	s.mergeFleet(answer.Peers)
}

// pruneFleetLocked keeps one row per address.
//
// Rows can collide on an address when a machine changes its name or when an old
// observation keeps circulating, and picking by timestamp alone is wrong: clocks
// differ across a tailnet by more than the interval between two observations. The
// newer build wins, because a build number is the same on every clock, and only
// then the newer observation.
func (s *Server) pruneFleetLocked(now int64) {
	byAddr := map[string]string{}
	for id, peer := range s.fleet.peers {
		if peer.Addr == "" {
			continue
		}
		best, found := byAddr[peer.Addr]
		if !found {
			byAddr[peer.Addr] = id
			continue
		}
		other := s.fleet.peers[best]
		switch {
		case selfNewer(peer.Version, other.Version):
			delete(s.fleet.peers, best)
			byAddr[peer.Addr] = id
		case selfNewer(other.Version, peer.Version):
			delete(s.fleet.peers, id)
		case peer.Seen > other.Seen:
			delete(s.fleet.peers, best)
			byAddr[peer.Addr] = id
		default:
			delete(s.fleet.peers, id)
		}
	}
	_ = now
}

// mergeFleet takes the newest observation of every peer, never its own row, and
// forgets machines that have been silent for a week.
func (s *Server) mergeFleet(incoming []fleetPeer) {
	now := time.Now().Unix()
	self := s.fleetSelfID()

	s.fleet.mu.Lock()
	defer s.fleet.mu.Unlock()
	for _, peer := range incoming {
		if peer.ID == "" || peer.ID == self {
			continue
		}
		if peer.Seen == 0 {
			peer.Seen = now
		}
		if existing, found := s.fleet.peers[peer.ID]; found && existing.Seen > peer.Seen {
			continue
		}
		s.fleet.peers[peer.ID] = peer
	}
	s.pruneFleetLocked(now)
	for id, peer := range s.fleet.peers {
		if now-peer.Seen > int64(fleetPeerForgetAfter/time.Second) {
			delete(s.fleet.peers, id)
		}
	}
	// A list is a cache, so the cheapest way to bound it is to drop the oldest.
	if len(s.fleet.peers) > fleetPeerLimit {
		oldestID, oldestSeen := "", int64(1<<62)
		for id, peer := range s.fleet.peers {
			if peer.Seen < oldestSeen {
				oldestID, oldestSeen = id, peer.Seen
			}
		}
		if oldestID != "" {
			delete(s.fleet.peers, oldestID)
		}
	}
	s.saveFleetLocked()
}

// fleetPeerCount is how many consoles this one knows right now.
func (s *Server) fleetPeerCount() int {
	s.fleet.mu.Lock()
	defer s.fleet.mu.Unlock()
	return len(s.fleet.peers)
}

func (s *Server) fleetFollowLoop(ctx context.Context) {
	ticker := time.NewTicker(fleetFollowInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if _, err := s.fleetFollowOnce(ctx); err != nil {
				fmt.Fprintf(os.Stderr, "herdr-web: fleet follow: %v\n", err)
			}
		}
	}
}

// fleetSources lists the consoles that might publish a newer build, best first:
// a peer that already reported a newer version, then the seeds, then the official
// release. Any console can publish, which is what makes the loss of one of them
// survivable.
func (s *Server) fleetSources() []selfCandidate {
	s.fleet.mu.Lock()
	peers := make([]fleetPeer, 0, len(s.fleet.peers))
	for _, peer := range s.fleet.peers {
		peers = append(peers, peer)
	}
	s.fleet.mu.Unlock()

	candidates := make([]selfCandidate, 0, len(peers)+len(s.fleetSeeds)+1)
	seen := map[string]bool{}
	add := func(url, version string) {
		base := fleetBase(url)
		if base == "" || seen[base] {
			return
		}
		seen[base] = true
		candidates = append(candidates, selfCandidate{Source: base + "/release", Version: version})
	}

	// Newest reported version first: the peer that is ahead is the best guess at
	// where the current build is.
	sortFleetPeers(peers)
	for _, peer := range peers {
		if peer.Addr == "" {
			continue
		}
		add("http://"+peer.Addr, peer.Version)
	}
	for _, seed := range s.fleetSeeds {
		add(seed, "")
	}
	// The official source is not a console: its URL has no /release suffix, and
	// treating it like one turned it into a dispatch target.
	official := selfSourceURL("")
	if !seen[official] {
		candidates = append(candidates, selfCandidate{Source: official, Version: selfOfficialVersion(context.Background())})
	}
	return candidates
}

// fleetConsoles lists the machines this console can dispatch work to: peers and
// seeds, never the release host.
func (s *Server) fleetConsoles() []string {
	consoles := make([]string, 0, len(s.fleetSeeds)+4)
	seen := map[string]bool{}
	add := func(url string) {
		base := fleetBase(url)
		if base == "" || seen[base] {
			return
		}
		seen[base] = true
		consoles = append(consoles, base)
	}
	s.fleet.mu.Lock()
	peers := make([]fleetPeer, 0, len(s.fleet.peers))
	for _, peer := range s.fleet.peers {
		peers = append(peers, peer)
	}
	s.fleet.mu.Unlock()
	sortFleetPeers(peers)
	for _, peer := range peers {
		if peer.Addr != "" {
			add("http://" + peer.Addr)
		}
	}
	for _, seed := range s.fleetSeeds {
		add(seed)
	}
	return consoles
}

// fleetFollowOnce takes the newest build any source publishes, if it is newer
// than this one. Nothing is pushed to anyone: a console that is asleep or behind
// a relay simply does not follow until it can.
func (s *Server) fleetFollowOnce(ctx context.Context) (bool, error) {
	execPath, err := selfExecutable()
	if err != nil {
		return false, err
	}
	execPath, err = filepath.EvalSymlinks(execPath)
	if err != nil {
		return false, err
	}

	// Best first, and stop at the first source that provides a verified, newer
	// build: the rest are only fallbacks.
	candidates := s.fleetSources()
	var lastErr error
	for _, candidate := range candidates {
		attemptCtx, cancel := context.WithTimeout(ctx, selfSourceTimeout)
		published := mustSelfText(attemptCtx, candidate.Source+"/version")
		if strings.TrimSpace(published) == "" || !selfNewer(strings.TrimSpace(published), ConsoleVersion) {
			cancel()
			continue
		}
		result, updateErr := selfUpdateFrom(attemptCtx, execPath, candidate.Source)
		cancel()
		if updateErr != nil {
			lastErr = updateErr
			continue
		}
		if !result.Updated {
			return false, nil
		}
		fmt.Fprintf(os.Stderr, "herdr-web: following %s: installed %s, restarting\n",
			fleetBase(candidate.Source), strings.TrimSpace(published))
		if err := fleetRestart(); err != nil {
			return true, fmt.Errorf("installed %s but could not restart: %w", strings.TrimSpace(published), err)
		}
		return true, nil
	}
	if lastErr != nil {
		return false, lastErr
	}
	return false, nil
}

// fleetSpawn is the detached-start seam: a test records the command instead of
// starting a service manager.
var fleetSpawn = spawnDetached

// fleetRestart starts the new binary through the service manager, which is the
// only thing that can restart the process serving this request.
//
// The scope has to match the unit that is actually running: a root console is
// registered as a system unit, and asking the user manager to restart it fails
// while the files on disk are already the new build — which is how a fleet ends
// up reporting one version and running another.
var fleetRestart = func() error {
	switch runtime.GOOS {
	case "linux":
		if os.Getuid() == 0 {
			return fleetSpawn("systemctl", []string{"restart", "dev.herdr-web"})
		}
		return fleetSpawn("systemctl", []string{"--user", "restart", "dev.herdr-web"})
	case "darwin":
		return fleetSpawn("launchctl", []string{"kickstart", "-k", "gui/" + currentUID() + "/dev.herdr-web"})
	default:
		return errors.New("no service manager")
	}
}

func currentUID() string {
	return fmt.Sprintf("%d", os.Getuid())
}

// handleFleetHello records a console and answers with this console's own view,
// so the caller learns machines it has not met. Every console serves this; there
// is no privileged one.
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
	if peer.ID != s.fleetSelfID() {
		s.fleet.mu.Lock()
		s.fleet.peers[peer.ID] = peer
		s.saveFleetLocked()
		s.fleet.mu.Unlock()
	}

	s.fleet.mu.Lock()
	view := make([]fleetPeer, 0, len(s.fleet.peers)+1)
	view = append(view, s.fleetSelfPeer())
	for _, known := range s.fleet.peers {
		view = append(view, known)
	}
	s.fleet.mu.Unlock()
	sortFleetPeers(view)

	writeJSON(w, http.StatusOK, map[string]any{
		"ok":    true,
		"self":  s.fleetSelfPeer(),
		"peers": view,
	})
}

// handleFleet reports the fleet as this console sees it.
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
		agents := peer.Agents
		if agents == nil {
			agents = []string{}
		}
		tools := peer.Tools
		if tools == nil {
			tools = []string{}
		}
		models := peer.Models
		if models == nil {
			models = []string{}
		}
		out = append(out, map[string]any{
			"id":       peer.ID,
			"addr":     peer.Addr,
			"version":  peer.Version,
			"platform": peer.Platform,
			"agents":   agents,
			"maxTasks": peer.MaxTasks,
			"running":  peer.Running,
			"tools":    tools,
			"models":   models,
			"seen":     peer.Seen,
			"stale":    now-peer.Seen > int64(fleetPeerStaleAfter/time.Second),
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"self": s.fleetSelfPeer(),
		// No seeds means this console was started as the entry point; it is a
		// convenience, not a role.
		"hub":    len(s.fleetSeeds) == 0,
		"seeds":  s.fleetSeeds,
		"follow": s.tailnetFacing && fleetFollowEnabled(),
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
