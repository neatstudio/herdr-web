package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
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
	path    string
}

// ledgerPathOverride keeps a test's ledger out of the operator's home.
var ledgerPathOverride string

func ledgerPath() string {
	if ledgerPathOverride != "" {
		return ledgerPathOverride
	}
	dir := jobStateDir()
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, "ledger.jsonl")
}

func newJobLedger() *jobLedger {
	ledger := &jobLedger{
		running: map[string]ledgerEvent{},
		tasks:   map[string]string{},
		path:    ledgerPath(),
	}
	ledger.load()
	return ledger
}

// load replays the append-only file. The last event for a workspace decides
// whether it is still running; offers and declines are history only.
func (l *jobLedger) load() {
	if l.path == "" {
		return
	}
	raw, err := os.ReadFile(l.path)
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var event ledgerEvent
		if json.Unmarshal([]byte(line), &event) != nil {
			continue
		}
		l.replayLocked(event)
	}
}

func (l *jobLedger) replayLocked(event ledgerEvent) {
	switch event.Event {
	case "started":
		if event.WorkspaceID != "" {
			l.running[event.WorkspaceID] = event
		}
		if event.TaskID != "" && event.WorkspaceID != "" {
			l.tasks[event.TaskID] = event.WorkspaceID
		}
	case "stopped":
		if taskID := l.running[event.WorkspaceID].TaskID; taskID != "" {
			delete(l.tasks, taskID)
		}
		delete(l.running, event.WorkspaceID)
	}
	l.events = append(l.events, event)
	if len(l.events) > ledgerEventLimit {
		l.events = append([]ledgerEvent(nil), l.events[len(l.events)-ledgerEventLimit:]...)
	}
}

func (l *jobLedger) persistLocked(event ledgerEvent) {
	if l.path == "" {
		return
	}
	if err := os.MkdirAll(filepath.Dir(l.path), 0o700); err != nil {
		return
	}
	file, err := os.OpenFile(l.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	raw, err := json.Marshal(event)
	if err == nil {
		_, _ = file.Write(append(raw, '\n'))
	}
	_ = file.Close()
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
	l.persistLocked(event)
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
	event := ledgerEvent{
		At:          time.Now().Unix(),
		Event:       "stopped",
		WorkspaceID: workspaceID,
	}
	l.appendLocked(event)
	l.persistLocked(event)
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
	entry := ledgerEvent{
		At:     time.Now().Unix(),
		Event:  event,
		TaskID: taskID,
		Reason: reason,
	}
	l.appendLocked(entry)
	l.persistLocked(entry)
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
