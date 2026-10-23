package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/url"
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
}

type dispatch struct {
	ID     string          `json:"id"`
	At     int64           `json:"at"`
	Prompt string          `json:"prompt"`
	Jobs   []dispatchedJob `json:"jobs"`
}

type dispatchState struct {
	mu       sync.Mutex
	dispatch []dispatch
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
func (s *Server) handleDispatchJob(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, "POST")
		return
	}
	var request struct {
		Prompt  string   `json:"prompt"`
		Cwd     string   `json:"cwd"`
		Branch  string   `json:"branch"`
		Kind    string   `json:"kind"`
		Targets []string `json:"targets"`
	}
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

	job := dispatch{
		ID:     "job-" + time.Now().Format("20060102-150405"),
		At:     time.Now().Unix(),
		Prompt: request.Prompt,
		Jobs:   make([]dispatchedJob, 0, len(targets)),
	}
	for _, target := range targets {
		base := fleetBase(target)
		entry := dispatchedJob{Host: base}
		body, err := json.Marshal(jobRequest{
			Prompt: request.Prompt,
			Cwd:    request.Cwd,
			Branch: request.Branch,
			Kind:   request.Kind,
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
	s.dispatch.mu.Unlock()

	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "dispatch": job})
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
