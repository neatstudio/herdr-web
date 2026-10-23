package server

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
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
	if limit := maxJobs(); limit > 0 && s.ledger.runningCount() >= limit {
		writeError(w, http.StatusTooManyRequests, "at_capacity",
			fmt.Sprintf("this console is already running %d jobs (HERDR_WEB_MAX_JOBS=%d)", s.ledger.runningCount(), limit))
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
	if cwd := expandHome(request.Cwd); cwd != "" {
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

	s.ledger.started(created.Workspace.WorkspaceID, paneID, request.Kind, label)
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
	s.ledger.stopped(workspaceID)
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

// maxJobs is the operator's concurrency cap for this machine. Zero means no
// cap: the console does not guess how many agents a host can run.
func maxJobs() int {
	raw := strings.TrimSpace(os.Getenv("HERDR_WEB_MAX_JOBS"))
	if raw == "" {
		return 0
	}
	limit, err := strconv.Atoi(raw)
	if err != nil || limit < 0 {
		return 0
	}
	return limit
}

// selfTools lists the command-line tools this host can offer a dispatched job.
// It is a capability advertisement, not a sandbox: the agent still runs as this
// user and can use whatever is on PATH.
func selfTools() []string {
	candidates := []string{"git", "tmux", "docker", "node", "go", "python3", "bun"}
	found := make([]string, 0, len(candidates))
	for _, name := range candidates {
		if _, err := lookPath(name); err == nil {
			found = append(found, name)
		}
	}
	return found
}

// selfModels is the operator's declared model set for this host, if any. herdr
// does not report a model per agent, so this is configuration rather than
// detection.
func selfModels() []string {
	raw := strings.TrimSpace(os.Getenv("HERDR_WEB_MODELS"))
	if raw == "" {
		return []string{}
	}
	models := make([]string, 0, 4)
	for _, model := range strings.Split(raw, ",") {
		if model = strings.TrimSpace(model); model != "" {
			models = append(models, model)
		}
	}
	return models
}

// handleJobLedger reports this machine's own events and capacity. The events are
// in memory for now; the workspaces themselves are herdr's.
func (s *Server) handleJobLedger(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, "GET")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"maxTasks": maxJobs(),
		"running":  s.ledger.runningCount(),
		"events":   s.ledger.snapshot(),
	})
}

// jobStateDir is where a dispatched job's record is kept, so a console that
// restarted can still report what it sent where.
func jobStateDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".local", "share", selfStateDirName, "jobs")
}

// jobDiff is what a job left behind in its worktree: the branch, the commits, and
// whatever is still uncommitted. It is the half of a dispatched job that makes the
// result worth collecting.
type jobDiff struct {
	OK           bool     `json:"ok"`
	Branch       string   `json:"branch"`
	CheckoutPath string   `json:"checkoutPath"`
	Commits      []string `json:"commits"`
	Changed      []string `json:"changed"`
	Error        string   `json:"error,omitempty"`
}

// handleJobDiff reports what the job's worktree contains.
//
// The checkout is herdr's own worktree for that workspace, so this is read-only: it
// runs git in a directory herdr created and reports, and never writes to the
// operator's repository.
func (s *Server) handleJobDiff(w http.ResponseWriter, r *http.Request, workspaceID string) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, "GET")
		return
	}
	workspaceID = strings.Trim(strings.TrimSpace(workspaceID), "/")
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "workspace id is required")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	var answer struct {
		Workspace struct {
			Label    string `json:"label"`
			Worktree *struct {
				CheckoutPath string `json:"checkout_path"`
				RepoRoot     string `json:"repo_root"`
			} `json:"worktree"`
		} `json:"workspace"`
	}
	if err := s.client().Call(ctx, "workspace.get",
		map[string]any{"workspace_id": workspaceID}, &answer); err != nil {
		writeBadGateway(w, "herdr_job_failed", err)
		return
	}
	checkout := ""
	repoRoot := ""
	if answer.Workspace.Worktree != nil {
		checkout = strings.TrimSpace(answer.Workspace.Worktree.CheckoutPath)
		repoRoot = strings.TrimSpace(answer.Workspace.Worktree.RepoRoot)
	}
	if checkout == "" {
		writeJSON(w, http.StatusOK, jobDiff{OK: true,
			Error: "this workspace is not a worktree, so there is nothing to collect"})
		return
	}

	gitIn := func(dir string, args ...string) (string, error) {
		command := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
		output, err := command.Output()
		return string(output), err
	}
	git := func(args ...string) (string, error) {
		return gitIn(checkout, args...)
	}

	diff := jobDiff{OK: true, CheckoutPath: checkout}
	if branch, err := git("branch", "--show-current"); err == nil {
		diff.Branch = strings.TrimSpace(branch)
	}

	// The commits the job made, not the commits it inherited. The worktree was
	// forked from the repository's current HEAD, so the merge base with that
	// checkout is the fork point. A worktree that has no fork point of its own
	// falls back to the repository's mainline; a job that committed nothing
	// leaves an empty list, which is a result worth saying out loud.
	base := ""
	if repoRoot != "" && !sameDir(repoRoot, checkout) {
		if rootHead, err := gitIn(repoRoot, "rev-parse", "HEAD"); err == nil {
			if fork, err := git("merge-base", "HEAD", strings.TrimSpace(rootHead)); err == nil {
				base = strings.TrimSpace(fork)
			}
		}
	}
	if base == "" {
		for _, candidate := range []string{"main", "master", "trunk", "develop"} {
			if _, err := git("rev-parse", "--verify", "--quiet", candidate+"^{commit}"); err == nil {
				base = candidate
				break
			}
		}
	}
	if base == "" {
		if upstream, err := git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"); err == nil {
			base = strings.TrimSpace(upstream)
		}
	}
	logArgs := []string{"log", "--pretty=%h %s"}
	if base == "" {
		logArgs = append(logArgs, "-10")
	} else {
		logArgs = append(logArgs, base+"..HEAD")
	}
	if log, err := git(logArgs...); err == nil {
		for _, line := range strings.Split(strings.TrimSpace(log), "\n") {
			if line = strings.TrimSpace(line); line != "" {
				diff.Commits = append(diff.Commits, line)
			}
		}
	}
	if status, err := git("status", "--porcelain"); err == nil {
		// Keep the two status columns: " M" and "M " mean different things, and
		// the panel shows the file exactly as git reports it.
		for _, line := range strings.Split(strings.TrimRight(status, "\n"), "\n") {
			if strings.TrimSpace(line) != "" {
				diff.Changed = append(diff.Changed, line)
			}
		}
	}
	if diff.Commits == nil {
		diff.Commits = []string{}
	}
	if diff.Changed == nil {
		diff.Changed = []string{}
	}
	writeJSON(w, http.StatusOK, diff)
}

// sameDir reports whether two paths name the same directory. It is only used to
// decide whether the repository root is a second checkout (the usual worktree
// case) or the worktree itself.
func sameDir(left, right string) bool {
	leftPath, leftErr := filepath.Abs(left)
	rightPath, rightErr := filepath.Abs(right)
	return leftErr == nil && rightErr == nil && leftPath == rightPath
}
