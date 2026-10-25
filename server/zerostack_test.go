package server

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"
)

// installZerostack advertises the binary without installing it. The command
// itself is recorded by the fake daemon, so the test can assert the exact
// wrapper the job starts.
func installZerostack(t *testing.T) {
	t.Helper()
	previous := lookPath
	lookPath = func(name string) (string, error) {
		if name == "zerostack" {
			return "/usr/local/bin/zerostack", nil
		}
		return "", &notFoundError{}
	}
	agentKindsOnce = sync.Once{}
	agentKindsCache = nil
	t.Cleanup(func() {
		lookPath = previous
		agentKindsOnce = sync.Once{}
		agentKindsCache = nil
	})
}

func TestZerostackJobRunsAsACommandAndReportsDone(t *testing.T) {
	installZerostack(t)
	socket, state, closeFn := startFakeHerdr(t)
	defer closeFn()
	handler := newTestHandler(t, socket)

	start := do(t, handler, http.MethodPost, "/api/v1/herdr/job",
		`{"prompt":"hello world","kind":"zerostack","cwd":"/tmp"}`)
	if start.Code != http.StatusOK {
		t.Fatalf("start = %d: %s", start.Code, start.Body.String())
	}
	var started jobStarted
	if err := json.Unmarshal(start.Body.Bytes(), &started); err != nil {
		t.Fatal(err)
	}
	if started.PaneID == "" || started.WorkspaceID == "" {
		t.Fatalf("started = %+v", started)
	}
	if state.callsFor("agent.start") != 0 || state.callsFor("agent.prompt") != 0 {
		t.Fatalf("zerostack must not go through agent.start: %v", state.calls)
	}
	if state.callsFor("pane.run") != 1 {
		t.Fatalf("pane.run calls = %d", state.callsFor("pane.run"))
	}
	params := state.paramsByMethod["pane.run"]
	command, ok := params["command"].([]any)
	if !ok || len(command) != 5 {
		t.Fatalf("command = %#v", params["command"])
	}
	if command[0] != "sh" || command[1] != "-c" {
		t.Fatalf("wrapper = %#v", command)
	}
	script, _ := command[2].(string)
	if !strings.Contains(script, "zerostack -p") || !strings.Contains(script, "__HERDR_JOB_DONE__") {
		t.Fatalf("script = %q", script)
	}
	if command[3] != "zerostack" || command[4] != "hello world" {
		t.Fatalf("prompt argv = %#v", command)
	}

	// A plain pane has no agent: both agent calls fail, but the job is still
	// running and must not turn into a gateway error.
	state.mu.Lock()
	state.failMethods = map[string]bool{"agent.get": true, "agent.read": true}
	state.readText = ""
	state.mu.Unlock()

	status := do(t, handler, http.MethodGet, "/api/v1/herdr/job/"+started.PaneID, "")
	if status.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", status.Code, status.Body.String())
	}
	answer := decodeMap(t, status)
	if answer["status"] != "running" || answer["kind"] != "zerostack" {
		t.Fatalf("running = %+v", answer)
	}

	// The marker carries the exit code; the output is what came before it.
	state.mu.Lock()
	state.readText = "answer\n__HERDR_JOB_DONE__:0\n"
	state.mu.Unlock()
	status = do(t, handler, http.MethodGet, "/api/v1/herdr/job/"+started.PaneID, "")
	answer = decodeMap(t, status)
	if answer["status"] != "done" || answer["output"] != "answer" || answer["kind"] != "zerostack" {
		t.Fatalf("done = %+v", answer)
	}

	state.mu.Lock()
	state.readText = "boom\n__HERDR_JOB_DONE__:2\n"
	state.mu.Unlock()
	status = do(t, handler, http.MethodGet, "/api/v1/herdr/job/"+started.PaneID, "")
	answer = decodeMap(t, status)
	if answer["status"] != "error" || answer["output"] != "boom" {
		t.Fatalf("failed = %+v", answer)
	}
}

func TestZerostackOfferIsAccepted(t *testing.T) {
	installZerostack(t)
	handler := newTestHandler(t, "")

	offer := do(t, handler, http.MethodPost, "/api/v1/herdr/job/offer",
		`{"taskId":"zs-1","prompt":"x","kind":"zerostack"}`)
	if offer.Code != http.StatusOK {
		t.Fatalf("offer = %d: %s", offer.Code, offer.Body.String())
	}
	answer := decodeMap(t, offer)
	if answer["accept"] != true || answer["reason"] != "" {
		t.Fatalf("offer = %+v", answer)
	}
}

func TestZerostackJobFallsBackToSendTextOnOldHerdr(t *testing.T) {
	installZerostack(t)
	socket, state, closeFn := startFakeHerdr(t)
	defer closeFn()
	handler := newTestHandler(t, socket)

	// herdr 0.9.0 has no pane.run. The job must still start by typing the
	// shell-quoted command at the pane's prompt.
	state.mu.Lock()
	state.unknownMethods = map[string]bool{"pane.run": true}
	state.mu.Unlock()

	start := do(t, handler, http.MethodPost, "/api/v1/herdr/job",
		`{"prompt":"hello world","kind":"zerostack","cwd":"/tmp"}`)
	if start.Code != http.StatusOK {
		t.Fatalf("start = %d: %s", start.Code, start.Body.String())
	}
	if state.callsFor("pane.send_text") != 1 || state.callsFor("pane.send_keys") != 1 {
		t.Fatalf("fallback calls: %v", state.calls)
	}
	_, sentText, sentKeys := state.snapshot()
	if len(sentText) != 1 || !strings.Contains(sentText[0], "zerostack -p") ||
		!strings.Contains(sentText[0], "hello world") {
		t.Fatalf("sent text = %#v", sentText)
	}
	if len(sentKeys) != 1 || sentKeys[0] != "Enter" {
		t.Fatalf("sent keys = %#v", sentKeys)
	}
}

func TestTestCommandJobRunsAsACommand(t *testing.T) {
	socket, state, closeFn := startFakeHerdr(t)
	defer closeFn()
	handler := newTestHandler(t, socket)

	start := do(t, handler, http.MethodPost, "/api/v1/herdr/job",
		`{"prompt":"run the unit tests","kind":"command","testCommand":"go test ./..."}`)
	if start.Code != http.StatusOK {
		t.Fatalf("start = %d: %s", start.Code, start.Body.String())
	}
	var started jobStarted
	if err := json.Unmarshal(start.Body.Bytes(), &started); err != nil {
		t.Fatal(err)
	}
	if state.callsFor("pane.run") != 1 {
		t.Fatalf("pane.run calls = %d", state.callsFor("pane.run"))
	}
	params := state.paramsByMethod["pane.run"]
	command, ok := params["command"].([]any)
	if !ok || len(command) != 5 {
		t.Fatalf("command = %#v", params["command"])
	}
	if command[3] != "test-command" || command[4] != "go test ./..." {
		t.Fatalf("test command argv = %#v", command)
	}

	state.mu.Lock()
	state.readText += "\n__HERDR_JOB_DONE__:0\n"
	state.mu.Unlock()
	status := do(t, handler, http.MethodGet, "/api/v1/herdr/job/"+started.PaneID, "")
	if status.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", status.Code, status.Body.String())
	}
	if got := decodeMap(t, status)["status"]; got != "done" {
		t.Fatalf("status = %v", got)
	}
}
