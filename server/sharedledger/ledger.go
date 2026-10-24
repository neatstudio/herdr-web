// Package sharedledger defines the task ledger contract from
// docs/specs/SPEC-06-shared-ledger-and-mobile.md.
//
// Phase 1 ships the contract and an in-memory implementation. The NATS
// JetStream adapter and node identity/signature verification come later; the
// interface is deliberately small so those can land without changing callers.
package sharedledger

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"time"
)

type State string

const (
	Proposed         State = "proposed"
	DevClaimed       State = "dev_claimed"
	DevDone          State = "dev_done"
	ReviewClaimed    State = "review_claimed"
	ReviewApproved   State = "review_approved"
	ChangesRequested State = "changes_requested"
	TestClaimed      State = "test_claimed"
	TestPassed       State = "test_passed"
	TestFailed       State = "test_failed"
	AuditClaimed     State = "audit_claimed"
	AuditApproved    State = "audit_approved"
	AuditRejected    State = "audit_rejected"
	MergeQueued      State = "merge_queued"
	Merged           State = "merged"
	Cancelled        State = "cancelled"
	Unknown          State = "unknown"
)

type Role string

const (
	RoleDev    Role = "dev"
	RoleReview Role = "review"
	RoleTest   Role = "test"
	RoleAudit  Role = "audit"
	RoleMerge  Role = "merge"
)

type Task struct {
	ID      string `json:"id"`
	Title   string `json:"title,omitempty"`
	Prompt  string `json:"prompt,omitempty"`
	Cwd     string `json:"cwd,omitempty"`
	Branch  string `json:"branch,omitempty"`
	Kind    string `json:"kind,omitempty"`
	Weight  string `json:"weight,omitempty"`
	State   State  `json:"state"`
	Version uint64 `json:"version"`
	Role    Role   `json:"role,omitempty"`
	Owner   string `json:"owner,omitempty"`

	LeaseUntil time.Time `json:"leaseUntil,omitempty"`
	Attempts   int       `json:"attempts,omitempty"`

	Artifacts    Artifacts     `json:"artifacts,omitempty"`
	Attestations []Attestation `json:"attestations,omitempty"`

	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type Artifacts struct {
	Commit string `json:"commit,omitempty"`
	Tests  string `json:"tests,omitempty"`
	Report string `json:"report,omitempty"`
	Diff   string `json:"diff,omitempty"`
}

type Attestation struct {
	Role      Role      `json:"role"`
	Node      string    `json:"node"`
	Commit    string    `json:"commit,omitempty"`
	Digest    string    `json:"digest,omitempty"`
	Signature string    `json:"signature,omitempty"`
	At        time.Time `json:"at"`
}

type Event struct {
	TaskID  string    `json:"taskId"`
	Type    string    `json:"type"`
	State   State     `json:"state"`
	Role    Role      `json:"role,omitempty"`
	Node    string    `json:"node,omitempty"`
	Version uint64    `json:"version"`
	Reason  string    `json:"reason,omitempty"`
	At      time.Time `json:"at"`
}

type Filter struct {
	State State
	Role  Role
	Node  string
	Limit int
}

var (
	ErrNotFound        = errors.New("sharedledger: task not found")
	ErrConflict        = errors.New("sharedledger: version conflict")
	ErrInvalidState    = errors.New("sharedledger: invalid state transition")
	ErrLeaseExpired    = errors.New("sharedledger: lease expired")
	ErrIndependentNode = errors.New("sharedledger: review/test/audit must use an independent node")
	ErrNotOwner        = errors.New("sharedledger: node does not own the lease")
	ErrSignature       = errors.New("sharedledger: signature is required")
	ErrInvalidTask     = errors.New("sharedledger: task id is required")
	ErrMergeBusy       = errors.New("sharedledger: another task is already merging in this repository")
)

// mergeRepo is the single-writer lock key: one merge per checkout at a time.
func mergeRepo(task Task) string {
	if cwd := strings.TrimSpace(task.Cwd); cwd != "" {
		return filepath.Clean(cwd)
	}
	return "task:" + task.ID
}

// Ledger is the shared task ledger. Every mutation is compare-and-set on the
// task version, so two nodes claiming the same task cannot both win.
type Ledger interface {
	Create(ctx context.Context, task Task) (Task, error)
	Get(ctx context.Context, id string) (Task, error)
	List(ctx context.Context, filter Filter) ([]Task, error)

	// Claim takes a role lease. expectedVersion is the version read before the
	// claim; a mismatch is ErrConflict.
	Claim(ctx context.Context, id string, role Role, node string, lease time.Duration, expectedVersion uint64) (Task, error)
	Heartbeat(ctx context.Context, id string, role Role, node string, lease time.Duration) (Task, error)

	// Attest records a signed result and advances the state. expectedVersion is
	// the version read before the attest.
	Attest(ctx context.Context, id string, role Role, node, commit, digest, signature string, expectedVersion uint64) (Task, error)
	Release(ctx context.Context, id string, role Role, node, reason string) (Task, error)
	Cancel(ctx context.Context, id string, node, reason string) (Task, error)

	Events(ctx context.Context, id string) ([]Event, error)
}
