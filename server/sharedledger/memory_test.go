package sharedledger

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

func newTestMemory(t *testing.T, now *time.Time) *Memory {
	t.Helper()
	ledger := NewMemory()
	ledger.SetNow(func() time.Time { return *now })
	return ledger
}

func createTask(t *testing.T, ledger *Memory) Task {
	t.Helper()
	task, err := ledger.Create(context.Background(), Task{ID: "t1", Title: "test"})
	if err != nil {
		t.Fatal(err)
	}
	return task
}

func claimDev(t *testing.T, ledger *Memory, version uint64) Task {
	t.Helper()
	task, err := ledger.Claim(context.Background(), "t1", RoleDev, "dev", time.Hour, version)
	if err != nil {
		t.Fatal(err)
	}
	return task
}

func attestDev(t *testing.T, ledger *Memory, version uint64) Task {
	t.Helper()
	task, err := ledger.Attest(context.Background(), "t1", RoleDev, "dev", "abc", "", "sig", version)
	if err != nil {
		t.Fatal(err)
	}
	return task
}

func TestConcurrentClaimOnlyOneWins(t *testing.T) {
	ledger := NewMemory()
	task := createTask(t, ledger)

	results := make(chan error, 2)
	var wait sync.WaitGroup
	for _, node := range []string{"node-a", "node-b"} {
		node := node
		wait.Add(1)
		go func() {
			defer wait.Done()
			_, err := ledger.Claim(context.Background(), "t1", RoleDev, node, time.Hour, task.Version)
			results <- err
		}()
	}
	wait.Wait()
	close(results)

	successes, conflicts := 0, 0
	for err := range results {
		switch {
		case err == nil:
			successes++
		case errors.Is(err, ErrConflict):
			conflicts++
		default:
			t.Fatalf("unexpected claim error: %v", err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("successes=%d conflicts=%d", successes, conflicts)
	}
}

func TestLeaseExpiryReclaimsTask(t *testing.T) {
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	ledger := newTestMemory(t, &now)
	task := createTask(t, ledger)
	claimed, err := ledger.Claim(context.Background(), "t1", RoleDev, "dev", time.Minute, task.Version)
	if err != nil {
		t.Fatal(err)
	}

	now = now.Add(2 * time.Minute)
	got, err := ledger.Get(context.Background(), "t1")
	if err != nil {
		t.Fatal(err)
	}
	if got.State != Proposed || got.Attempts != 2 || got.Owner != "" {
		t.Fatalf("after expiry = %+v", got)
	}
	if _, err := ledger.Attest(context.Background(), "t1", RoleDev, "dev", "abc", "", "sig", claimed.Version); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale attest error = %v", err)
	}
}

func TestReviewMustUseIndependentNode(t *testing.T) {
	ledger := NewMemory()
	task := createTask(t, ledger)
	dev := claimDev(t, ledger, task.Version)
	done := attestDev(t, ledger, dev.Version)

	if _, err := ledger.Claim(context.Background(), "t1", RoleReview, "dev", time.Hour, done.Version); !errors.Is(err, ErrIndependentNode) {
		t.Fatalf("same-node review error = %v", err)
	}
	if _, err := ledger.Claim(context.Background(), "t1", RoleReview, "review", time.Hour, done.Version); err != nil {
		t.Fatalf("independent review error = %v", err)
	}
}

func TestAttestRequiresSignature(t *testing.T) {
	ledger := NewMemory()
	task := createTask(t, ledger)
	dev := claimDev(t, ledger, task.Version)

	if _, err := ledger.Attest(context.Background(), "t1", RoleDev, "dev", "abc", "", "", dev.Version); !errors.Is(err, ErrSignature) {
		t.Fatalf("unsigned attest error = %v", err)
	}
	if _, err := ledger.Attest(context.Background(), "t1", RoleDev, "dev", "abc", "", "sig", dev.Version); err != nil {
		t.Fatalf("signed attest error = %v", err)
	}
}

func TestStateMachineRejectsReviewBeforeDevDone(t *testing.T) {
	ledger := NewMemory()
	task := createTask(t, ledger)
	if _, err := ledger.Claim(context.Background(), "t1", RoleReview, "review", time.Hour, task.Version); !errors.Is(err, ErrInvalidState) {
		t.Fatalf("early review error = %v", err)
	}
}

func TestReleaseAndCancel(t *testing.T) {
	ledger := NewMemory()
	task := createTask(t, ledger)
	claimed := claimDev(t, ledger, task.Version)
	released, err := ledger.Release(context.Background(), "t1", RoleDev, "dev", "needs changes")
	if err != nil {
		t.Fatal(err)
	}
	if released.State != Proposed || released.Owner != "" {
		t.Fatalf("released = %+v", released)
	}
	claimed = claimDev(t, ledger, released.Version)
	cancelled, err := ledger.Cancel(context.Background(), "t1", "dev", "stop")
	if err != nil {
		t.Fatal(err)
	}
	if cancelled.State != Cancelled || cancelled.Owner != "" {
		t.Fatalf("cancelled = %+v", cancelled)
	}
	_ = claimed
}

func TestEventsRecordTransitions(t *testing.T) {
	ledger := NewMemory()
	task := createTask(t, ledger)
	dev := claimDev(t, ledger, task.Version)
	_ = attestDev(t, ledger, dev.Version)

	events, err := ledger.Events(context.Background(), "t1")
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 3 || events[0].Type != "created" || events[1].Type != "claimed" || events[2].Type != "attested" {
		t.Fatalf("events = %+v", events)
	}
}

func TestHeartbeatExtendsLease(t *testing.T) {
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	ledger := newTestMemory(t, &now)
	task := createTask(t, ledger)
	claimed, err := ledger.Claim(context.Background(), "t1", RoleDev, "dev", time.Minute, task.Version)
	if err != nil {
		t.Fatal(err)
	}
	now = now.Add(30 * time.Second)
	if _, err := ledger.Heartbeat(context.Background(), "t1", RoleDev, "dev", 2*time.Minute); err != nil {
		t.Fatal(err)
	}
	now = now.Add(90 * time.Second)
	got, err := ledger.Get(context.Background(), "t1")
	if err != nil {
		t.Fatal(err)
	}
	if got.State != DevClaimed || got.Owner != "dev" {
		t.Fatalf("after heartbeat = %+v (claimed %+v)", got, claimed)
	}
}

func TestMergeQueueIsSingleWriterPerRepo(t *testing.T) {
	ledger := NewMemory()
	ctx := context.Background()
	first, err := ledger.Create(ctx, Task{ID: "m1", Cwd: "/repo"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := ledger.Create(ctx, Task{ID: "m2", Cwd: "/repo"})
	if err != nil {
		t.Fatal(err)
	}
	first = advanceToAuditApproved(t, ledger, first)
	second = advanceToAuditApproved(t, ledger, second)

	mergeA, err := ledger.Claim(ctx, "m1", RoleMerge, "merge-a", time.Hour, first.Version)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ledger.Claim(ctx, "m2", RoleMerge, "merge-b", time.Hour, second.Version); !errors.Is(err, ErrMergeBusy) {
		t.Fatalf("second merge error = %v", err)
	}
	merged, err := ledger.Attest(ctx, "m1", RoleMerge, "merge-a", "", "", "sig", mergeA.Version)
	if err != nil {
		t.Fatal(err)
	}
	if merged.State != Merged {
		t.Fatalf("merged = %+v", merged)
	}
	if _, err := ledger.Claim(ctx, "m2", RoleMerge, "merge-b", time.Hour, second.Version); err != nil {
		t.Fatalf("after merge error = %v", err)
	}
}

func advanceToAuditApproved(t *testing.T, ledger *Memory, task Task) Task {
	t.Helper()
	ctx := context.Background()
	dev, err := ledger.Claim(ctx, task.ID, RoleDev, "dev", time.Hour, task.Version)
	if err != nil {
		t.Fatal(err)
	}
	done, err := ledger.Attest(ctx, task.ID, RoleDev, "dev", "abc", "", "sig", dev.Version)
	if err != nil {
		t.Fatal(err)
	}
	review, err := ledger.Claim(ctx, task.ID, RoleReview, "review", time.Hour, done.Version)
	if err != nil {
		t.Fatal(err)
	}
	reviewed, err := ledger.Attest(ctx, task.ID, RoleReview, "review", "abc", "", "sig", review.Version)
	if err != nil {
		t.Fatal(err)
	}
	test, err := ledger.Claim(ctx, task.ID, RoleTest, "test", time.Hour, reviewed.Version)
	if err != nil {
		t.Fatal(err)
	}
	tested, err := ledger.Attest(ctx, task.ID, RoleTest, "test", "abc", "", "sig", test.Version)
	if err != nil {
		t.Fatal(err)
	}
	audit, err := ledger.Claim(ctx, task.ID, RoleAudit, "audit", time.Hour, tested.Version)
	if err != nil {
		t.Fatal(err)
	}
	approved, err := ledger.Attest(ctx, task.ID, RoleAudit, "audit", "abc", "", "sig", audit.Version)
	if err != nil {
		t.Fatal(err)
	}
	return approved
}

func TestListFilters(t *testing.T) {
	ledger := NewMemory()
	if _, err := ledger.Create(context.Background(), Task{ID: "a"}); err != nil {
		t.Fatal(err)
	}
	if _, err := ledger.Create(context.Background(), Task{ID: "b"}); err != nil {
		t.Fatal(err)
	}
	all, err := ledger.List(context.Background(), Filter{})
	if err != nil || len(all) != 2 {
		t.Fatalf("all = %v, %v", all, err)
	}
	one, err := ledger.List(context.Background(), Filter{Limit: 1})
	if err != nil || len(one) != 1 {
		t.Fatalf("limit = %v, %v", one, err)
	}
}
