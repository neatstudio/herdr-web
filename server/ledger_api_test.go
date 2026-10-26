package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"herdr-web/server/sharedledger"
)

func TestLedgerWriteAPI(t *testing.T) {
	isolateState(t)
	console := NewServer("", nil)
	handler := console.Handler()

	create := do(t, handler, http.MethodPost, "/api/v1/ledger/tasks", `{"id":"t1","prompt":"x"}`)
	if create.Code != http.StatusCreated {
		t.Fatalf("create = %d: %s", create.Code, create.Body.String())
	}
	var created struct {
		Task sharedledger.Task `json:"task"`
	}
	if err := json.Unmarshal(create.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.Task.State != sharedledger.Proposed || created.Task.Version != 1 {
		t.Fatalf("created = %+v", created.Task)
	}

	dev := testLedgerIdentity(t, "node-a")
	claimSignature := dev.SignOperation("claim", "t1", sharedledger.RoleDev, dev.NodeID(), 1, 60, "")
	claim := do(t, handler, http.MethodPost, "/api/v1/ledger/tasks/t1/claim",
		fmt.Sprintf(`{"role":"dev","node":%q,"leaseSeconds":60,"version":1,"signature":%q}`, dev.NodeID(), claimSignature))
	if claim.Code != http.StatusOK {
		t.Fatalf("claim = %d: %s", claim.Code, claim.Body.String())
	}
	var claimed struct {
		Task sharedledger.Task `json:"task"`
	}
	if err := json.Unmarshal(claim.Body.Bytes(), &claimed); err != nil {
		t.Fatal(err)
	}
	if claimed.Task.State != sharedledger.DevClaimed || claimed.Task.Owner != dev.NodeID() {
		t.Fatalf("claimed = %+v", claimed.Task)
	}

	conflict := do(t, handler, http.MethodPost, "/api/v1/ledger/tasks/t1/claim",
		`{"role":"dev","node":"node-b","leaseSeconds":60,"version":1}`)
	if conflict.Code != http.StatusConflict {
		t.Fatalf("conflict = %d: %s", conflict.Code, conflict.Body.String())
	}

	attest := do(t, handler, http.MethodPost, "/api/v1/ledger/tasks/t1/attest",
		fmt.Sprintf(`{"role":"dev","node":%q,"commit":"abc","signature":%q,"version":2}`, dev.NodeID(), dev.Sign("t1", sharedledger.RoleDev, "abc", "")))
	if attest.Code != http.StatusOK {
		t.Fatalf("attest = %d: %s", attest.Code, attest.Body.String())
	}
	task, err := console.sharedLedger.Get(t.Context(), "t1")
	if err != nil {
		t.Fatal(err)
	}
	if task.State != sharedledger.DevDone || task.Artifacts.Commit != "abc" {
		t.Fatalf("task = %+v", task)
	}

	create2 := do(t, handler, http.MethodPost, "/api/v1/ledger/tasks", `{"id":"t2"}`)
	if create2.Code != http.StatusCreated {
		t.Fatalf("create2 = %d", create2.Code)
	}
	cancelSignature := dev.SignOperation("cancel", "t2", "", dev.NodeID(), 0, 0, "stop")
	delete := do(t, handler, http.MethodPost, "/api/v1/ledger/tasks/t2/cancel",
		fmt.Sprintf(`{"node":%q,"reason":"stop","signature":%q}`, dev.NodeID(), cancelSignature))
	if delete.Code != http.StatusOK {
		t.Fatalf("cancel = %d: %s", delete.Code, delete.Body.String())
	}
	task2, err := console.sharedLedger.Get(t.Context(), "t2")
	if err != nil {
		t.Fatal(err)
	}
	if task2.State != sharedledger.Cancelled {
		t.Fatalf("task2 = %+v", task2)
	}
}

func TestLedgerWriteAPIRejectsUnsignedAndImpersonatedClaims(t *testing.T) {
	isolateState(t)
	console := NewServer("", nil)
	handler := console.Handler()
	if create := do(t, handler, http.MethodPost, "/api/v1/ledger/tasks", `{"id":"s1"}`); create.Code != http.StatusCreated {
		t.Fatalf("create = %d", create.Code)
	}
	unsigned := do(t, handler, http.MethodPost, "/api/v1/ledger/tasks/s1/claim",
		`{"role":"dev","node":"ed25519:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","leaseSeconds":60,"version":1}`)
	if unsigned.Code != http.StatusBadRequest {
		t.Fatalf("unsigned = %d: %s", unsigned.Code, unsigned.Body.String())
	}

	victim := testLedgerIdentity(t, "victim")
	attacker := testLedgerIdentity(t, "attacker")
	// The attacker signs, but names the victim's public key as the owner.
	signature := attacker.SignOperation("claim", "s1", sharedledger.RoleDev, attacker.NodeID(), 1, 60, "")
	impostor := do(t, handler, http.MethodPost, "/api/v1/ledger/tasks/s1/claim",
		fmt.Sprintf(`{"role":"dev","node":%q,"leaseSeconds":60,"version":1,"signature":%q}`, victim.NodeID(), signature))
	if impostor.Code != http.StatusBadRequest {
		t.Fatalf("impostor = %d: %s", impostor.Code, impostor.Body.String())
	}
}
