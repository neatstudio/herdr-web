package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func TestJobStartRequiresAPromptAndAnAgent(t *testing.T) {
	console := NewServer("", nil)
	handler := console.Handler()

	for _, body := range []string{
		`{"kind":"claude"}`,
		`{"prompt":"do work"}`,
	} {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/api/v1/herdr/job",
			strings.NewReader(body)))
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("%s: status = %d", body, recorder.Code)
		}
	}
}

func TestAgentKindsListsOnlyWhatIsInstalled(t *testing.T) {
	previous := lookPath
	lookPath = func(name string) (string, error) {
		if name == "claude" {
			return "/usr/local/bin/claude", nil
		}
		return "", &notFoundError{}
	}
	t.Cleanup(func() { lookPath = previous })

	console := NewServer("", nil)
	recorder := httptest.NewRecorder()
	console.Handler().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/herdr/agents", nil))
	var body struct {
		Kinds []string `json:"kinds"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Kinds) != 1 || body.Kinds[0] != "claude" {
		t.Fatalf("kinds = %v", body.Kinds)
	}
}

type notFoundError struct{}

func (*notFoundError) Error() string { return "not found" }

func TestDispatchNeedsATarget(t *testing.T) {
	// A console that knows nobody cannot dispatch anywhere, and says so instead of
	// pretending it sent something.
	console := NewServer("", nil)
	recorder := httptest.NewRecorder()
	console.Handler().ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/api/v1/fleet/job",
		strings.NewReader(`{"prompt":"hi","kind":"claude"}`)))
	if recorder.Code != http.StatusConflict {
		t.Fatalf("status = %d: %s", recorder.Code, recorder.Body.String())
	}
}

func TestDispatchSendsTheSameJobToEachMachine(t *testing.T) {
	type received struct {
		Prompt string `json:"prompt"`
		Kind   string `json:"kind"`
		Cwd    string `json:"cwd"`
	}
	var got []received
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request received
		_ = json.NewDecoder(r.Body).Decode(&request)
		got = append(got, request)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok": true, "jobId": "w1:p1", "workspaceId": "w1", "paneId": "w1:p1",
		})
	}))
	t.Cleanup(target.Close)

	console := NewServer("", nil)
	body := `{"prompt":"audit the repo","kind":"claude","cwd":"/work/repo","targets":["` + target.URL + `"]}`
	recorder := httptest.NewRecorder()
	console.Handler().ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/api/v1/fleet/job",
		strings.NewReader(body)))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", recorder.Code, recorder.Body.String())
	}
	if len(got) != 1 || got[0].Prompt != "audit the repo" || got[0].Kind != "claude" || got[0].Cwd != "/work/repo" {
		t.Fatalf("target received %+v", got)
	}
	// And the dispatch is remembered, so the panel can poll it.
	var answer struct {
		Dispatch struct {
			ID   string `json:"id"`
			Jobs []struct {
				Host string `json:"host"`
			} `json:"jobs"`
		} `json:"dispatch"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &answer); err != nil {
		t.Fatal(err)
	}
	if answer.Dispatch.ID == "" || len(answer.Dispatch.Jobs) != 1 {
		t.Fatalf("dispatch = %+v", answer.Dispatch)
	}
}

func TestFleetPeersReportWhichAgentsTheyCanStart(t *testing.T) {
	// A job has to run where its agent exists, and that is not the same machine
	// everywhere, so the fleet carries the answer.
	previous := lookPath
	lookPath = func(name string) (string, error) {
		if name == "claude" {
			return "/usr/bin/claude", nil
		}
		return "", &notFoundError{}
	}
	t.Cleanup(func() { lookPath = previous })
	agentKindsOnce = sync.Once{}
	agentKindsCache = nil
	t.Cleanup(func() {
		agentKindsOnce = sync.Once{}
		agentKindsCache = nil
	})

	console := fleetTestServer(t)
	self := console.fleetSelfPeer()
	if len(self.Agents) != 1 || self.Agents[0] != "claude" {
		t.Fatalf("agents = %v", self.Agents)
	}

	recorder := httptest.NewRecorder()
	console.Handler().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/fleet", nil))
	if !strings.Contains(recorder.Body.String(), `"agents":["claude"]`) {
		t.Fatalf("body = %s", recorder.Body.String())
	}
}
