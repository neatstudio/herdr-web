package server

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"herdr-web/server/sharedledger"
)

func startClaudeJob(t *testing.T, console *Server) jobStarted {
	t.Helper()
	start := do(t, console.Handler(), http.MethodPost, "/api/v1/herdr/job",
		`{"prompt":"do it","kind":"claude"}`)
	if start.Code != http.StatusOK {
		t.Fatalf("start = %d: %s", start.Code, start.Body.String())
	}
	var started jobStarted
	if err := json.Unmarshal(start.Body.Bytes(), &started); err != nil {
		t.Fatal(err)
	}
	if started.TaskID == "" || started.PaneID == "" || started.WorkspaceID == "" {
		t.Fatalf("started = %+v", started)
	}
	return started
}

func TestJobStartCreatesSharedTask(t *testing.T) {
	installClaude(t)
	socket, _, closeFn := startFakeHerdr(t)
	defer closeFn()
	isolateState(t)
	console := NewServer(socket, nil)

	started := startClaudeJob(t, console)
	tasks, err := console.sharedLedger.List(context.Background(), sharedledger.Filter{})
	if err != nil {
		t.Fatal(err)
	}
	if len(tasks) != 1 {
		t.Fatalf("tasks = %+v", tasks)
	}
	task := tasks[0]
	if task.ID != started.TaskID || task.State != sharedledger.DevClaimed || task.Owner != localNodeID() {
		t.Fatalf("shared task = %+v", task)
	}
}

func TestJobStatusDoneAttestsSharedTask(t *testing.T) {
	installClaude(t)
	socket, state, closeFn := startFakeHerdr(t)
	defer closeFn()
	isolateState(t)
	console := NewServer(socket, nil)

	started := startClaudeJob(t, console)
	state.mu.Lock()
	state.agentStatus = "done"
	state.mu.Unlock()

	status := do(t, console.Handler(), http.MethodGet, "/api/v1/herdr/job/"+started.PaneID, "")
	if status.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", status.Code, status.Body.String())
	}
	task, err := console.sharedLedger.Get(context.Background(), started.TaskID)
	if err != nil {
		t.Fatal(err)
	}
	if task.State != sharedledger.DevDone {
		t.Fatalf("shared task = %+v", task)
	}
	if console.ledger.runningCount() != 0 {
		t.Fatalf("running count = %d", console.ledger.runningCount())
	}
}

func TestJobStopCancelsSharedTask(t *testing.T) {
	installClaude(t)
	socket, _, closeFn := startFakeHerdr(t)
	defer closeFn()
	isolateState(t)
	console := NewServer(socket, nil)

	started := startClaudeJob(t, console)
	stop := do(t, console.Handler(), http.MethodPost, "/api/v1/herdr/job/"+started.WorkspaceID+"/stop", "")
	if stop.Code != http.StatusOK {
		t.Fatalf("stop = %d: %s", stop.Code, stop.Body.String())
	}
	task, err := console.sharedLedger.Get(context.Background(), started.TaskID)
	if err != nil {
		t.Fatal(err)
	}
	if task.State != sharedledger.Cancelled {
		t.Fatalf("shared task = %+v", task)
	}
}

func TestReviewJobClaimsSharedTaskByRole(t *testing.T) {
	installClaude(t)
	socket, state, closeFn := startFakeHerdr(t)
	defer closeFn()
	isolateState(t)
	console := NewServer(socket, nil)
	ctx := context.Background()

	if _, err := console.sharedLedger.Create(ctx, sharedledger.Task{ID: "p1", Cwd: "/repo"}); err != nil {
		t.Fatal(err)
	}
	dev, err := console.sharedLedger.Claim(ctx, "p1", sharedledger.RoleDev, "dev", time.Hour, 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := console.sharedLedger.Attest(ctx, "p1", sharedledger.RoleDev, "dev", "abc", "", "sig", dev.Version); err != nil {
		t.Fatal(err)
	}

	start := do(t, console.Handler(), http.MethodPost, "/api/v1/herdr/job",
		`{"prompt":"review it","kind":"claude","role":"review","taskId":"p1"}`)
	if start.Code != http.StatusOK {
		t.Fatalf("start = %d: %s", start.Code, start.Body.String())
	}
	var started jobStarted
	if err := json.Unmarshal(start.Body.Bytes(), &started); err != nil {
		t.Fatal(err)
	}
	task, err := console.sharedLedger.Get(ctx, "p1")
	if err != nil {
		t.Fatal(err)
	}
	if task.State != sharedledger.ReviewClaimed || task.Owner != localNodeID() {
		t.Fatalf("task = %+v", task)
	}
	event, ok := console.ledger.eventForPane(started.PaneID)
	if !ok || event.Role != "review" {
		t.Fatalf("local event = %+v", event)
	}

	state.mu.Lock()
	state.agentStatus = "done"
	state.mu.Unlock()
	status := do(t, console.Handler(), http.MethodGet, "/api/v1/herdr/job/"+started.PaneID, "")
	if status.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", status.Code, status.Body.String())
	}
	task, err = console.sharedLedger.Get(ctx, "p1")
	if err != nil {
		t.Fatal(err)
	}
	if task.State != sharedledger.ReviewApproved {
		t.Fatalf("task after review = %+v", task)
	}
}
