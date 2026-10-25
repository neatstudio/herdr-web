package server

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"herdr-web/server/sharedledger"
)

func resetNodeIdentity() {
	nodeOnce = sync.Once{}
	nodeSigner = nil
	nodeErr = nil
}

func TestNodeIdentityUsesGeneratedKey(t *testing.T) {
	path := filepath.Join(t.TempDir(), "node.key")
	t.Setenv("HERDR_WEB_NODE_KEY", path)
	resetNodeIdentity()
	t.Cleanup(resetNodeIdentity)

	nodeID := localNodeID()
	if !strings.HasPrefix(nodeID, "ed25519:") {
		t.Fatalf("node id = %q", nodeID)
	}
	signature := signAttestation("t1", sharedledger.RoleDev, "abc", "")
	if !sharedledger.VerifyAttestation("t1", sharedledger.RoleDev, nodeID, "abc", "", signature) {
		t.Fatal("signature does not verify")
	}
	if sharedledger.VerifyAttestation("t2", sharedledger.RoleDev, nodeID, "abc", "", signature) {
		t.Fatal("signature verified for another task")
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("key mode = %o", info.Mode().Perm())
	}
}

func TestNodeIdentityKeySurvivesRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "node.key")
	t.Setenv("HERDR_WEB_NODE_KEY", path)
	resetNodeIdentity()
	t.Cleanup(resetNodeIdentity)

	first := localNodeID()
	resetNodeIdentity()
	if second := localNodeID(); second != first {
		t.Fatalf("node id changed from %q to %q", first, second)
	}
}

func TestNodeIdentityFailsClosedOnInvalidKey(t *testing.T) {
	path := filepath.Join(t.TempDir(), "node.key")
	if err := os.WriteFile(path, []byte("not a seed"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HERDR_WEB_NODE_KEY", path)
	resetNodeIdentity()
	t.Cleanup(resetNodeIdentity)

	if got := localNodeID(); got != "local" {
		t.Fatalf("node id = %q", got)
	}
	if signature := signAttestation("t1", sharedledger.RoleDev, "abc", ""); signature != "" {
		t.Fatalf("signature = %q, want empty", signature)
	}
}
