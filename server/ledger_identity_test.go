package server

import (
	"crypto/sha256"
	"testing"

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
