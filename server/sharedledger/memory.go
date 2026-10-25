package sharedledger

import (
	"context"
	"sort"
	"sync"
	"time"
)

// Memory is the Phase 1 implementation: same contract as the future NATS
// adapter, one mutex as the CAS. It is safe for concurrent use.
type Memory struct {
	mu     sync.Mutex
	now    func() time.Time
	tasks  map[string]Task
	events map[string][]Event
}

func NewMemory() *Memory {
	return &Memory{
		now:    time.Now,
		tasks:  map[string]Task{},
		events: map[string][]Event{},
	}
}

// SetNow injects a clock for lease-expiry tests.
func (m *Memory) SetNow(now func() time.Time) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.now = now
}

func (m *Memory) clock() time.Time {
	if m.now == nil {
		return time.Now()
	}
	return m.now()
}

func (m *Memory) Create(_ context.Context, task Task) (Task, error) {
	if task.ID == "" {
		return Task{}, ErrInvalidTask
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, exists := m.tasks[task.ID]; exists {
		return Task{}, ErrConflict
	}
	now := m.clock()
	task.State = Proposed
	task.Version = 1
	task.Owner = ""
	task.Role = ""
	task.LeaseUntil = time.Time{}
	task.Attempts = 0
	task.CreatedAt = now
	task.UpdatedAt = now
	m.tasks[task.ID] = task
	m.eventLocked(task, "created", "", "")
	return cloneTask(task), nil
}

func (m *Memory) Get(_ context.Context, id string) (Task, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	task, ok := m.tasks[id]
	if !ok {
		return Task{}, ErrNotFound
	}
	m.expireLocked(&task)
	m.tasks[id] = task
	return cloneTask(task), nil
}

func (m *Memory) List(_ context.Context, filter Filter) ([]Task, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.expireAllLocked()
	out := make([]Task, 0, len(m.tasks))
	for _, task := range m.tasks {
		if filter.State != "" && task.State != filter.State {
			continue
		}
		if filter.Role != "" && task.Role != filter.Role {
			continue
		}
		if filter.Node != "" && task.Owner != filter.Node {
			continue
		}
		out = append(out, cloneTask(task))
	}
	sort.SliceStable(out, func(left, right int) bool {
		if out[left].CreatedAt.Equal(out[right].CreatedAt) {
			return out[left].ID < out[right].ID
		}
		return out[left].CreatedAt.Before(out[right].CreatedAt)
	})
	if filter.Limit > 0 && len(out) > filter.Limit {
		out = out[:filter.Limit]
	}
	return out, nil
}

func (m *Memory) Claim(_ context.Context, id string, role Role, node string, lease time.Duration, expectedVersion uint64) (Task, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	task, ok := m.tasks[id]
	if !ok {
		return Task{}, ErrNotFound
	}
	m.expireLocked(&task)
	if task.Version != expectedVersion {
		m.tasks[id] = task
		return Task{}, ErrConflict
	}
	if err := claimAllowed(task, role, node); err != nil {
		m.tasks[id] = task
		return Task{}, err
	}
	if role == RoleMerge && m.mergeBusyLocked(task) {
		m.tasks[id] = task
		return Task{}, ErrMergeBusy
	}
	if lease <= 0 {
		lease = 30 * time.Minute
	}
	now := m.clock()
	task.State = claimTarget(role)
	task.Role = role
	task.Owner = node
	task.LeaseUntil = now.Add(lease)
	task.Version++
	task.Attempts++
	task.UpdatedAt = now
	m.tasks[id] = task
	m.eventLocked(task, "claimed", node, "")
	return cloneTask(task), nil
}

func (m *Memory) Heartbeat(_ context.Context, id string, role Role, node string, lease time.Duration) (Task, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	task, ok := m.tasks[id]
	if !ok {
		return Task{}, ErrNotFound
	}
	m.expireLocked(&task)
	if !isClaimed(task.State) || task.Role != role || task.Owner != node {
		m.tasks[id] = task
		return Task{}, ErrNotOwner
	}
	if lease <= 0 {
		lease = 30 * time.Minute
	}
	now := m.clock()
	task.LeaseUntil = now.Add(lease)
	task.Version++
	task.UpdatedAt = now
	m.tasks[id] = task
	m.eventLocked(task, "heartbeat", node, "")
	return cloneTask(task), nil
}

func (m *Memory) Attest(_ context.Context, id string, role Role, node, commit, digest, signature string, expectedVersion uint64) (Task, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	task, ok := m.tasks[id]
	if !ok {
		return Task{}, ErrNotFound
	}
	m.expireLocked(&task)
	if task.Version != expectedVersion {
		m.tasks[id] = task
		return Task{}, ErrConflict
	}
	if signature == "" {
		m.tasks[id] = task
		return Task{}, ErrSignature
	}
	if !isClaimed(task.State) || task.Role != role || task.Owner != node {
		m.tasks[id] = task
		return Task{}, ErrNotOwner
	}
	if role != RoleDev && role != RoleMerge && !independent(task, node) {
		m.tasks[id] = task
		return Task{}, ErrIndependentNode
	}
	next, ok := attestTarget(role)
	if !ok {
		m.tasks[id] = task
		return Task{}, ErrInvalidState
	}
	now := m.clock()
	task.Attestations = append(task.Attestations, Attestation{
		Role: role, Node: node, Commit: commit, Digest: digest, Signature: signature, At: now,
	})
	if commit != "" {
		task.Artifacts.Commit = commit
	}
	if digest != "" && role == RoleTest {
		task.Artifacts.Tests = digest
	}
	task.State = next
	task.Owner = ""
	task.Role = ""
	task.LeaseUntil = time.Time{}
	task.Version++
	task.UpdatedAt = now
	m.tasks[id] = task
	m.eventLocked(task, "attested", node, "")
	return cloneTask(task), nil
}

func (m *Memory) Release(_ context.Context, id string, role Role, node, reason string) (Task, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	task, ok := m.tasks[id]
	if !ok {
		return Task{}, ErrNotFound
	}
	m.expireLocked(&task)
	if !isClaimed(task.State) || task.Role != role || task.Owner != node {
		m.tasks[id] = task
		return Task{}, ErrNotOwner
	}
	task.State = Proposed
	task.Owner = ""
	task.Role = ""
	task.LeaseUntil = time.Time{}
	task.Version++
	task.UpdatedAt = m.clock()
	m.tasks[id] = task
	m.eventLocked(task, "released", node, reason)
	return cloneTask(task), nil
}

func (m *Memory) Cancel(_ context.Context, id string, node, reason string) (Task, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	task, ok := m.tasks[id]
	if !ok {
		return Task{}, ErrNotFound
	}
	if task.State == Cancelled || task.State == Merged {
		m.tasks[id] = task
		return Task{}, ErrInvalidState
	}
	task.State = Cancelled
	task.Owner = ""
	task.Role = ""
	task.LeaseUntil = time.Time{}
	task.Version++
	task.UpdatedAt = m.clock()
	m.tasks[id] = task
	m.eventLocked(task, "cancelled", node, reason)
	return cloneTask(task), nil
}

func (m *Memory) Events(_ context.Context, id string) ([]Event, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.tasks[id]; !ok {
		return nil, ErrNotFound
	}
	return append([]Event(nil), m.events[id]...), nil
}

func (m *Memory) expireAllLocked() {
	for id, task := range m.tasks {
		m.expireLocked(&task)
		m.tasks[id] = task
	}
}

// mergeBusyLocked reports another task already holding the merge lock for the
// same checkout. The task itself is skipped: a re-claim/retry is not a conflict.
func (m *Memory) mergeBusyLocked(task Task) bool {
	repo := mergeRepo(task)
	for id, other := range m.tasks {
		if id == task.ID || other.State != MergeQueued {
			continue
		}
		if mergeRepo(other) == repo {
			return true
		}
	}
	return false
}

func (m *Memory) expireLocked(task *Task) {
	if !isClaimed(task.State) || task.LeaseUntil.IsZero() {
		return
	}
	if m.clock().Before(task.LeaseUntil) {
		return
	}
	task.State = Proposed
	task.Owner = ""
	task.Role = ""
	task.LeaseUntil = time.Time{}
	task.Attempts++
	task.Version++
	task.UpdatedAt = m.clock()
	m.eventLocked(*task, "expired", "", "lease expired")
}

func (m *Memory) eventLocked(task Task, kind, node, reason string) {
	m.events[task.ID] = append(m.events[task.ID], Event{
		TaskID: task.ID, Type: kind, State: task.State, Role: task.Role,
		Node: node, Version: task.Version, Reason: reason, At: task.UpdatedAt,
	})
}

func isClaimed(state State) bool {
	switch state {
	case DevClaimed, ReviewClaimed, TestClaimed, AuditClaimed, MergeQueued:
		return true
	default:
		return false
	}
}

func claimTarget(role Role) State {
	switch role {
	case RoleDev:
		return DevClaimed
	case RoleReview:
		return ReviewClaimed
	case RoleTest:
		return TestClaimed
	case RoleAudit:
		return AuditClaimed
	case RoleMerge:
		return MergeQueued
	default:
		return Unknown
	}
}

func claimAllowed(task Task, role Role, node string) error {
	switch role {
	case RoleDev:
		switch task.State {
		case Proposed, ChangesRequested, TestFailed, AuditRejected:
			return nil
		default:
			return ErrInvalidState
		}
	case RoleReview:
		if task.State != DevDone {
			return ErrInvalidState
		}
	case RoleTest:
		if task.State != ReviewApproved {
			return ErrInvalidState
		}
	case RoleAudit:
		if task.State != TestPassed {
			return ErrInvalidState
		}
	case RoleMerge:
		if task.State != AuditApproved {
			return ErrInvalidState
		}
	default:
		return ErrInvalidState
	}
	if role != RoleDev && role != RoleMerge && !independent(task, node) {
		return ErrIndependentNode
	}
	return nil
}

func attestTarget(role Role) (State, bool) {
	switch role {
	case RoleDev:
		return DevDone, true
	case RoleReview:
		return ReviewApproved, true
	case RoleTest:
		return TestPassed, true
	case RoleAudit:
		return AuditApproved, true
	case RoleMerge:
		return Merged, true
	default:
		return Unknown, false
	}
}

// independent rejects the node that did the development. The dev attestation is
// the durable record; the dev lease is already cleared by the time review runs.
func independent(task Task, node string) bool {
	if node == "" {
		return false
	}
	for _, attestation := range task.Attestations {
		if attestation.Role == RoleDev && attestation.Node == node {
			return false
		}
	}
	return true
}

// Independent reports whether node may take a review/test/audit lease.
func Independent(task Task, node string) bool {
	return independent(task, node)
}

func cloneTask(task Task) Task {
	out := task
	out.Attestations = append([]Attestation(nil), task.Attestations...)
	return out
}
