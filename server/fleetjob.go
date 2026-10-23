package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Dispatched jobs: one prompt, several machines.
//
// The console that dispatches is a client, not a scheduler. It asks each chosen
// machine to start its own job through that machine's own API, and writes down
// where it sent what. Every machine keeps the work, so the record is only a
// convenience: if the dispatching console disappears, another one can ask the
// same machines what they are running, and a job that is blocked can be answered
// from anywhere.
const jobPollTimeout = 10 * time.Second

type dispatchedJob struct {
	Host        string `json:"host"`
	Local       string `json:"local"`
	JobID       string `json:"jobId"`
	WorkspaceID string `json:"workspaceId"`
	Branch      string `json:"branch,omitempty"`
	Error       string `json:"error,omitempty"`
	Status      string `json:"status,omitempty"`
	Output      string `json:"output,omitempty"`
	// What the job left in its worktree: the result a dispatcher actually needs,
	// asked of the machine that did the work.
	CheckoutPath string   `json:"checkoutPath,omitempty"`
	DiffReady    bool     `json:"diffReady,omitempty"`
	Commits      []string `json:"commits,omitempty"`
	Changed      []string `json:"changed,omitempty"`
	// A cancelled job's workspace is gone; do not ask the target for a status
	// that can only come back as an error.
	Cancelled bool `json:"cancelled,omitempty"`
	// TaskID and the lease are the market's claim record. The task id makes a
	// retry idempotent; the lease says how long this assignment is valid.
	TaskID     string `json:"taskId,omitempty"`
	Weight     string `json:"weight,omitempty"`
	LeaseUntil int64  `json:"leaseUntil,omitempty"`
	// Lost is set when a started job's machine no longer answers after its
	// lease; it is a visible operator decision, not an automatic second run.
	Lost bool `json:"lost,omitempty"`
}

type dispatch struct {
	ID     string `json:"id"`
	At     int64  `json:"at"`
	Prompt string `json:"prompt"`
	// The request behind a market task, so the board can re-offer it after a
	// restart without asking the operator to retype it.
	Kind     string          `json:"kind,omitempty"`
	Cwd      string          `json:"cwd,omitempty"`
	Branch   string          `json:"branch,omitempty"`
	Strategy string          `json:"strategy,omitempty"`
	Weight   string          `json:"weight,omitempty"`
	Targets  []string        `json:"targets,omitempty"`
	Jobs     []dispatchedJob `json:"jobs"`
}

type dispatchState struct {
	mu       sync.Mutex
	dispatch []dispatch
	path     string
}

// dispatchStatePathOverride keeps a test's task board out of the operator's home.
var dispatchStatePathOverride string

func dispatchStatePath() string {
	if dispatchStatePathOverride != "" {
		return dispatchStatePathOverride
	}
	dir := jobStateDir()
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, "dispatch.json")
}

func newDispatchState() *dispatchState {
	state := &dispatchState{path: dispatchStatePath()}
	state.load()
	return state
}

func (s *dispatchState) load() {
	if s.path == "" {
		return
	}
	raw, err := os.ReadFile(s.path)
	if err != nil {
		return
	}
	var stored struct {
		Dispatches []dispatch `json:"dispatches"`
	}
	if json.Unmarshal(raw, &stored) != nil {
		return
	}
	s.dispatch = stored.Dispatches
}

// saveLocked writes the board atomically; a half-written task board would lose
// the very state it exists to keep.
func (s *dispatchState) saveLocked() {
	if s.path == "" {
		return
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return
	}
	raw, err := json.Marshal(struct {
		Dispatches []dispatch `json:"dispatches"`
	}{Dispatches: s.dispatch})
	if err != nil {
		return
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.path), ".dispatch-*")
	if err != nil {
		return
	}
	tmpPath := tmp.Name()
	if _, err := tmp.Write(raw); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
		return
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return
	}
	if err := os.Chmod(tmpPath, 0o600); err != nil {
		_ = os.Remove(tmpPath)
		return
	}
	if err := os.Rename(tmpPath, s.path); err != nil {
		_ = os.Remove(tmpPath)
	}
}

// handleDispatch routes POST to dispatch a job and GET to list what was sent.
func (s *Server) handleDispatch(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		s.handleDispatchList(w, r)
		return
	}
	s.handleDispatchJob(w, r)
}

