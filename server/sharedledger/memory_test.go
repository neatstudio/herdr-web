package sharedledger

import (
	"context"
	"crypto/sha256"
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

func testIdentity(t *testing.T, name string) Identity {
	t.Helper()
	seed := sha256.Sum256([]byte("sharedledger-test/" + name))
	identity, err := IdentityFromSeed(seed[:])
	if err != nil {
		t.Fatal(err)
	}
	return identity
}

func claimWith(ledger *Memory, id string, role Role, identity Identity, version uint64, lease time.Duration) (Task, error) {
	signature := identity.SignOperation("claim", id, role, identity.NodeID(), version, int64(lease/time.Second), "")
	return ledger.Claim(context.Background(), id, role, identity.NodeID(), lease, version, signature)
}

func testClaim(t *testing.T, ledger *Memory, id string, role Role, identity Identity, version uint64, lease time.Duration) Task {
	t.Helper()
	task, err := claimWith(ledger, id, role, identity, version, lease)
	if err != nil {
		t.Fatal(err)
	}
	return task
}

func heartbeatWith(ledger *Memory, id string, role Role, identity Identity, lease time.Duration) (Task, error) {
	signature := identity.SignOperation("heartbeat", id, role, identity.NodeID(), 0, int64(lease/time.Second), "")
	return ledger.Heartbeat(context.Background(), id, role, identity.NodeID(), lease, signature)
}

func releaseWith(ledger *Memory, id string, role Role, identity Identity, reason string) (Task, error) {
	signature := identity.SignOperation("release", id, role, identity.NodeID(), 0, 0, reason)
	return ledger.Release(context.Background(), id, role, identity.NodeID(), reason, signature)
}

func cancelWith(ledger *Memory, id string, identity Identity, reason string) (Task, error) {
	signature := identity.SignOperation("cancel", id, "", identity.NodeID(), 0, 0, reason)
	return ledger.Cancel(context.Background(), id, identity.NodeID(), reason, signature)
}

func failMergeWith(ledger *Memory, id string, identity Identity, reason string) (Task, error) {
	signature := identity.SignOperation("fail_merge", id, RoleMerge, identity.NodeID(), 0, 0, reason)
	return ledger.FailMerge(context.Background(), id, identity.NodeID(), reason, signature)
}

func claimDev(t *testing.T, ledger *Memory, version uint64) Task {
	t.Helper()
	return testClaim(t, ledger, "t1", RoleDev, testIdentity(t, "dev"), version, time.Hour)
}

func attestDev(t *testing.T, ledger *Memory, version uint64) Task {
	t.Helper()
	dev := testIdentity(t, "dev")
	task, err := ledger.Attest(context.Background(), "t1", RoleDev, dev.NodeID(), "abc", "", dev.Sign("t1", RoleDev, "abc", ""), version)
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
	for _, identity := range []Identity{testIdentity(t, "node-a"), testIdentity(t, "node-b")} {
		identity := identity
		wait.Add(1)
		go func() {
			defer wait.Done()
			_, err := claimWith(ledger, "t1", RoleDev, identity, task.Version, time.Hour)
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
	dev := testIdentity(t, "dev")
	claimed, err := claimWith(ledger, "t1", RoleDev, dev, task.Version, time.Minute)
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
	if _, err := ledger.Attest(context.Background(), "t1", RoleDev, dev.NodeID(), "abc", "", dev.Sign("t1", RoleDev, "abc", ""), claimed.Version); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale attest error = %v", err)
	}
}

func TestReviewMustUseIndependentNode(t *testing.T) {
	ledger := NewMemory()
	task := createTask(t, ledger)
	dev := claimDev(t, ledger, task.Version)
	done := attestDev(t, ledger, dev.Version)

	devIdentity := testIdentity(t, "dev")
	reviewIdentity := testIdentity(t, "review")
	if _, err := claimWith(ledger, "t1", RoleReview, devIdentity, done.Version, time.Hour); !errors.Is(err, ErrIndependentNode) {
		t.Fatalf("same-node review error = %v", err)
	}
	if _, err := claimWith(ledger, "t1", RoleReview, reviewIdentity, done.Version, time.Hour); err != nil {
		t.Fatalf("independent review error = %v", err)
	}
}

func TestAttestRequiresSignature(t *testing.T) {
	ledger := NewMemory()
	task := createTask(t, ledger)
	dev := claimDev(t, ledger, task.Version)
	identity := testIdentity(t, "dev")

	if _, err := ledger.Attest(context.Background(), "t1", RoleDev, identity.NodeID(), "abc", "", "", dev.Version); !errors.Is(err, ErrSignature) {
		t.Fatalf("unsigned attest error = %v", err)
	}
	if _, err := ledger.Attest(context.Background(), "t1", RoleDev, identity.NodeID(), "abc", "", "not-a-signature", dev.Version); !errors.Is(err, ErrSignature) {
		t.Fatalf("forged attest error = %v", err)
	}
	valid := identity.Sign("t1", RoleDev, "abc", "")
	if _, err := ledger.Attest(context.Background(), "t1", RoleDev, identity.NodeID(), "abc", "", valid, dev.Version); err != nil {
		t.Fatalf("signed attest error = %v", err)
	}
}

func TestAttestationCannotBeReplayedForAnotherTask(t *testing.T) {
	ledger := NewMemory()
	first := createTask(t, ledger)
	_ = first
	identity := testIdentity(t, "dev")
	signature := identity.Sign("t1", RoleDev, "abc", "")

	second, err := ledger.Create(context.Background(), Task{ID: "t2", Title: "second"})
	if err != nil {
		t.Fatal(err)
	}
	claimed, err := claimWith(ledger, "t2", RoleDev, identity, second.Version, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ledger.Attest(context.Background(), "t2", RoleDev, identity.NodeID(), "abc", "", signature, claimed.Version); !errors.Is(err, ErrSignature) {
		t.Fatalf("replayed attest error = %v", err)
	}
}

func TestStateMachineRejectsReviewBeforeDevDone(t *testing.T) {
	ledger := NewMemory()
	task := createTask(t, ledger)
	if _, err := claimWith(ledger, "t1", RoleReview, testIdentity(t, "review"), task.Version, time.Hour); !errors.Is(err, ErrInvalidState) {
		t.Fatalf("early review error = %v", err)
	}
}

func TestReleaseAndCancel(t *testing.T) {
	ledger := NewMemory()
	task := createTask(t, ledger)
	dev := testIdentity(t, "dev")
	claimed := claimDev(t, ledger, task.Version)
	released, err := releaseWith(ledger, "t1", RoleDev, dev, "needs changes")
	if err != nil {
		t.Fatal(err)
	}
	if released.State != Proposed || released.Owner != "" {
		t.Fatalf("released = %+v", released)
	}
	claimed = claimDev(t, ledger, released.Version)
	cancelled, err := cancelWith(ledger, "t1", dev, "stop")
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
	dev := testIdentity(t, "dev")
	claimed, err := claimWith(ledger, "t1", RoleDev, dev, task.Version, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	now = now.Add(30 * time.Second)
	if _, err := heartbeatWith(ledger, "t1", RoleDev, dev, 2*time.Minute); err != nil {
		t.Fatal(err)
	}
	now = now.Add(90 * time.Second)
	got, err := ledger.Get(context.Background(), "t1")
	if err != nil {
		t.Fatal(err)
	}
	if got.State != DevClaimed || got.Owner != dev.NodeID() {
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

	mergeAIdentity := testIdentity(t, "merge-a")
	mergeBIdentity := testIdentity(t, "merge-b")
	mergeA, err := claimWith(ledger, "m1", RoleMerge, mergeAIdentity, first.Version, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := claimWith(ledger, "m2", RoleMerge, mergeBIdentity, second.Version, time.Hour); !errors.Is(err, ErrMergeBusy) {
		t.Fatalf("second merge error = %v", err)
	}
	merged, err := ledger.Attest(ctx, "m1", RoleMerge, mergeAIdentity.NodeID(), "", "", mergeAIdentity.Sign("m1", RoleMerge, "", ""), mergeA.Version)
	if err != nil {
		t.Fatal(err)
	}
	if merged.State != Merged {
		t.Fatalf("merged = %+v", merged)
	}
	if _, err := claimWith(ledger, "m2", RoleMerge, mergeBIdentity, second.Version, time.Hour); err != nil {
		t.Fatalf("after merge error = %v", err)
	}
}

func advanceToAuditApproved(t *testing.T, ledger *Memory, task Task) Task {
	t.Helper()
	ctx := context.Background()
	dev := testIdentity(t, "dev")
	review := testIdentity(t, "review")
	testingNode := testIdentity(t, "test")
	audit := testIdentity(t, "audit")

	devLease, err := claimWith(ledger, task.ID, RoleDev, dev, task.Version, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	done, err := ledger.Attest(ctx, task.ID, RoleDev, dev.NodeID(), "abc", "", dev.Sign(task.ID, RoleDev, "abc", ""), devLease.Version)
	if err != nil {
		t.Fatal(err)
	}
	reviewLease, err := claimWith(ledger, task.ID, RoleReview, review, done.Version, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	reviewed, err := ledger.Attest(ctx, task.ID, RoleReview, review.NodeID(), "abc", "", review.Sign(task.ID, RoleReview, "abc", ""), reviewLease.Version)
	if err != nil {
		t.Fatal(err)
	}
	testLease, err := claimWith(ledger, task.ID, RoleTest, testingNode, reviewed.Version, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	tested, err := ledger.Attest(ctx, task.ID, RoleTest, testingNode.NodeID(), "abc", "", testingNode.Sign(task.ID, RoleTest, "abc", ""), testLease.Version)
	if err != nil {
		t.Fatal(err)
	}
	auditLease, err := claimWith(ledger, task.ID, RoleAudit, audit, tested.Version, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	approved, err := ledger.Attest(ctx, task.ID, RoleAudit, audit.NodeID(), "abc", "", audit.Sign(task.ID, RoleAudit, "abc", ""), auditLease.Version)
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

func TestMergeFailureIsBounded(t *testing.T) {
	ledger := NewMemory()
	ctx := context.Background()
	task, err := ledger.Create(ctx, Task{ID: "mf", Cwd: "/repo"})
	if err != nil {
		t.Fatal(err)
	}
	task = advanceToAuditApproved(t, ledger, task)
	merge := testIdentity(t, "merge")
	for attempt := 1; attempt <= MaxMergeAttempts; attempt++ {
		claimed, err := claimWith(ledger, "mf", RoleMerge, merge, task.Version, time.Hour)
		if err != nil {
			t.Fatalf("attempt %d claim: %v", attempt, err)
		}
		task, err = failMergeWith(ledger, "mf", merge, "conflict")
		if err != nil {
			t.Fatalf("attempt %d fail: %v", attempt, err)
		}
		if task.MergeAttempts != attempt {
			t.Fatalf("attempt %d merge attempts = %d", attempt, task.MergeAttempts)
		}
		if attempt < MaxMergeAttempts && task.State != AuditApproved {
			t.Fatalf("attempt %d state = %s", attempt, task.State)
		}
		_ = claimed
	}
	if task.State != MergeBlocked {
		t.Fatalf("final state = %s", task.State)
	}
	if _, err := claimWith(ledger, "mf", RoleMerge, merge, task.Version, time.Hour); !errors.Is(err, ErrInvalidState) {
		t.Fatalf("blocked merge claim error = %v", err)
	}
}

func TestClaimRejectsAnImpostorKey(t *testing.T) {
	ledger := NewMemory()
	task := createTask(t, ledger)
	victim := testIdentity(t, "victim")
	attacker := testIdentity(t, "attacker")
	signature := attacker.SignOperation("claim", "t1", RoleDev, attacker.NodeID(), task.Version, 3600, "")
	if _, err := ledger.Claim(context.Background(), "t1", RoleDev, victim.NodeID(), time.Hour, task.Version, signature); !errors.Is(err, ErrSignature) {
		t.Fatalf("impostor claim error = %v", err)
	}
	if _, err := ledger.Cancel(context.Background(), "t1", attacker.NodeID(), "stop", ""); !errors.Is(err, ErrSignature) {
		t.Fatalf("unsigned cancel error = %v", err)
	}
}

func TestMergeQueueUsesTheRepositoryWhenCwdIsEmpty(t *testing.T) {
	ledger := NewMemory()
	ctx := context.Background()
	first, err := ledger.Create(ctx, Task{ID: "r1", Repo: "github:acme/app"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := ledger.Create(ctx, Task{ID: "r2", Repo: "github:acme/app"})
	if err != nil {
		t.Fatal(err)
	}
	first = advanceToAuditApproved(t, ledger, first)
	second = advanceToAuditApproved(t, ledger, second)
	mergeA := testIdentity(t, "repo-merge-a")
	mergeB := testIdentity(t, "repo-merge-b")
	if _, err := claimWith(ledger, "r1", RoleMerge, mergeA, first.Version, time.Hour); err != nil {
		t.Fatal(err)
	}
	if _, err := claimWith(ledger, "r2", RoleMerge, mergeB, second.Version, time.Hour); !errors.Is(err, ErrMergeBusy) {
		t.Fatalf("same repo merge error = %v", err)
	}
}
