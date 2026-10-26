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
	dev := testLedgerIdentity(t, "dev")
	review := testLedgerIdentity(t, "review")
	tester := testLedgerIdentity(t, "test")
	auditor := testLedgerIdentity(t, "audit")

	devLease := sharedClaim(t, console.sharedLedger, taskID, sharedledger.RoleDev, dev, task.Version, time.Hour)
	done, err := console.sharedLedger.Attest(ctx, taskID, sharedledger.RoleDev, dev.NodeID(), "abc", "", dev.Sign(taskID, sharedledger.RoleDev, "abc", ""), devLease.Version)
	if err != nil {
		t.Fatal(err)
	}
	reviewLease := sharedClaim(t, console.sharedLedger, taskID, sharedledger.RoleReview, review, done.Version, time.Hour)
	reviewed, err := console.sharedLedger.Attest(ctx, taskID, sharedledger.RoleReview, review.NodeID(), "abc", "", review.Sign(taskID, sharedledger.RoleReview, "abc", ""), reviewLease.Version)
	if err != nil {
		t.Fatal(err)
	}
	testLease := sharedClaim(t, console.sharedLedger, taskID, sharedledger.RoleTest, tester, reviewed.Version, time.Hour)
	tested, err := console.sharedLedger.Attest(ctx, taskID, sharedledger.RoleTest, tester.NodeID(), "abc", "", tester.Sign(taskID, sharedledger.RoleTest, "abc", ""), testLease.Version)
	if err != nil {
		t.Fatal(err)
	}
	auditLease := sharedClaim(t, console.sharedLedger, taskID, sharedledger.RoleAudit, auditor, tested.Version, time.Hour)
	if _, err := console.sharedLedger.Attest(ctx, taskID, sharedledger.RoleAudit, auditor.NodeID(), "abc", "", auditor.Sign(taskID, sharedledger.RoleAudit, "abc", ""), auditLease.Version); err != nil {
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
