package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDispatchListCarriesTheJobsDiff(t *testing.T) {
	// The panel learns a job's result from the dispatcher, which must ask the
	// machine that ran it — not guess from the local repository.
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/herdr/job/w1:p1":
			_, _ = w.Write([]byte(`{"status":"done","output":"ok\n"}`))
		case "/api/v1/herdr/job/w1/diff":
			_, _ = w.Write([]byte(`{"ok":true,"branch":"job/audit","checkoutPath":"/srv/wt","commits":["abc audit"],"changed":[" M a.go"]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer target.Close()

	console := NewServer(t.TempDir()+"/h.sock", testWebFS())
	console.dispatch.dispatch = []dispatch{{
		ID:     "d1",
		Prompt: "audit",
		Jobs: []dispatchedJob{{
			Host: target.URL, Local: "w1:p1", JobID: "w1:p1", WorkspaceID: "w1",
		}},
	}}

	recorder := httptest.NewRecorder()
	console.Handler().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/fleet/jobs", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", recorder.Code, recorder.Body.String())
	}
	var body struct {
		Dispatches []struct {
			Jobs []dispatchedJob `json:"jobs"`
		} `json:"dispatches"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Dispatches) != 1 || len(body.Dispatches[0].Jobs) != 1 {
		t.Fatalf("dispatches = %+v", body.Dispatches)
	}
	job := body.Dispatches[0].Jobs[0]
	if !job.DiffReady {
		t.Fatalf("diffReady = false: %s", recorder.Body.String())
	}
	if job.CheckoutPath != "/srv/wt" {
		t.Fatalf("checkoutPath = %q", job.CheckoutPath)
	}
	if job.Branch != "job/audit" {
		t.Fatalf("branch = %q", job.Branch)
	}
	if len(job.Commits) != 1 || job.Commits[0] != "abc audit" {
		t.Fatalf("commits = %v", job.Commits)
	}
	if len(job.Changed) != 1 || job.Changed[0] != " M a.go" {
		t.Fatalf("changed = %v", job.Changed)
	}
}
