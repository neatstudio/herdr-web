package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"herdr-web/server/sharedledger"
)

func advanceTaskToAuditApproved(t *testing.T, console *Server, taskID string) {
	t.Helper()
	ctx := context.Background()
	task, err := console.sharedLedger.Get(ctx, taskID)
	if err != nil {
		t.Fatal(err)
	}
	dev, err := console.sharedLedger.Claim(ctx, taskID, sharedledger.RoleDev, "dev", time.Hour, task.Version)
	if err != nil {
		t.Fatal(err)
	}
	done, err := console.sharedLedger.Attest(ctx, taskID, sharedledger.RoleDev, "dev", "abc", "", "sig", dev.Version)
	if err != nil {
		t.Fatal(err)
	}
	review, err := console.sharedLedger.Claim(ctx, taskID, sharedledger.RoleReview, "review", time.Hour, done.Version)
	if err != nil {
		t.Fatal(err)
	}
	reviewed, err := console.sharedLedger.Attest(ctx, taskID, sharedledger.RoleReview, "review", "abc", "", "sig", review.Version)
	if err != nil {
		t.Fatal(err)
	}
	test, err := console.sharedLedger.Claim(ctx, taskID, sharedledger.RoleTest, "test", time.Hour, reviewed.Version)
	if err != nil {
		t.Fatal(err)
	}
	tested, err := console.sharedLedger.Attest(ctx, taskID, sharedledger.RoleTest, "test", "abc", "", "sig", test.Version)
	if err != nil {
		t.Fatal(err)
	}
	audit, err := console.sharedLedger.Claim(ctx, taskID, sharedledger.RoleAudit, "audit", time.Hour, tested.Version)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := console.sharedLedger.Attest(ctx, taskID, sharedledger.RoleAudit, "audit", "abc", "", "sig", audit.Version); err != nil {
		t.Fatal(err)
	}
}

func TestOrchestratorMergesAuditApprovedTask(t *testing.T) {
	isolateState(t)
	t.Setenv("TEST_GITHUB_TOKEN", "test-token")
	var created, merged bool
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/repos/acme/app/pulls":
			created = true
			_ = json.NewEncoder(w).Encode(map[string]any{
				"number": 9, "html_url": "https://example/pr/9", "state": "open",
			})
		case r.Method == http.MethodPut && r.URL.Path == "/repos/acme/app/pulls/9/merge":
			merged = true
			_ = json.NewEncoder(w).Encode(map[string]any{"merged": true, "sha": "abc"})
		default:
			http.NotFound(w, r)
		}
	}))
	defer target.Close()

	console := NewServer("", nil)
	if _, err := console.repos.Add(Repo{
		Provider: "github", BaseURL: target.URL, Owner: "acme", Name: "app",
		DefaultBranch: "main", Checkout: "/repo", TokenEnv: "TEST_GITHUB_TOKEN",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := console.sharedLedger.Create(t.Context(), sharedledger.Task{
		ID: "m9", Title: "Fix", Prompt: "Details", Cwd: "/repo",
		Branch: "job/issue-9", Kind: "claude", Weight: "standard",
		Repo: "github:acme/app", Issue: 9,
	}); err != nil {
		t.Fatal(err)
	}
	advanceTaskToAuditApproved(t, console, "m9")

	console.orchestratorTick(context.Background())
	task, err := console.sharedLedger.Get(context.Background(), "m9")
	if err != nil {
		t.Fatal(err)
	}
	if task.State != sharedledger.Merged || task.PR != 9 || task.Artifacts.Commit != "abc" {
		t.Fatalf("task = %+v", task)
	}
	if !created || !merged {
		t.Fatalf("created=%v merged=%v", created, merged)
	}
}
