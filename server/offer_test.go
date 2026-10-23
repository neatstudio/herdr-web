package server

import (
	"encoding/json"
	"net/http"
	"testing"
)

func installClaude(t *testing.T) {
	t.Helper()
	previous := lookPath
	lookPath = func(name string) (string, error) {
		if name == "claude" {
			return "/usr/local/bin/claude", nil
		}
		return "", &notFoundError{}
	}
	t.Cleanup(func() { lookPath = previous })
}

func TestJobOfferUsesCapacityAndIsIdempotent(t *testing.T) {
	t.Setenv("HERDR_WEB_MAX_JOBS", "1")
	installClaude(t)
	socket, state, closeFn := startFakeHerdr(t)
	defer closeFn()
	console := newTestHandler(t, socket)

	startBody := `{"prompt":"do work","kind":"claude","taskId":"task-1"}`
	first := do(t, console, http.MethodPost, "/api/v1/herdr/job", startBody)
	if first.Code != http.StatusOK {
		t.Fatalf("start = %d: %s", first.Code, first.Body.String())
	}

	// The same task is a retry, not a second workspace.
	again := do(t, console, http.MethodPost, "/api/v1/herdr/job", startBody)
	var retried jobStarted
	if err := json.Unmarshal(again.Body.Bytes(), &retried); err != nil {
		t.Fatal(err)
	}
	if again.Code != http.StatusOK || !retried.Reused || retried.WorkspaceID != "w1" {
		t.Fatalf("retry = %d %+v", again.Code, retried)
	}
	if state.workspaceCreates != 1 {
		t.Fatalf("workspace creates = %d, want 1", state.workspaceCreates)
	}

	// Another task is declined at the cap, and the same task is still accepted
	// because it is already running.
	full := do(t, console, http.MethodPost, "/api/v1/herdr/job/offer",
		`{"taskId":"task-2","prompt":"other","kind":"claude"}`)
	var declined struct {
		Accept bool   `json:"accept"`
		Reason string `json:"reason"`
		Reused bool   `json:"reused"`
	}
	if err := json.Unmarshal(full.Body.Bytes(), &declined); err != nil {
		t.Fatal(err)
	}
	if declined.Accept || declined.Reason != "at capacity" {
		t.Fatalf("offer = %+v", declined)
	}
	same := do(t, console, http.MethodPost, "/api/v1/herdr/job/offer",
		`{"taskId":"task-1","prompt":"do work","kind":"claude"}`)
	if err := json.Unmarshal(same.Body.Bytes(), &declined); err != nil {
		t.Fatal(err)
	}
	if !declined.Accept || !declined.Reused {
		t.Fatalf("same offer = %+v", declined)
	}

	if stop := do(t, console, http.MethodPost, "/api/v1/herdr/job/w1/stop", ""); stop.Code != http.StatusOK {
		t.Fatalf("stop = %d: %s", stop.Code, stop.Body.String())
	}
	freed := do(t, console, http.MethodPost, "/api/v1/herdr/job/offer",
		`{"taskId":"task-2","prompt":"other","kind":"claude"}`)
	var after struct {
		Accept bool   `json:"accept"`
		Reason string `json:"reason"`
		Reused bool   `json:"reused"`
	}
	if err := json.Unmarshal(freed.Body.Bytes(), &after); err != nil {
		t.Fatal(err)
	}
	if !after.Accept || after.Reused {
		t.Fatalf("offer after stop = %+v", after)
	}

	task := do(t, console, http.MethodGet, "/api/v1/herdr/job/task/task-1", "")
	var stateOfTask struct {
		Running bool `json:"running"`
	}
	if err := json.Unmarshal(task.Body.Bytes(), &stateOfTask); err != nil {
		t.Fatal(err)
	}
	if stateOfTask.Running {
		t.Fatalf("task-1 still running after stop: %s", task.Body.String())
	}
}
