package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"herdr-web/server/sharedledger"
)

func TestLedgerTasksBoard(t *testing.T) {
	isolateState(t)
	console := NewServer("", nil)
	if _, err := console.sharedLedger.Create(context.Background(), sharedledger.Task{ID: "t1", Title: "one"}); err != nil {
		t.Fatal(err)
	}
	if _, err := console.sharedLedger.Create(context.Background(), sharedledger.Task{ID: "t2", Title: "two"}); err != nil {
		t.Fatal(err)
	}

	recorder := httptest.NewRecorder()
	console.Handler().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/ledger/tasks", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", recorder.Code, recorder.Body.String())
	}
	var body struct {
		Tasks []sharedledger.Task `json:"tasks"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Tasks) != 2 {
		t.Fatalf("tasks = %+v", body.Tasks)
	}

	recorder = httptest.NewRecorder()
	console.Handler().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/ledger/tasks?state=merged", nil))
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Tasks) != 0 {
		t.Fatalf("merged tasks = %+v", body.Tasks)
	}

	recorder = httptest.NewRecorder()
	console.Handler().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/ledger/tasks?limit=-1", nil))
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("bad limit status = %d", recorder.Code)
	}
}
