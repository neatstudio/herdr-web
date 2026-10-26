package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
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
	Role        string `json:"role,omitempty"`
	Label       string `json:"label,omitempty"`
	TaskID      string `json:"taskId,omitempty"`
	Reason      string `json:"reason,omitempty"`
	Repo        string `json:"repo,omitempty"`
	Branch      string `json:"branch,omitempty"`
	CloneURL    string `json:"cloneUrl,omitempty"`
	TokenEnv    string `json:"tokenEnv,omitempty"`
	BaseBranch  string `json:"baseBranch,omitempty"`
	Nonce       string `json:"nonce,omitempty"`
}

type jobResult struct {
	Status string `json:"status"`
	Kind   string `json:"kind,omitempty"`
	Output string `json:"output,omitempty"`
}

type jobLedger struct {
	mu      sync.Mutex
	running map[string]ledgerEvent
	tasks   map[string]string // task id -> workspace id
	// pending holds starts that passed admission but have no workspace yet,
	// keyed by reservation; the value is the task id ("" for an anonymous job).
	// They count against capacity, so two concurrent starts cannot both pass.
	pending     map[string]string
	reservation int
	events      []ledgerEvent
	results     map[string]jobResult
	path        string
}

// reserveOutcome is what an admission attempt decided.
type reserveOutcome int

const (
	reserveOK reserveOutcome = iota
	// reserveRunning: the task already runs here; the start is a retry.
	reserveRunning
	// reserveStarting: another request is creating this task's workspace now.
	reserveStarting
	// reserveFull: the running and pending jobs already fill the limit.
	reserveFull
)

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
		pending: map[string]string{},
		results: map[string]jobResult{},
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
	case "finished":
		if event.PaneID != "" {
			l.results[event.PaneID] = jobResult{Status: event.Reason, Kind: event.Kind}
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

// reserve is the admission check and the slot claim in one step. Checking the
// task and the count, and only recording the job after several herdr calls,
// let two concurrent starts of one task both create a workspace, and let two
// different starts both pass a limit of one. A limit of zero or less means no
// limit. The returned key is consumed by started or given back by release.
func (l *jobLedger) reserve(taskID string, limit int) (string, ledgerEvent, reserveOutcome) {
	if l == nil {
		return "", ledgerEvent{}, reserveOK
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if taskID != "" {
		if workspaceID := l.tasks[taskID]; workspaceID != "" {
			if event, found := l.running[workspaceID]; found {
				return "", event, reserveRunning
			}
		}
		if l.startingLocked(taskID) {
			return "", ledgerEvent{}, reserveStarting
		}
	}
	if limit > 0 && len(l.running)+len(l.pending) >= limit {
		return "", ledgerEvent{}, reserveFull
	}
	l.reservation++
	key := strconv.Itoa(l.reservation)
	l.pending[key] = taskID
	return key, ledgerEvent{}, reserveOK
}

// release gives back a reservation whose start failed. It is a no-op for a key
// that started already consumed, so callers can defer it unconditionally.
func (l *jobLedger) release(key string) {
	if l == nil || key == "" {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.pending, key)
}

// taskStarting says whether a start for this task is in flight here.
func (l *jobLedger) taskStarting(taskID string) bool {
	if l == nil || taskID == "" {
		return false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.startingLocked(taskID)
}

func (l *jobLedger) startingLocked(taskID string) bool {
	for _, pendingTask := range l.pending {
		if pendingTask == taskID {
			return true
		}
	}
	return false
}

// started records a running job and consumes its reservation under the same
// lock, so the slot is never counted twice or not at all.
func (l *jobLedger) started(reservation, workspaceID, paneID, kind, role, label, taskID string, checkout ...ledgerEvent) {
	if l == nil || workspaceID == "" {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.pending, reservation)
	event := ledgerEvent{
		At:          time.Now().Unix(),
		Event:       "started",
		WorkspaceID: workspaceID,
		PaneID:      paneID,
		Kind:        kind,
		Role:        role,
		Label:       label,
		TaskID:      taskID,
	}
	if len(checkout) > 0 {
		event.Repo = checkout[0].Repo
		event.Branch = checkout[0].Branch
		event.CloneURL = checkout[0].CloneURL
		event.TokenEnv = checkout[0].TokenEnv
		event.BaseBranch = checkout[0].BaseBranch
		event.Nonce = checkout[0].Nonce
	}
	l.running[workspaceID] = event
	delete(l.results, paneID)
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

// runningCount is the slots in use: running jobs plus starts still in flight.
func (l *jobLedger) runningCount() int {
	if l == nil {
		return 0
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.running) + len(l.pending)
}

// eventForPane finds the running job for a pane. The job status is addressed by
// pane id, and the kind is what tells a command job (zerostack) from an agent
// job when herdr cannot answer agent.get for the pane.
func (l *jobLedger) finished(paneID, status, kind, output string) {
	if l == nil || paneID == "" {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.results[paneID] = jobResult{Status: status, Kind: kind, Output: output}
	event := ledgerEvent{
		At: time.Now().Unix(), Event: "finished", PaneID: paneID,
		Kind: kind, Reason: status,
	}
	l.appendLocked(event)
	l.persistLocked(event)
}

func (l *jobLedger) resultForPane(paneID string) (jobResult, bool) {
	if l == nil {
		return jobResult{}, false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	result, ok := l.results[paneID]
	return result, ok
}

func (l *jobLedger) eventForPane(paneID string) (ledgerEvent, bool) {
	if l == nil {
		return ledgerEvent{}, false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, event := range l.running {
		if event.PaneID == paneID {
			return event, true
		}
	}
	return ledgerEvent{}, false
}

func (l *jobLedger) eventForWorkspace(workspaceID string) (ledgerEvent, bool) {
	if l == nil {
		return ledgerEvent{}, false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	event, ok := l.running[workspaceID]
	return event, ok
}

func (l *jobLedger) snapshot() []ledgerEvent {
	if l == nil {
		return []ledgerEvent{}
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]ledgerEvent(nil), l.events...)
}