// handleDispatchJob sends a prompt to several consoles.
//
// Targets default to every console in the fleet. The prompt is sent verbatim to
// each, which is the point: the same task, run in parallel on machines with
// different models and different reachability, then compared.
type dispatchRequest struct {
	Prompt   string   `json:"prompt"`
	Cwd      string   `json:"cwd"`
	Branch   string   `json:"branch"`
	Kind     string   `json:"kind"`
	Weight   string   `json:"weight"`
	Strategy string   `json:"strategy"`
	Targets  []string `json:"targets"`
}

func (s *Server) handleDispatchJob(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, "POST")
		return
	}
	var request dispatchRequest
	if !decodeBody(w, r, &request) {
		return
	}
	if strings.TrimSpace(request.Prompt) == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "prompt is required")
		return
	}
	if strings.TrimSpace(request.Kind) == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "kind is required (the agent to start)")
		return
	}
	targets := request.Targets
	if len(targets) == 0 {
		targets = s.fleetConsoles()
	}
	if len(targets) == 0 {
		writeError(w, http.StatusConflict, "no_targets",
			"no console is known: pass targets, or start this one with --fleet-seeds")
		return
	}
	switch strategy := strings.ToLower(strings.TrimSpace(request.Strategy)); strategy {
	case "", "fanout":
		// The original behaviour: the same prompt runs independently everywhere.
	case "single":
		s.dispatchMarket(w, r, request, targets)
		return
	default:
		writeError(w, http.StatusBadRequest, "invalid_request",
			"strategy must be fanout or single")
		return
	}

	job := dispatch{
		ID:       "job-" + time.Now().Format("20060102-150405"),
		At:       time.Now().Unix(),
		Prompt:   request.Prompt,
		Kind:     request.Kind,
		Cwd:      request.Cwd,
		Branch:   request.Branch,
		Strategy: "fanout",
		Weight:   normalizeWeight(request.Weight),
		Targets:  targets,
		Jobs:     make([]dispatchedJob, 0, len(targets)),
	}
	for _, target := range targets {
		base := fleetBase(target)
		entry := dispatchedJob{Host: base, Weight: normalizeWeight(request.Weight)}
		body, err := json.Marshal(jobRequest{
			Prompt: request.Prompt,
			Cwd:    request.Cwd,
			Branch: request.Branch,
			Kind:   request.Kind,
			Weight: normalizeWeight(request.Weight),
		})
		if err != nil {
			entry.Error = err.Error()
			job.Jobs = append(job.Jobs, entry)
			continue
		}
		started, startErr := postJobStart(r.Context(), base, body)
		if startErr != nil {
			entry.Error = startErr.Error()
		} else {
			entry.Local = started.JobID
			entry.WorkspaceID = started.WorkspaceID
			entry.Branch = started.Branch
		}
		job.Jobs = append(job.Jobs, entry)
	}

	s.dispatch.mu.Lock()
	s.dispatch.dispatch = append(s.dispatch.dispatch, job)
	if len(s.dispatch.dispatch) > 20 {
		s.dispatch.dispatch = s.dispatch.dispatch[len(s.dispatch.dispatch)-20:]
	}
	s.dispatch.saveLocked()
	s.dispatch.mu.Unlock()

	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "dispatch": job})
}

type jobOfferAnswer struct {
	OK             bool    `json:"ok"`
	TaskID         string  `json:"taskId"`
	Accept         bool    `json:"accept"`
	Reused         bool    `json:"reused"`
	Reason         string  `json:"reason"`
	Running        int     `json:"running"`
	MaxTasks       int     `json:"maxTasks"`
	WorkspaceID    string  `json:"workspaceId"`
	CPUs           int     `json:"cpus"`
	MemTotalMB     int     `json:"memTotalMB"`
	MemAvailableMB int     `json:"memAvailableMB"`
	Load1          float64 `json:"load1"`
}

