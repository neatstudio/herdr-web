package server

import (
	"encoding/json"
	"net/http"
	"testing"
)

func TestJobStartRefusesAtCapacityAndFreesOnStop(t *testing.T) {
	t.Setenv("HERDR_WEB_MAX_JOBS", "1")
	socket, _, closeFn := startFakeHerdr(t)
	defer closeFn()
	console := newTestHandler(t, socket)
	body := `{"prompt":"do work","kind":"claude"}`

	first := do(t, console, http.MethodPost, "/api/v1/herdr/job", body)
	if first.Code != http.StatusOK {
		t.Fatalf("first start = %d: %s", first.Code, first.Body.String())
	}

	second := do(t, console, http.MethodPost, "/api/v1/herdr/job", body)
	if second.Code != http.StatusTooManyRequests {
		t.Fatalf("second start = %d, want %d: %s", second.Code, http.StatusTooManyRequests, second.Body.String())
	}
	var refusal struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(second.Body.Bytes(), &refusal); err != nil {
		t.Fatal(err)
	}
	if refusal.Error.Code != "at_capacity" {
		t.Fatalf("code = %q", refusal.Error.Code)
	}

	ledger := do(t, console, http.MethodGet, "/api/v1/herdr/jobs/ledger", "")
	if ledger.Code != http.StatusOK {
		t.Fatalf("ledger = %d: %s", ledger.Code, ledger.Body.String())
	}
	var before struct {
		MaxTasks int           `json:"maxTasks"`
		Running  int           `json:"running"`
		Events   []ledgerEvent `json:"events"`
	}
	if err := json.Unmarshal(ledger.Body.Bytes(), &before); err != nil {
		t.Fatal(err)
	}
	if before.MaxTasks != 1 || before.Running != 1 {
		t.Fatalf("ledger = %+v", before)
	}
	if len(before.Events) == 0 || before.Events[0].Event != "started" {
		t.Fatalf("events = %+v", before.Events)
	}

	stop := do(t, console, http.MethodPost, "/api/v1/herdr/job/w1/stop", "")
	if stop.Code != http.StatusOK {
		t.Fatalf("stop = %d: %s", stop.Code, stop.Body.String())
	}

	third := do(t, console, http.MethodPost, "/api/v1/herdr/job", body)
	if third.Code != http.StatusOK {
		t.Fatalf("restart after stop = %d: %s", third.Code, third.Body.String())
	}
}

func TestFleetPeerReportsCapacityAndModels(t *testing.T) {
	t.Setenv("HERDR_WEB_MAX_JOBS", "3")
	t.Setenv("HERDR_WEB_MODELS", "qwen3, claude")
	console := NewServer("", nil)
	console.fleetAddr = "127.0.0.1:5000"
	console.ledger.started("w1", "w1:p1", "claude", "job")

	peer := console.fleetSelfPeer()
	if peer.MaxTasks != 3 || peer.Running != 1 {
		t.Fatalf("capacity = %d/%d", peer.Running, peer.MaxTasks)
	}
	if len(peer.Models) != 2 || peer.Models[0] != "qwen3" || peer.Models[1] != "claude" {
		t.Fatalf("models = %v", peer.Models)
	}
	if peer.Tools == nil {
		t.Fatalf("tools should be an empty slice, not nil")
	}
}
