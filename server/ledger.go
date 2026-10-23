package server

import (
	"sync"
	"time"
)

// A job ledger: what this console started and stopped, and how much it is
// running now.
//
// It is deliberately local and append-only. The machine running a job owns the
// job (contract 4), so a global ledger would need a consensus nobody asked for;
// every console keeping its own events and answering "what are you running?" is
// enough for a dispatcher to route by capacity. The events live in memory for
// now: a restart loses the history, but not the workspaces herdr is running.
const ledgerEventLimit = 500

type ledgerEvent struct {
	At          int64  `json:"at"`
	Event       string `json:"event"`
	WorkspaceID string `json:"workspaceId"`
	PaneID      string `json:"paneId,omitempty"`
	Kind        string `json:"kind,omitempty"`
	Label       string `json:"label,omitempty"`
	TaskID      string `json:"taskId,omitempty"`
	Reason      string `json:"reason,omitempty"`
}

type jobLedger struct {
	mu      sync.Mutex
	running map[string]ledgerEvent
	tasks   map[string]string // task id -> workspace id
	events  []ledgerEvent
}

func newJobLedger() *jobLedger {
	return &jobLedger{running: map[string]ledgerEvent{}, tasks: map[string]string{}}
}

func (l *jobLedger) started(workspaceID, paneID, kind, label, taskID string) {
	if l == nil || workspaceID == "" {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	event := ledgerEvent{
		At:          time.Now().Unix(),
		Event:       "started",
		WorkspaceID: workspaceID,
		PaneID:      paneID,
		Kind:        kind,
		Label:       label,
		TaskID:      taskID,
	}
	l.running[workspaceID] = event
	if taskID != "" {
		l.tasks[taskID] = workspaceID
	}
	l.appendLocked(event)
}

func (l *jobLedger) stopped(workspaceID string) {
	if l == nil || workspaceID == "" {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if taskID := l.running[workspaceID].TaskID; taskID != "" {
		delete(l.tasks, taskID)
	}
	delete(l.running, workspaceID)
	l.appendLocked(ledgerEvent{
		At:          time.Now().Unix(),
		Event:       "stopped",
		WorkspaceID: workspaceID,
	})
}

func (l *jobLedger) appendLocked(event ledgerEvent) {
	l.events = append(l.events, event)
	if len(l.events) > ledgerEventLimit {
		l.events = append([]ledgerEvent(nil), l.events[len(l.events)-ledgerEventLimit:]...)
	}
}

// runningTask says whether this machine is already running a task, so an offer
// and a start can be idempotent: a lost response must not create a second
// workspace for the same task.
func (l *jobLedger) runningTask(taskID string) (ledgerEvent, bool) {
	if l == nil || taskID == "" {
		return ledgerEvent{}, false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	workspaceID := l.tasks[taskID]
	if workspaceID == "" {
		return ledgerEvent{}, false
	}
	event, found := l.running[workspaceID]
	return event, found
}

// recordOffer keeps the market decision in the ledger: an offer is evidence of
// what a node was asked and whether it could take the task, even when it never
// ran it.
func (l *jobLedger) recordOffer(taskID string, accepted bool, reason string) {
	if l == nil || taskID == "" {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	event := "offered"
	if !accepted {
		event = "declined"
	}
	l.appendLocked(ledgerEvent{
		At:     time.Now().Unix(),
		Event:  event,
		TaskID: taskID,
		Reason: reason,
	})
}

func (l *jobLedger) runningCount() int {
	if l == nil {
		return 0
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.running)
}

func (l *jobLedger) snapshot() []ledgerEvent {
	if l == nil {
		return []ledgerEvent{}
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]ledgerEvent(nil), l.events...)
}