// dispatchMarket offers one task to every selected console and starts it on the
// best one that says yes. The offer is side-effect-free; the start carries the
// task id, so a lost response is retried idempotently rather than duplicating
// the workspace.
func (s *Server) runMarket(ctx context.Context, request dispatchRequest, targets []string, taskID string) (dispatch, bool, error) {
	body, err := json.Marshal(jobRequest{
		Prompt: request.Prompt,
		Cwd:    request.Cwd,
		Branch: request.Branch,
		Kind:   request.Kind,
		Label:  "task " + taskID,
		TaskID: taskID,
		Weight: normalizeWeight(request.Weight),
	})
	if err != nil {
		return dispatch{}, false, err
	}
	job := dispatch{
		ID:       taskID,
		At:       time.Now().Unix(),
		Prompt:   request.Prompt,
		Kind:     request.Kind,
		Cwd:      request.Cwd,
		Branch:   request.Branch,
		Strategy: "single",
		Weight:   normalizeWeight(request.Weight),
		Targets:  targets,
		Jobs:     make([]dispatchedJob, len(targets)),
	}

	type offerResult struct {
		base   string
		answer jobOfferAnswer
		err    error
	}
	results := make([]offerResult, len(targets))
	var wait sync.WaitGroup
	for index, target := range targets {
		index, target := index, target
		wait.Add(1)
		go func() {
			defer wait.Done()
			base := fleetBase(target)
			results[index] = offerResult{base: base}
			answer, err := postJobOffer(ctx, base, body)
			results[index].answer, results[index].err = answer, err
		}()
	}
	wait.Wait()

	weight := normalizeWeight(request.Weight)
	accepted := make([]int, 0, len(targets))
	for index, result := range results {
		entry := &job.Jobs[index]
		entry.Host = result.base
		entry.TaskID = taskID
		entry.Weight = weight
		if result.err != nil {
			entry.Status = "declined"
			entry.Error = result.err.Error()
			continue
		}
		if !result.answer.Accept {
			entry.Status = "declined"
			entry.Error = result.answer.Reason
			continue
		}
		accepted = append(accepted, index)
	}
	sort.SliceStable(accepted, func(left, right int) bool {
		return marketScore(results[accepted[left]].answer, weight) > marketScore(results[accepted[right]].answer, weight)
	})

	startedAny := false
	for _, index := range accepted {
		entry := &job.Jobs[index]
		base := results[index].base
		started, startErr := postJobStart(ctx, base, body)
		if startErr != nil {
			running, workspaceID, jobID, queried := getJobTask(ctx, base, taskID)
			if queried && running {
				// The start took effect even though the response was lost.
				entry.Local = jobID
				entry.WorkspaceID = workspaceID
				entry.TaskID = taskID
				entry.Status = "started"
				startedAny = true
				break
			}
			entry.Error = startErr.Error()
			entry.Status = "declined"
			var statusErr *selfFetchError
			if !queried && !errors.As(startErr, &statusErr) {
				// A network failure with no answer from the target: it may have
				// started. Do not risk a second workspace on another machine.
				entry.Status = "unknown"
				entry.Error = "start outcome unknown; check " + base
				break
			}
			continue
		}
		entry.Local = started.JobID
		entry.WorkspaceID = started.WorkspaceID
		entry.Branch = started.Branch
		entry.TaskID = taskID
		entry.Status = "started"
		entry.LeaseUntil = time.Now().Add(2 * time.Minute).Unix()
		startedAny = true
		break
	}
	for _, index := range accepted {
		entry := &job.Jobs[index]
		if entry.WorkspaceID == "" && entry.Status == "" {
			entry.Status = "not selected"
		}
	}

	return job, startedAny, nil
}

// dispatchMarket is the HTTP entry point for one market task.
func (s *Server) dispatchMarket(w http.ResponseWriter, r *http.Request, request dispatchRequest, targets []string) {
	job, started, err := s.runMarket(r.Context(), request, targets, newTaskID())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "invalid_request", err.Error())
		return
	}
	s.storeDispatch(job)
	writeJSON(w, http.StatusOK, map[string]any{"ok": started, "dispatch": job})
}

func (s *Server) storeDispatch(job dispatch) {
	s.dispatch.mu.Lock()
	s.dispatch.dispatch = append(s.dispatch.dispatch, job)
	if len(s.dispatch.dispatch) > 20 {
		s.dispatch.dispatch = s.dispatch.dispatch[len(s.dispatch.dispatch)-20:]
	}
	s.dispatch.saveLocked()
	s.dispatch.mu.Unlock()
}

