package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
)

type marketTarget struct {
	server     *httptest.Server
	free       int
	offerCalls atomic.Int32
	startCalls atomic.Int32
	started    atomic.Bool
	failStart  int
	lastTask   atomic.Value
}

func newMarketTarget(t *testing.T, free int, failStart int, startTookEffect bool) *marketTarget {
	t.Helper()
	target := &marketTarget{free: free, failStart: failStart}
	target.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/v1/herdr/job/offer":
			target.offerCalls.Add(1)
			var body struct {
				TaskID string `json:"taskId"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			target.lastTask.Store(body.TaskID)
			_, _ = w.Write([]byte(`{"ok":true,"accept":true,"running":0,"maxTasks":` +
				strconv.Itoa(target.free) + `}`))
		case r.URL.Path == "/api/v1/herdr/job":
			target.startCalls.Add(1)
			var body struct {
				TaskID string `json:"taskId"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			target.lastTask.Store(body.TaskID)
			if target.failStart != 0 {
				if startTookEffect {
					target.started.Store(true)
				}
				w.WriteHeader(target.failStart)
				_, _ = w.Write([]byte(`{"error":{"code":"herdr_job_failed","message":"start failed"}}`))
				return
			}
			target.started.Store(true)
			_, _ = w.Write([]byte(`{"ok":true,"jobId":"w1:p1","paneId":"w1:p1","workspaceId":"w1","taskId":"` +
				body.TaskID + `"}`))
		case strings.HasPrefix(r.URL.Path, "/api/v1/herdr/job/task/"):
			running := target.started.Load()
			answer := map[string]any{"ok": true, "running": running}
			if running {
				answer["jobId"] = "w1:p1"
				answer["workspaceId"] = "w1"
			}
			_ = json.NewEncoder(w).Encode(answer)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(target.server.Close)
	return target
}

func dispatchMarketForTest(t *testing.T, targets ...*marketTarget) (bool, dispatch) {
	t.Helper()
	isolateState(t)
	console := NewServer("", nil)
	urls := make([]string, len(targets))
	for index, target := range targets {
		urls[index] = target.server.URL
	}
	body, err := json.Marshal(map[string]any{
		"prompt": "audit the docs", "kind": "claude", "strategy": "single", "targets": urls,
	})
	if err != nil {
		t.Fatal(err)
	}
	recorder := do(t, console.Handler(), http.MethodPost, "/api/v1/fleet/job", string(body))
	if recorder.Code != http.StatusOK {
		t.Fatalf("dispatch = %d: %s", recorder.Code, recorder.Body.String())
	}
	var answer struct {
		OK       bool     `json:"ok"`
		Dispatch dispatch `json:"dispatch"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &answer); err != nil {
		t.Fatal(err)
	}
	return answer.OK, answer.Dispatch
}

func TestDispatchMarketPicksTheFreestTarget(t *testing.T) {
	large := newMarketTarget(t, 3, 0, false)
	small := newMarketTarget(t, 1, 0, false)
	ok, job := dispatchMarketForTest(t, small, large)
	if !ok {
		t.Fatalf("dispatch failed: %+v", job)
	}
	if large.startCalls.Load() != 1 || small.startCalls.Load() != 0 {
		t.Fatalf("starts = large %d small %d", large.startCalls.Load(), small.startCalls.Load())
	}
	if job.Jobs[0].Host != small.server.URL || job.Jobs[0].Status != "not selected" {
		t.Fatalf("small job = %+v", job.Jobs[0])
	}
	if job.Jobs[1].Host != large.server.URL || job.Jobs[1].Status != "started" {
		t.Fatalf("large job = %+v", job.Jobs[1])
	}
	if job.Jobs[1].TaskID == "" || job.Jobs[1].TaskID != job.Jobs[0].TaskID {
		t.Fatalf("task ids = %q %q", job.Jobs[0].TaskID, job.Jobs[1].TaskID)
	}
	if job.Jobs[1].LeaseUntil == 0 {
		t.Fatalf("started job has no lease: %+v", job.Jobs[1])
	}
}

func TestDispatchMarketRetriesAfterADefinitiveRefusal(t *testing.T) {
	refusing := newMarketTarget(t, 3, http.StatusTooManyRequests, false)
	accepting := newMarketTarget(t, 1, 0, false)
	ok, job := dispatchMarketForTest(t, refusing, accepting)
	if !ok {
		t.Fatalf("dispatch failed: %+v", job)
	}
	if refusing.startCalls.Load() != 1 || accepting.startCalls.Load() != 1 {
		t.Fatalf("starts = refusing %d accepting %d", refusing.startCalls.Load(), accepting.startCalls.Load())
	}
	if job.Jobs[0].Status != "declined" || job.Jobs[1].Status != "started" {
		t.Fatalf("jobs = %+v", job.Jobs)
	}
	if refusing.lastTask.Load() != accepting.lastTask.Load() {
		t.Fatalf("task ids differ: %v vs %v", refusing.lastTask.Load(), accepting.lastTask.Load())
	}
}

func TestDispatchMarketDoesNotDuplicateWhenTheStartTookEffect(t *testing.T) {
	// A 500 after the target created the workspace must not send the same task to
	// the next machine. The task lookup is the lease guard.
	uncertain := newMarketTarget(t, 3, http.StatusInternalServerError, true)
	spare := newMarketTarget(t, 1, 0, false)
	ok, job := dispatchMarketForTest(t, uncertain, spare)
	if !ok {
		t.Fatalf("dispatch failed: %+v", job)
	}
	if spare.startCalls.Load() != 0 {
		t.Fatalf("spare was started %d times", spare.startCalls.Load())
	}
	if job.Jobs[0].Status != "started" || job.Jobs[0].WorkspaceID != "w1" {
		t.Fatalf("uncertain job = %+v", job.Jobs[0])
	}
}
