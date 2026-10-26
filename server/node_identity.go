package server

import (
	"crypto/ed25519"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"herdr-web/server/sharedledger"
)

var (
	nodeOnce   sync.Once
	nodeSigner *sharedledger.Identity
	nodeErr    error
)

// nodeIdentity is this node's signing key. The public key is the node id, so an
// attestation can be verified by any peer without a separate key registry.
//
// The key lives next to the durable job state and is created on first use with
// mode 0600. HERDR_WEB_NODE_KEY overrides the path for tests and for operators
// who keep keys outside their home directory.
func nodeIdentity() (*sharedledger.Identity, error) {
	nodeOnce.Do(func() {
		seed, err := loadOrCreateNodeSeed(nodeKeyPath())
		if err != nil {
			nodeErr = err
			return
		}
		identity, err := sharedledger.IdentityFromSeed(seed)
		if err != nil {
			nodeErr = err
			return
		}
		nodeSigner = &identity
	})
	return nodeSigner, nodeErr
}

func localNodeID() string {
	identity, err := nodeIdentity()
	if err != nil || identity == nil {
		// Fail closed for attestations: no signature is produced with a missing
		// key, and the ledger rejects an empty signature.
		return "local"
	}
	return identity.NodeID()
}

func signLedgerOperation(op, taskID string, role sharedledger.Role, version uint64, lease time.Duration, reason string) string {
	identity, err := nodeIdentity()
	if err != nil || identity == nil {
		return ""
	}
	return identity.SignOperation(op, taskID, role, identity.NodeID(), version, int64(lease/time.Second), reason)
}

func signAttestation(taskID string, role sharedledger.Role, commit, digest string) string {
	identity, err := nodeIdentity()
	if err != nil || identity == nil {
		return ""
	}
	return identity.Sign(taskID, role, commit, digest)
}

func nodeKeyPath() string {
	if path := strings.TrimSpace(os.Getenv("HERDR_WEB_NODE_KEY")); path != "" {
		return path
	}
	dir := jobStateDir()
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, "node.key")
}

func loadOrCreateNodeSeed(path string) ([]byte, error) {
	if path == "" {
		return nil, fmt.Errorf("node key path is unavailable")
	}
	if data, err := os.ReadFile(path); err == nil {
		seed, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(string(data)))
		if err != nil || len(seed) != ed25519.SeedSize {
			return nil, fmt.Errorf("node key %s is invalid", path)
		}
		return seed, nil
	} else if !os.IsNotExist(err) {
		return nil, err
	}

	identity, err := sharedledger.NewIdentity()
	if err != nil {
		return nil, err
	}
	seed := identity.Seed()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	encoded := base64.RawURLEncoding.EncodeToString(seed) + "\n"
	if err := os.WriteFile(path, []byte(encoded), 0o600); err != nil {
		// A concurrent process may have created the key first. Read that key
		// rather than overwriting another node's identity.
		if data, readErr := os.ReadFile(path); readErr == nil {
			existing, decodeErr := base64.RawURLEncoding.DecodeString(strings.TrimSpace(string(data)))
			if decodeErr == nil && len(existing) == ed25519.SeedSize {
				return existing, nil
			}
		}
		return nil, err
	}
	return seed, nil
}