// handleDispatchRetry re-runs the market for a task that never started, using
// the same task id and targets stored on the board. If a target already has the
// task (a lost start response), it adopts that job instead of starting another.
func (s *Server) handleDispatchRetry(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, "POST")
		return
	}
	var request struct {
		ID string `json:"id"`
	}
	if !decodeBody(w, r, &request) {
		return
	}
	id := strings.TrimSpace(request.ID)
	if id == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "id is required")
		return
	}
	s.dispatch.mu.Lock()
	index := -1
	var entry dispatch
	for candidate, known := range s.dispatch.dispatch {
		if known.ID == id {
			index = candidate
			entry = known
			break
		}
	}
	s.dispatch.mu.Unlock()
	if index < 0 {
		writeNotFound(w)
		return
	}
	if entry.Strategy != "single" {
		writeError(w, http.StatusConflict, "not_a_market", "only single-machine tasks can be re-offered")
		return
	}
	for _, job := range entry.Jobs {
		if job.WorkspaceID != "" {
			writeError(w, http.StatusConflict, "already_started",
				"this task already started; retrying it would risk two workspaces")
			return
		}
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	// A lost start response may have created a workspace. Adopt it; never
	// start a second one for the same task.
	for _, job := range entry.Jobs {
		if job.Host == "" {
			continue
		}
		running, workspaceID, jobID, ok := getJobTask(ctx, job.Host, entry.ID)
		if !ok || !running {
			continue
		}
		s.dispatch.mu.Lock()
		for candidate := range s.dispatch.dispatch {
			if s.dispatch.dispatch[candidate].ID != id {
				continue
			}
			for jobIndex := range s.dispatch.dispatch[candidate].Jobs {
				if s.dispatch.dispatch[candidate].Jobs[jobIndex].Host == job.Host {
					s.dispatch.dispatch[candidate].Jobs[jobIndex].Local = jobID
					s.dispatch.dispatch[candidate].Jobs[jobIndex].WorkspaceID = workspaceID
					s.dispatch.dispatch[candidate].Jobs[jobIndex].TaskID = entry.ID
					s.dispatch.dispatch[candidate].Jobs[jobIndex].Status = "started"
				}
			}
		}
		s.dispatch.saveLocked()
		s.dispatch.mu.Unlock()
		updated, _ := s.dispatchByID(id)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "dispatch": updated})
		return
	}

	market := dispatchRequest{
		Prompt: entry.Prompt, Cwd: entry.Cwd, Branch: entry.Branch,
		Kind: entry.Kind, Weight: entry.Weight, Strategy: "single", Targets: entry.Targets,
	}
	updated, started, err := s.runMarket(ctx, market, entry.Targets, entry.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "invalid_request", err.Error())
		return
	}
	s.dispatch.mu.Lock()
	for candidate := range s.dispatch.dispatch {
		if s.dispatch.dispatch[candidate].ID == id {
			s.dispatch.dispatch[candidate] = updated
		}
	}
	s.dispatch.saveLocked()
	s.dispatch.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"ok": started, "dispatch": updated})
}

func (s *Server) dispatchByID(id string) (dispatch, bool) {
	s.dispatch.mu.Lock()
	defer s.dispatch.mu.Unlock()
	for _, entry := range s.dispatch.dispatch {
		if entry.ID == id {
			return entry, true
		}
	}
	return dispatch{}, false
}

func offerCapacity(answer jobOfferAnswer) int {
	if answer.MaxTasks <= 0 {
		return 1 << 30
	}
	free := answer.MaxTasks - answer.Running
	if free < 0 {
		return 0
	}
	return free
}

// marketScore ranks accepted offers. Free capacity dominates; then a heavy task
// prefers a big machine, while a light task prefers a small one so the big
// machines stay available for heavy work. A target that cannot take the weight
// has already declined at its own gate.
func marketScore(answer jobOfferAnswer, weight string) int {
	score := offerCapacity(answer) * 1_000_000
	switch weight {
	case "heavy":
		score += answer.CPUs*10_000 + answer.MemAvailableMB
	case "light":
		score -= answer.CPUs*10_000 + answer.MemAvailableMB
	default:
		score += answer.MemAvailableMB
	}
	return score
}

