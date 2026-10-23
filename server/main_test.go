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
	code := m.Run()
	_ = os.RemoveAll(dir)
	os.Exit(code)
}
