package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestDispatchStopClosesTheTargetAndStopsPolling(t *testing.T) {
	var statusCalls atomic.Int32
	var stopCalls atomic.Int32
	var stopPath atomic.Value
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/herdr/job/w1/stop":
			stopCalls.Add(1)
			stopPath.Store(r.URL.Path)
			_, _ = w.Write([]byte(`{"ok":true,"workspaceId":"w1"}`))
		case "/api/v1/herdr/job/w1:p1":
			statusCalls.Add(1)
			_, _ = w.Write([]byte(`{"status":"working","output":"still here"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer target.Close()

	isolateState(t)
	console := NewServer(t.TempDir()+"/h.sock", testWebFS())
	console.dispatch.dispatch = []dispatch{{
		ID:     "d1",
		Prompt: "audit",
		Jobs: []dispatchedJob{{
			Host: target.URL, Local: "w1:p1", JobID: "w1:p1", WorkspaceID: "w1",
		}},
	}}

	body := `{"host":"` + target.URL + `","workspaceId":"w1"}`
	stop := do(t, console.Handler(), http.MethodPost, "/api/v1/fleet/job/stop", body)
	if stop.Code != http.StatusOK {
		t.Fatalf("stop status = %d: %s", stop.Code, stop.Body.String())
	}
	if stopCalls.Load() != 1 || stopPath.Load() != "/api/v1/herdr/job/w1/stop" {
		t.Fatalf("stop calls = %d path = %v", stopCalls.Load(), stopPath.Load())
	}

	list := do(t, console.Handler(), http.MethodGet, "/api/v1/fleet/jobs", "")
	if list.Code != http.StatusOK {
		t.Fatalf("list status = %d: %s", list.Code, list.Body.String())
	}
	var answer struct {
		Dispatches []struct {
			Jobs []dispatchedJob `json:"jobs"`
		} `json:"dispatches"`
	}
	if err := json.Unmarshal(list.Body.Bytes(), &answer); err != nil {
		t.Fatal(err)
	}
	job := answer.Dispatches[0].Jobs[0]
	if !job.Cancelled || job.Status != "stopped" {
		t.Fatalf("job = %+v, want cancelled/stopped", job)
	}
	// The workspace is gone; polling it would only produce a stale error.
	if statusCalls.Load() != 0 {
		t.Fatalf("status called %d times after stop", statusCalls.Load())
	}
}

func TestDispatchStopRefusesAJobItDidNotSend(t *testing.T) {
	// Without the dispatch record this endpoint is a request-forwarder to
	// anywhere that answers: the stop has to map to a job this console sent.
	var reached atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached.Add(1)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer target.Close()

	isolateState(t)
	console := NewServer(t.TempDir()+"/h.sock", testWebFS())
	console.dispatch.dispatch = []dispatch{{
		ID:   "d1",
		Jobs: []dispatchedJob{{Host: "http://elsewhere:5000", Local: "w1:p1", WorkspaceID: "w1"}},
	}}

	for _, body := range []string{
		`{"host":"` + target.URL + `","workspaceId":"w1"}`,    // right workspace, wrong host
		`{"host":"http://elsewhere:5000","workspaceId":"w9"}`, // right host, wrong workspace
	} {
		stop := do(t, console.Handler(), http.MethodPost, "/api/v1/fleet/job/stop", body)
		if stop.Code != http.StatusNotFound {
			t.Fatalf("%s: status = %d, want 404", body, stop.Code)
		}
	}
	if reached.Load() != 0 {
		t.Fatalf("an undispatched target was contacted %d times", reached.Load())
	}
}