func newTaskID() string {
	var suffix [4]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		return fmt.Sprintf("task-%d", time.Now().UnixNano())
	}
	return "task-" + time.Now().Format("20060102-150405") + "-" + hex.EncodeToString(suffix[:])
}

func postJobOffer(ctx context.Context, base string, body []byte) (jobOfferAnswer, error) {
	requestCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodPost,
		base+"/api/v1/herdr/job/offer", bytes.NewReader(body))
	if err != nil {
		return jobOfferAnswer{}, err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := selfClient.Do(request)
	if err != nil {
		return jobOfferAnswer{}, err
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return jobOfferAnswer{}, &selfFetchError{url: base, status: response.StatusCode}
	}
	var answer jobOfferAnswer
	if err := json.NewDecoder(response.Body).Decode(&answer); err != nil {
		return jobOfferAnswer{}, err
	}
	return answer, nil
}

func getJobTask(ctx context.Context, base, taskID string) (bool, string, string, bool) {
	requestCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet,
		base+"/api/v1/herdr/job/task/"+url.PathEscape(taskID), nil)
	if err != nil {
		return false, "", "", false
	}
	response, err := selfClient.Do(request)
	if err != nil {
		return false, "", "", false
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return false, "", "", false
	}
	var answer struct {
		OK          bool   `json:"ok"`
		Running     bool   `json:"running"`
		JobID       string `json:"jobId"`
		WorkspaceID string `json:"workspaceId"`
	}
	if json.NewDecoder(response.Body).Decode(&answer) != nil || !answer.OK {
		return false, "", "", false
	}
	return answer.Running, answer.WorkspaceID, answer.JobID, true
}

func postJobStart(ctx context.Context, base string, body []byte) (jobStarted, error) {
	requestCtx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodPost,
		base+"/api/v1/herdr/job", bytes.NewReader(body))
	if err != nil {
		return jobStarted{}, err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := selfClient.Do(request)
	if err != nil {
		return jobStarted{}, err
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		var failure struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		_ = json.NewDecoder(response.Body).Decode(&failure)
		if failure.Error.Message != "" {
			return jobStarted{}, &selfFetchError{url: base, status: response.StatusCode, err: errorString(failure.Error.Message)}
		}
		return jobStarted{}, &selfFetchError{url: base, status: response.StatusCode}
	}
	var started jobStarted
	if err := json.NewDecoder(response.Body).Decode(&started); err != nil {
		return jobStarted{}, err
	}
	return started, nil
}

type errorString string

func (e errorString) Error() string { return string(e) }

// handleDispatchList reports every dispatch and how each machine is doing.
//
// handleDispatchStop asks the machine running a job to close its workspace.
//
// The browser cannot call the target directly: it is another origin, and the
// target's guard refuses cross-origin writes. The dispatcher is the same origin
// and already speaks to every target, so it proxies the stop and remembers that
// the job is gone instead of polling a workspace that no longer exists.
func (s *Server) handleDispatchStop(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, "POST")
		return
	}
	var request struct {
		Host        string `json:"host"`
		WorkspaceID string `json:"workspaceId"`
	}
	if !decodeBody(w, r, &request) {
		return
	}
	host := strings.TrimRight(strings.TrimSpace(request.Host), "/")
	workspaceID := strings.Trim(strings.TrimSpace(request.WorkspaceID), "/")
	if host == "" || workspaceID == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "host and workspaceId are required")
		return
	}
	if !strings.HasPrefix(host, "http://") && !strings.HasPrefix(host, "https://") {
		writeError(w, http.StatusBadRequest, "invalid_request", "host must be an http(s) console address")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	target := host + "/api/v1/herdr/job/" + url.PathEscape(workspaceID) + "/stop"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, nil)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	response, err := selfClient.Do(req)
	if err != nil {
		writeBadGateway(w, "herdr_job_failed", err)
		return
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		writeError(w, http.StatusBadGateway, "herdr_job_failed",
			"the target answered "+response.Status)
		return
	}

	s.dispatch.mu.Lock()
	for index := range s.dispatch.dispatch {
		for jobIndex := range s.dispatch.dispatch[index].Jobs {
			job := &s.dispatch.dispatch[index].Jobs[jobIndex]
			if strings.TrimRight(job.Host, "/") == host && job.WorkspaceID == workspaceID {
				job.Cancelled = true
				job.Status = "stopped"
				job.Error = ""
			}
		}
	}
	s.dispatch.saveLocked()
	s.dispatch.mu.Unlock()

	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "host": host, "workspaceId": workspaceID})
}

