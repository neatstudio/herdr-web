package server

import (
	"context"
	"crypto/sha256"
	"testing"
	"time"

	"herdr-web/server/sharedledger"
)

// testLedgerIdentity gives a server test a stable signing identity whose node id
// is the public key, matching the production ledger contract.
func testLedgerIdentity(t *testing.T, name string) sharedledger.Identity {
	t.Helper()
	seed := sha256.Sum256([]byte("server-test/" + name))
	identity, err := sharedledger.IdentityFromSeed(seed[:])
	if err != nil {
		t.Fatal(err)
	}
	return identity
}

func sharedClaim(t *testing.T, ledger sharedledger.Ledger, id string, role sharedledger.Role, identity sharedledger.Identity, version uint64, lease time.Duration) sharedledger.Task {
	t.Helper()
	signature := identity.SignOperation("claim", id, role, identity.NodeID(), version, int64(lease/time.Second), "")
	task, err := ledger.Claim(context.Background(), id, role, identity.NodeID(), lease, version, signature)
	if err != nil {
		t.Fatal(err)
	}
	return task
}
