package server

import (
	"context"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// A job is one agent started on one machine for one prompt.
//
// The console that started it is only a client: the workspace, the pane and the
// agent live on the machine doing the work, so a different console can look at the
// job — or send it an answer — without the console that started it being up. That
// is the same rule the fleet follows for everything else.
type jobRequest struct {
	Prompt string `json:"prompt"`
	// Cwd is the repository (or directory) to work in. With Branch, the work
	// happens in a git worktree, so two jobs on one machine do not collide.
	Cwd    string `json:"cwd"`
	Branch string `json:"branch"`
	// Kind is the agent to start, e.g. "claude" or "opencode".
	Kind string `json:"kind"`
	// Label names the workspace; defaults to the job id.
	Label string `json:"label"`
}

type jobStarted struct {
	OK          bool   `json:"ok"`
	JobID       string `json:"jobId"`
	WorkspaceID string `json:"workspaceId"`
	PaneID      string `json:"paneId"`
	Branch      string `json:"branch,omitempty"`
	Error       string `json:"error,omitempty"`
}

// handleJobStart starts an agent on this machine and gives it the prompt.
//
// It returns as soon as the prompt is submitted: an agent turn can take minutes,
// and a request that waits for it would be a request that times out.
func (s *Server) handleJobStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, "POST")
		return
	}
	var request jobRequest
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

	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()

	// A workspace is the unit herdr places work in; a worktree keeps each job's
	// checkout apart when the work is in a repository.
	var created struct {
		Workspace struct {
			WorkspaceID string `json:"workspace_id"`
			Label       string `json:"label"`
		} `json:"workspace"`
		RootPane struct {
			PaneID string `json:"pane_id"`
		} `json:"root_pane"`
	}
	label := strings.TrimSpace(request.Label)
	if label == "" {
		label = "job " + time.Now().Format("15:04:05")
	}
	params := map[string]any{"focus": false, "label": label}
	if cwd := strings.TrimSpace(request.Cwd); cwd != "" {
		params["cwd"] = cwd
	}
	method := "workspace.create"
	if branch := strings.TrimSpace(request.Branch); branch != "" {
		method = "worktree.create"
		params["branch"] = branch
	}
	if err := s.client().Call(ctx, method, params, &created); err != nil {
		writeBadGateway(w, "herdr_job_failed", err)
		return
	}
	paneID := created.RootPane.PaneID
	if paneID == "" {
		writeError(w, http.StatusBadGateway, "herdr_job_failed", "herdr created a workspace with no pane")
		return
	}

	// The agent is started in that pane, then given the prompt. Both are separate
	// calls because herdr treats them as separate actions: start fails visibly if
	// the agent is not installed, prompt fails visibly if the agent is blocked.
	startParams := map[string]any{
		"name":    request.Kind,
		"kind":    request.Kind,
		"pane_id": paneID,
	}
	if err := s.client().Call(ctx, "agent.start", startParams, nil); err != nil {
		writeBadGateway(w, "herdr_agent_failed", err)
		return
	}
	if err := s.client().Call(ctx, "agent.prompt",
		map[string]any{"target": paneID, "text": request.Prompt}, nil); err != nil {
		writeBadGateway(w, "herdr_prompt_failed", err)
		return
	}

	writeJSON(w, http.StatusOK, jobStarted{
		OK:          true,
		JobID:       paneID,
		WorkspaceID: created.Workspace.WorkspaceID,
		PaneID:      paneID,
		Branch:      strings.TrimSpace(request.Branch),
	})
}

// handleJobStatus reports how the job is doing and what the agent has said.
//
// The status is herdr's agent status, and "blocked" is the interesting one: it
// means the agent wants a human, and the answer can be typed from whichever
// console is open.
func (s *Server) handleJobStatus(w http.ResponseWriter, r *http.Request, paneID string) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, "GET")
		return
	}
	paneID = strings.Trim(strings.TrimSpace(paneID), "/")
	if paneID == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "job id is required")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()

	var agent struct {
		Agent struct {
			Status string `json:"agent_status"`
			PaneID string `json:"pane_id"`
			Kind   string `json:"kind"`
		} `json:"agent"`
	}
	// An agent that has exited is not a job that failed: herdr keeps the pane, and
	// the transcript is still there to read.
	statusErr := s.client().Call(ctx, "agent.get", map[string]any{"target": paneID}, &agent)

	var read struct {
		Text string `json:"text"`
	}
	_ = s.client().Call(ctx, "agent.read", map[string]any{
		"target":     paneID,
		"source":     "recent",
		"lines":      80,
		"strip_ansi": true,
	}, &read)

	status := agent.Agent.Status
	if statusErr != nil && read.Text == "" {
		writeBadGateway(w, "herdr_job_failed", statusErr)
		return
	}
	if status == "" {
		status = "unknown"
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":     true,
		"jobId":  paneID,
		"status": status,
		"kind":   agent.Agent.Kind,
		"output": read.Text,
	})
}

// handleJobStop closes the workspace a job lives in, which ends its agent and
// discards the checkout it was given.
func (s *Server) handleJobStop(w http.ResponseWriter, r *http.Request, workspaceID string) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, "POST")
		return
	}
	workspaceID = strings.Trim(strings.TrimSpace(workspaceID), "/")
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "workspace id is required")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	if err := s.client().Call(ctx, "workspace.close",
		map[string]any{"workspace_id": workspaceID}, nil); err != nil {
		writeBadGateway(w, "herdr_job_failed", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "workspaceId": workspaceID})
}

// selfAgentKinds is jobAgentKinds, computed once: every heartbeat asks, and the
// answer only changes when the machine is reinstalled.
var (
	agentKindsOnce  sync.Once
	agentKindsCache []string
)

func selfAgentKinds() []string {
	agentKindsOnce.Do(func() {
		agentKindsCache = jobAgentKinds()
	})
	return agentKindsCache
}

// handleAgentKinds reports which agents this host can start.
func (s *Server) handleAgentKinds(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, "GET")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"kinds": jobAgentKinds()})
}

// jobAgentKinds lists the agents this host can start, by looking for their names
// on PATH. The panel offers what is actually installed rather than a fixed list.
func jobAgentKinds() []string {
	candidates := []string{"claude", "opencode", "codex", "qwen", "aider", "gemini"}
	found := make([]string, 0, len(candidates))
	for _, name := range candidates {
		if _, err := lookPath(name); err == nil {
			found = append(found, name)
		}
	}
	return found
}

// lookPath is exec.LookPath as a variable, so a test can pretend an agent is
// installed without installing one.
var lookPath = exec.LookPath

// jobStateDir is where a dispatched job's record is kept, so a console that
// restarted can still report what it sent where.
func jobStateDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".local", "share", selfStateDirName, "jobs")
}
