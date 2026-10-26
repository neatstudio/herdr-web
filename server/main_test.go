package server

import (
	"os"
	"path/filepath"
	"testing"
)

// TestMain keeps the durable ledger and task board out of the operator's home.
// Tests that need the files isolated further call isolateState.
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "herdr-web-test-state-")
	if err != nil {
		os.Exit(m.Run())
	}
	ledgerPathOverride = filepath.Join(dir, "ledger.jsonl")
	dispatchStatePathOverride = filepath.Join(dir, "dispatch.json")
	_ = os.Setenv("HERDR_WEB_NODE_KEY", filepath.Join(dir, "node.key"))
	_ = os.Setenv("HERDR_WEB_ALLOWED_TOKEN_ENVS", "TEST_GITHUB_TOKEN,TEST_GITEA_TOKEN")
	// Tests must not depend on how busy the machine running them is.
	readHostResources = func() hostResources {
		return hostResources{CPUs: 4, MemTotalMB: 8192, MemAvailableMB: 4096}
	}
	code := m.Run()
	_ = os.RemoveAll(dir)
	os.Exit(code)
}
