package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// startConcurrently fires the same number of job starts at once and returns the
// status code of each, so a check-then-act race in admission can surface.
func startConcurrently(t *testing.T, handler http.Handler, bodies []string) []int {
	t.Helper()
	codes := make([]int, len(bodies))
	var wait sync.WaitGroup
	for index, body := range bodies {
		wait.Add(1)
		go func() {
			defer wait.Done()
			request := httptest.NewRequest(http.MethodPost, "/api/v1/herdr/job", strings.NewReader(body))
			request.Header.Set("Content-Type", "application/json")
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, request)
			codes[index] = recorder.Code
		}()
	}
	wait.Wait()
	return codes
}

func countCodes(codes []int, want int) int {
	count := 0
	for _, code := range codes {
		if code == want {
			count++
		}
	}
	return count
}

func TestConcurrentStartsOfOneTaskCreateOneWorkspace(t *testing.T) {
	installClaude(t)
	t.Setenv("HERDR_WEB_MAX_JOBS", "0")
	socket, state, closeFn := startFakeHerdr(t)
	defer closeFn()
	isolateState(t)
	state.mu.Lock()
	state.createDelay = 150 * time.Millisecond
	state.mu.Unlock()
	console := NewServer(socket, nil)

	body := `{"prompt":"do it","kind":"claude","taskId":"task-same"}`
	codes := startConcurrently(t, console.Handler(), []string{body, body, body, body})

	if created := state.callsFor("workspace.create"); created != 1 {
		t.Fatalf("workspace.create called %d times for one task (codes %v)", created, codes)
	}
	if countCodes(codes, http.StatusOK) != 1 || countCodes(codes, http.StatusConflict) != 3 {
		t.Fatalf("codes = %v, want one 200 and three 409", codes)
	}
	// After the winner finished, a retry is the idempotent "reused" answer.
	retry := do(t, console.Handler(), http.MethodPost, "/api/v1/herdr/job", body)
	if retry.Code != http.StatusOK || !strings.Contains(retry.Body.String(), `"reused":true`) {
		t.Fatalf("retry = %d: %s", retry.Code, retry.Body.String())
	}
}

func TestConcurrentStartsCannotExceedTheLimit(t *testing.T) {
	installClaude(t)
	t.Setenv("HERDR_WEB_MAX_JOBS", "1")
	socket, state, closeFn := startFakeHerdr(t)
	defer closeFn()
	isolateState(t)
	state.mu.Lock()
	state.createDelay = 150 * time.Millisecond
	state.mu.Unlock()
	console := NewServer(socket, nil)

	codes := startConcurrently(t, console.Handler(), []string{
		`{"prompt":"a","kind":"claude","taskId":"task-a"}`,
		`{"prompt":"b","kind":"claude","taskId":"task-b"}`,
		`{"prompt":"c","kind":"claude"}`,
	})
	if countCodes(codes, http.StatusOK) != 1 || countCodes(codes, http.StatusTooManyRequests) != 2 {
		t.Fatalf("codes = %v, want one 200 and two 429 with HERDR_WEB_MAX_JOBS=1", codes)
	}
	if created := state.callsFor("workspace.create"); created != 1 {
		t.Fatalf("workspace.create called %d times past a limit of one", created)
	}
	if running := console.ledger.runningCount(); running != 1 {
		t.Fatalf("running = %d", running)
	}
}

func TestFailedAgentStartClosesTheWorkspaceAndFreesTheSlot(t *testing.T) {
	installClaude(t)
	t.Setenv("HERDR_WEB_MAX_JOBS", "1")
	socket, state, closeFn := startFakeHerdr(t)
	defer closeFn()
	isolateState(t)
	state.mu.Lock()
	state.failMethods["agent.start"] = true
	state.mu.Unlock()
	console := NewServer(socket, nil)

	start := do(t, console.Handler(), http.MethodPost, "/api/v1/herdr/job",
		`{"prompt":"do it","kind":"claude","taskId":"task-x"}`)
	if start.Code != http.StatusBadGateway {
		t.Fatalf("start = %d: %s", start.Code, start.Body.String())
	}
	state.mu.Lock()
	closed := append([]string(nil), state.closedWorkspaces...)
	state.mu.Unlock()
	if len(closed) != 1 || closed[0] != "w1" {
		t.Fatalf("closed workspaces = %v, want the abandoned w1", closed)
	}
	if running := console.ledger.runningCount(); running != 0 {
		t.Fatalf("a failed start still holds %d slot(s)", running)
	}

	// The slot is free again: the next start is admitted.
	state.mu.Lock()
	delete(state.failMethods, "agent.start")
	state.mu.Unlock()
	again := do(t, console.Handler(), http.MethodPost, "/api/v1/herdr/job",
		`{"prompt":"do it","kind":"claude","taskId":"task-x"}`)
	if again.Code != http.StatusOK {
		t.Fatalf("retry after failure = %d: %s", again.Code, again.Body.String())
	}
}
