package server

import (
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"sync"
)

var (
	nodeIDOnce sync.Once
	nodeID     string
)

// localNodeID is the ledger identity. Tailscale's node public key is stable and
// already authenticated by the tailnet; hostname is the fallback when the CLI or
// daemon is unavailable.
func localNodeID() string {
	nodeIDOnce.Do(func() {
		nodeID = tailscaleNodeID()
		if nodeID == "" {
			if host, err := os.Hostname(); err == nil {
				nodeID = strings.TrimSpace(host)
			}
		}
		if nodeID == "" {
			nodeID = "local"
		}
	})
	return nodeID
}

func tailscaleNodeID() string {
	binary, err := exec.LookPath("tailscale")
	if err != nil {
		return ""
	}
	output, err := exec.Command(binary, "status", "--json").Output()
	if err != nil {
		return ""
	}
	var status struct {
		Self struct {
			PublicKey string `json:"PublicKey"`
			ID        string `json:"ID"`
		} `json:"Self"`
	}
	if json.Unmarshal(output, &status) != nil {
		return ""
	}
	if key := strings.TrimSpace(status.Self.PublicKey); key != "" {
		return key
	}
	return strings.TrimSpace(status.Self.ID)
}
