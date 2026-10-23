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
}

type jobLedger struct {
	mu      sync.Mutex
	running map[string]ledgerEvent
	events  []ledgerEvent
}

func newJobLedger() *jobLedger {
	return &jobLedger{running: map[string]ledgerEvent{}}
}

func (l *jobLedger) started(workspaceID, paneID, kind, label string) {
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
	}
	l.running[workspaceID] = event
	l.appendLocked(event)
}

func (l *jobLedger) stopped(workspaceID string) {
	if l == nil || workspaceID == "" {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
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
