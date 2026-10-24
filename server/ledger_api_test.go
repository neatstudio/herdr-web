package server

import (
	"encoding/json"
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

	claim := do(t, handler, http.MethodPost, "/api/v1/ledger/tasks/t1/claim",
		`{"role":"dev","node":"node-a","leaseSeconds":60,"version":1}`)
	if claim.Code != http.StatusOK {
		t.Fatalf("claim = %d: %s", claim.Code, claim.Body.String())
	}
	var claimed struct {
		Task sharedledger.Task `json:"task"`
	}
	if err := json.Unmarshal(claim.Body.Bytes(), &claimed); err != nil {
		t.Fatal(err)
	}
	if claimed.Task.State != sharedledger.DevClaimed || claimed.Task.Owner != "node-a" {
		t.Fatalf("claimed = %+v", claimed.Task)
	}

	conflict := do(t, handler, http.MethodPost, "/api/v1/ledger/tasks/t1/claim",
		`{"role":"dev","node":"node-b","leaseSeconds":60,"version":1}`)
	if conflict.Code != http.StatusConflict {
		t.Fatalf("conflict = %d: %s", conflict.Code, conflict.Body.String())
	}

	attest := do(t, handler, http.MethodPost, "/api/v1/ledger/tasks/t1/attest",
		`{"role":"dev","node":"node-a","commit":"abc","signature":"sig","version":2}`)
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
	delete := do(t, handler, http.MethodPost, "/api/v1/ledger/tasks/t2/cancel", `{"node":"node-a","reason":"stop"}`)
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
