package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Where an update comes from is a judgement the console can make for itself.
//
// The official source is GitHub, and on a private link it is often the one host
// that is slow or cut off. A console that is already running on a machine in the
// same network serves the same files at /release, so the sources worth trying
// are: the one that worked last time, GitHub, and the consoles reachable on the
// tailnet. The choice is remembered, so a host behind a bad link pays for one
// slow attempt instead of every one.

const (
	// selfStateDirName holds the remembered source, next to the release files.
	selfStateDirName = "herdr-web"
	// selfStateFileName is the remembered choice.
	selfStateFileName = "update-source.json"
	// selfPeerProbeTimeout is how long a peer gets to answer as a release source.
	selfPeerProbeTimeout = 2 * time.Second
	// selfPeerLimit bounds the probe: a tailnet can be large, and this is the
	// difference between a fast fallback and a scan.
	selfPeerLimit = 8
	// selfGitHubQuiet is how long a failed GitHub attempt is remembered for.
	selfGitHubQuiet = 6 * time.Hour
	// selfPeerPort is the port a console serves on.
	selfPeerPort = "5000"
)

// selfState is what the console remembers about where updates come from.
type selfState struct {
	Source string `json:"source,omitempty"`
	// GitHubFailedAt is a unix time; while it is recent the peers are tried
	// before GitHub instead of after it.
	GitHubFailedAt int64 `json:"githubFailedAt,omitempty"`
}

// selfTailnetPeers returns the addresses of tailnet peers worth probing. A seam
// so tests do not depend on a tailnet being present.
var selfTailnetPeers = discoverTailnetPeers

func selfStatePath() string {
	dir, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, ".local", "share", selfStateDirName, selfStateFileName)
}

func readSelfState() selfState {
	path := selfStatePath()
	if path == "" {
		return selfState{}
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return selfState{}
	}
	var state selfState
	if json.Unmarshal(raw, &state) != nil {
		return selfState{}
	}
	return state
}

func writeSelfState(state selfState) {
	path := selfStatePath()
	if path == "" {
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return
	}
	raw, err := json.Marshal(state)
	if err != nil {
		return
	}
	_ = os.WriteFile(path, raw, 0o644)
}

// rememberSelfSource records the source that worked, so the next update starts
// there instead of rediscovering it.
func rememberSelfSource(source string) {
	state := readSelfState()
	state.Source = source
	// The official source worked, so the memory of it failing is stale.
	if source == selfSourceURL("") {
		state.GitHubFailedAt = 0
	}
	writeSelfState(state)
}

// rememberGitHubFailure makes the peers the first choice for a while, because a
// link that just dropped a download will usually drop the next one too.
func rememberGitHubFailure() {
	state := readSelfState()
	state.GitHubFailedAt = time.Now().Unix()
	writeSelfState(state)
}

// selfCandidates lists the sources to try, best first. The caller stops at the
// first one that answers with a complete release.
func selfCandidates(ctx context.Context, explicit string, peersOnly bool) []string {
	if from := strings.TrimSpace(explicit); from != "" {
		// An explicit source is a decision, not a suggestion.
		return []string{strings.TrimRight(from, "/")}
	}
	state := readSelfState()
	seen := map[string]bool{}
	candidates := make([]string, 0, 4)
	add := func(source string) {
		source = strings.TrimRight(strings.TrimSpace(source), "/")
		if source == "" || seen[source] {
			return
		}
		seen[source] = true
		candidates = append(candidates, source)
	}

	if configured := strings.TrimSpace(os.Getenv("HERDR_WEB_RELEASE_SOURCE")); configured != "" {
		add(configured)
	}
	add(state.Source)

	official := selfSourceURL("")
	githubRecent := state.GitHubFailedAt > 0 &&
		time.Since(time.Unix(state.GitHubFailedAt, 0)) < selfGitHubQuiet

	if peersOnly {
		for _, peer := range selfTailnetPeers(ctx) {
			add(peer)
		}
		return candidates
	}
	if githubRecent {
		for _, peer := range selfTailnetPeers(ctx) {
			add(peer)
		}
		add(official)
		return candidates
	}
	add(official)
	for _, peer := range selfTailnetPeers(ctx) {
		add(peer)
	}
	return candidates
}

// discoverTailnetPeers returns release sources for consoles answering on the
// tailnet. Only peers that answer as a console are returned, and they are probed
// in parallel because each probe is a network round trip.
func discoverTailnetPeers(ctx context.Context) []string {
	raw, err := currentHostDeps().run(ctx, "tailscale", "status", "--json")
	if err != nil {
		return nil
	}
	var status struct {
		Peer map[string]struct {
			HostName     string   `json:"HostName"`
			TailscaleIPs []string `json:"TailscaleIPs"`
			Online       bool     `json:"Online"`
		} `json:"Peer"`
	}
	if json.Unmarshal(raw, &status) != nil {
		return nil
	}

	addresses := make([]string, 0, len(status.Peer))
	for _, peer := range status.Peer {
		if !peer.Online {
			continue
		}
		for _, ip := range peer.TailscaleIPs {
			parsed := net.ParseIP(ip)
			if parsed == nil || parsed.To4() == nil || !isPrivateV4(parsed) {
				continue
			}
			addresses = append(addresses, ip)
			break
		}
		if len(addresses) >= selfPeerLimit {
			break
		}
	}
	if len(addresses) == 0 {
		return nil
	}

	// Parallel, because a tailnet peer that is asleep must not cost the whole
	// list its timeout.
	var (
		wait  sync.WaitGroup
		mu    sync.Mutex
		found []string
	)
	for _, ip := range addresses {
		wait.Add(1)
		go func(ip string) {
			defer wait.Done()
			url := "http://" + net.JoinHostPort(ip, selfPeerPort)
			probeCtx, cancel := context.WithTimeout(ctx, selfPeerProbeTimeout)
			defer cancel()
			request, err := http.NewRequestWithContext(probeCtx, http.MethodGet, url+"/api/v1/herdr-web/release", nil)
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
			var release struct {
				Version string `json:"version"`
			}
			if json.NewDecoder(response.Body).Decode(&release) != nil || release.Version == "" {
				return
			}
			mu.Lock()
			found = append(found, url+"/release")
			mu.Unlock()
		}(ip)
	}
	wait.Wait()
	return found
}

// isPrivateV4 reports whether an address is inside one of the ranges a console is
// allowed to serve on: loopback, RFC1918, CGNAT (which includes Tailscale) or a
// link-local address.
func isPrivateV4(ip net.IP) bool {
	v4 := ip.To4()
	if v4 == nil {
		return false
	}
	return v4[0] == 127 ||
		(v4[0] == 10) ||
		(v4[0] == 172 && v4[1] >= 16 && v4[1] <= 31) ||
		(v4[0] == 192 && v4[1] == 168) ||
		(v4[0] == 100 && v4[1] >= 64 && v4[1] <= 127) ||
		(v4[0] == 169 && v4[1] == 254)
}

// selfSourceLabel is how a source is described in the panel.
func selfSourceLabel(source string) string {
	switch {
	case strings.Contains(source, "github.com"):
		return "github"
	case strings.Contains(source, "/release"):
		return source
	default:
		return fmt.Sprintf("%s", source)
	}
}