// The status is asked of the machine running the job, not remembered: a console
// that restarted, or that was never the one dispatching, still gets the truth.
func (s *Server) handleDispatchList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, "GET")
		return
	}
	s.dispatch.mu.Lock()
	history := make([]dispatch, len(s.dispatch.dispatch))
	for index, entry := range s.dispatch.dispatch {
		history[index] = entry
		history[index].Jobs = append([]dispatchedJob(nil), entry.Jobs...)
	}
	s.dispatch.mu.Unlock()

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	for index := range history {
		for jobIndex := range history[index].Jobs {
			job := &history[index].Jobs[jobIndex]
			if job.Cancelled {
				job.Status = "stopped"
				job.Error = ""
				continue
			}
			if job.Local == "" {
				continue
			}
			status, output, err := getJobStatus(ctx, job.Host, job.Local)
			if err != nil {
				job.Error = err.Error()
				if job.WorkspaceID != "" && job.LeaseUntil > 0 && time.Now().Unix() > job.LeaseUntil {
					job.Lost = true
				}
				continue
			}
			job.Status = status
			job.Output = output
			if job.WorkspaceID != "" {
				if answer, ok := getJobDiff(ctx, job.Host, job.WorkspaceID); ok {
					job.DiffReady = true
					job.CheckoutPath = answer.CheckoutPath
					if answer.Branch != "" {
						job.Branch = answer.Branch
					}
					job.Commits = answer.Commits
					job.Changed = answer.Changed
				}
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"dispatches": history})
}

type jobDiffAnswer struct {
	Branch       string
	CheckoutPath string
	Commits      []string
	Changed      []string
}

// getJobDiff asks the machine running the job what its worktree contains. ok is
// false when the target has nothing to collect (no worktree, or it could not
// answer), so the panel does not mistake "unknown" for "no commits".
func getJobDiff(ctx context.Context, base, workspaceID string) (jobDiffAnswer, bool) {
	requestCtx, cancel := context.WithTimeout(ctx, jobPollTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet,
		base+"/api/v1/herdr/job/"+workspaceID+"/diff", nil)
	if err != nil {
		return jobDiffAnswer{}, false
	}
	response, err := selfClient.Do(request)
	if err != nil {
		return jobDiffAnswer{}, false
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return jobDiffAnswer{}, false
	}
	var answer struct {
		OK           bool     `json:"ok"`
		Branch       string   `json:"branch"`
		CheckoutPath string   `json:"checkoutPath"`
		Commits      []string `json:"commits"`
		Changed      []string `json:"changed"`
	}
	if json.NewDecoder(response.Body).Decode(&answer) != nil {
		return jobDiffAnswer{}, false
	}
	if !answer.OK || strings.TrimSpace(answer.CheckoutPath) == "" {
		return jobDiffAnswer{}, false
	}
	if answer.Commits == nil {
		answer.Commits = []string{}
	}
	if answer.Changed == nil {
		answer.Changed = []string{}
	}
	return jobDiffAnswer{
		Branch:       answer.Branch,
		CheckoutPath: answer.CheckoutPath,
		Commits:      answer.Commits,
		Changed:      answer.Changed,
	}, true
}

func getJobStatus(ctx context.Context, base, jobID string) (string, string, error) {
	requestCtx, cancel := context.WithTimeout(ctx, jobPollTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet,
		base+"/api/v1/herdr/job/"+jobID, nil)
	if err != nil {
		return "", "", err
	}
	response, err := selfClient.Do(request)
	if err != nil {
		return "", "", err
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return "", "", &selfFetchError{url: base, status: response.StatusCode}
	}
	var answer struct {
		Status string `json:"status"`
		Output string `json:"output"`
	}
	if err := json.NewDecoder(response.Body).Decode(&answer); err != nil {
		return "", "", err
	}
	return answer.Status, answer.Output, nil
}
