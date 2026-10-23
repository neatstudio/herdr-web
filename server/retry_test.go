package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type retryTarget struct {
	server    *httptest.Server
	accept    atomic.Bool
	running   atomic.Bool
	workspace atomic.Value
	starts    atomic.Int32
	tasks     atomic.Int32
}

func newRetryTarget(t *testing.T) *retryTarget {
	t.Helper()
	target := &retryTarget{}
	target.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/v1/herdr/job/offer":
			if !target.accept.Load() {
				_, _ = w.Write([]byte(`{"ok":true,"accept":false,"reason":"at capacity","running":1,"maxTasks":1}`))
				return
			}
			_, _ = w.Write([]byte(`{"ok":true,"accept":true,"running":0,"maxTasks":2}`))
		case r.URL.Path == "/api/v1/herdr/job":
			target.starts.Add(1)
			_, _ = w.Write([]byte(`{"ok":true,"jobId":"w1:p1","paneId":"w1:p1","workspaceId":"w1"}`))
		case strings.HasPrefix(r.URL.Path, "/api/v1/herdr/job/task/"):
			target.tasks.Add(1)
			running := target.running.Load()
			workspace, _ := target.workspace.Load().(string)
			answer := map[string]any{"ok": true, "running": running}
			if running {
				answer["jobId"] = "w9:p1"
				answer["workspaceId"] = workspace
			}
			_ = json.NewEncoder(w).Encode(answer)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(target.server.Close)
	return target
}

func TestDispatchBoardSurvivesRestartAndRetries(t *testing.T) {
	isolateState(t)
	target := newRetryTarget(t) // declines until the test accepts
	body := `{"prompt":"p","kind":"claude","strategy":"single","targets":["` + target.server.URL + `"]}`

	first := NewServer("", nil)
	recorder := do(t, first.Handler(), http.MethodPost, "/api/v1/fleet/job", body)
	if recorder.Code != http.StatusOK {
		t.Fatalf("dispatch = %d: %s", recorder.Code, recorder.Body.String())
	}
	var created struct {
		Dispatch dispatch `json:"dispatch"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.Dispatch.Jobs[0].WorkspaceID != "" || created.Dispatch.Strategy != "single" {
		t.Fatalf("first dispatch = %+v", created.Dispatch)
	}

	// A new process loads the task board from disk.
	second := NewServer("", nil)
	if len(second.dispatch.dispatch) != 1 || second.dispatch.dispatch[0].ID != created.Dispatch.ID {
		t.Fatalf("board did not survive: %+v", second.dispatch.dispatch)
	}
	target.accept.Store(true)
	retry := do(t, second.Handler(), http.MethodPost, "/api/v1/fleet/job/retry",
		`{"id":"`+created.Dispatch.ID+`"}`)
	if retry.Code != http.StatusOK {
		t.Fatalf("retry = %d: %s", retry.Code, retry.Body.String())
	}
	var answer struct {
		OK       bool     `json:"ok"`
		Dispatch dispatch `json:"dispatch"`
	}
	if err := json.Unmarshal(retry.Body.Bytes(), &answer); err != nil {
		t.Fatal(err)
	}
	if !answer.OK || answer.Dispatch.Jobs[0].WorkspaceID != "w1" {
		t.Fatalf("retry = %+v", answer)
	}
	if target.starts.Load() != 1 {
		t.Fatalf("starts = %d", target.starts.Load())
	}

	third := NewServer("", nil)
	if len(third.dispatch.dispatch) != 1 || third.dispatch.dispatch[0].Jobs[0].WorkspaceID != "w1" {
		t.Fatalf("retried board did not survive: %+v", third.dispatch.dispatch)
	}
}

func TestRetryAdoptsATaskThatAlreadyStarted(t *testing.T) {
	isolateState(t)
	target := newRetryTarget(t)
	// The board lost the start response, but the target has the task.
	target.running.Store(true)
	target.workspace.Store("w9")
	console := NewServer("", nil)
	console.dispatch.dispatch = []dispatch{{
		ID: "task-lost", Prompt: "p", Kind: "claude", Strategy: "single",
		Targets: []string{target.server.URL},
		Jobs: []dispatchedJob{{
			Host: target.server.URL, TaskID: "task-lost", Status: "declined",
		}},
	}}
	console.dispatch.saveLocked()

	retry := do(t, console.Handler(), http.MethodPost, "/api/v1/fleet/job/retry", `{"id":"task-lost"}`)
	if retry.Code != http.StatusOK {
		t.Fatalf("retry = %d: %s", retry.Code, retry.Body.String())
	}
	var answer struct {
		Dispatch dispatch `json:"dispatch"`
	}
	if err := json.Unmarshal(retry.Body.Bytes(), &answer); err != nil {
		t.Fatal(err)
	}
	if answer.Dispatch.Jobs[0].WorkspaceID != "w9" {
		t.Fatalf("retry = %+v", answer.Dispatch.Jobs[0])
	}
	if target.starts.Load() != 0 {
		t.Fatalf("started a second workspace: %d", target.starts.Load())
	}
}

func TestDispatchListMarksALostJob(t *testing.T) {
	isolateState(t)
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "gone", http.StatusBadGateway)
	}))
	defer target.Close()
	console := NewServer("", nil)
	console.dispatch.dispatch = []dispatch{{
		ID: "task-lost", Prompt: "p", Kind: "claude", Strategy: "single",
		Targets: []string{target.URL},
		Jobs: []dispatchedJob{{
			Host: target.URL, Local: "w1:p1", WorkspaceID: "w1",
			LeaseUntil: time.Now().Add(-time.Minute).Unix(),
		}},
	}}

	list := do(t, console.Handler(), http.MethodGet, "/api/v1/fleet/jobs", "")
	if list.Code != http.StatusOK {
		t.Fatalf("list = %d: %s", list.Code, list.Body.String())
	}
	var answer struct {
		Dispatches []struct {
			Jobs []dispatchedJob `json:"jobs"`
		} `json:"dispatches"`
	}
	if err := json.Unmarshal(list.Body.Bytes(), &answer); err != nil {
		t.Fatal(err)
	}
	if !answer.Dispatches[0].Jobs[0].Lost {
		t.Fatalf("job = %+v, want lost", answer.Dispatches[0].Jobs[0])
	}
}
