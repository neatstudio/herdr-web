package server

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestLocalNodeIDUsesTailscale(t *testing.T) {
	dir := t.TempDir()
	script := filepath.Join(dir, "tailscale")
	body := "#!/bin/sh\nprintf '%s' '{\"Self\":{\"PublicKey\":\"nodekey:abc\"}}'\n"
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	nodeIDOnce = sync.Once{}
	nodeID = ""
	t.Cleanup(func() {
		nodeIDOnce = sync.Once{}
		nodeID = ""
	})

	if got := localNodeID(); got != "nodekey:abc" {
		t.Fatalf("node id = %q", got)
	}
}

func TestLocalNodeIDFallsBackToHostname(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	nodeIDOnce = sync.Once{}
	nodeID = ""
	t.Cleanup(func() {
		nodeIDOnce = sync.Once{}
		nodeID = ""
	})

	host, err := os.Hostname()
	if err != nil {
		t.Skip("hostname unavailable")
	}
	if got := localNodeID(); got != host {
		t.Fatalf("node id = %q, want %q", got, host)
	}
}
