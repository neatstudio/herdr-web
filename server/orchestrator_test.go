package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"herdr-web/server/sharedledger"
)

func TestOrchestratorStartsReview(t *testing.T) {
	isolateState(t)
	console := NewServer("", nil)
	ctx := context.Background()
	if _, err := console.sharedLedger.Create(ctx, sharedledger.Task{ID: "o1", Cwd: "/repo", Kind: "claude"}); err != nil {
		t.Fatal(err)
	}
	dev, err := console.sharedLedger.Claim(ctx, "o1", sharedledger.RoleDev, "dev", time.Hour, 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := console.sharedLedger.Attest(ctx, "o1", sharedledger.RoleDev, "dev", "abc", "", "sig", dev.Version); err != nil {
		t.Fatal(err)
	}

	var got jobRequest
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/herdr/job/offer":
			_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "accept": true})
		case "/api/v1/herdr/job":
			if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
				t.Errorf("decode start: %v", err)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"ok": true, "jobId": "w1:p1", "workspaceId": "w1", "paneId": "w1:p1",
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer target.Close()
	console.fleetSeeds = []string{target.URL}

	console.orchestratorTick(ctx)
	if got.Role != "review" || got.TaskID != "o1" || got.Kind != "claude" || !strings.Contains(got.Prompt, "Review") {
		t.Fatalf("started job = %+v", got)
	}
}
