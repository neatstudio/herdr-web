package server

import (
	"net/http"
	"strconv"
	"strings"

	"herdr-web/server/sharedledger"
)

func (s *Server) handleRepos(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "repos": s.repos.List()})
	case http.MethodPost:
		var repo Repo
		if !decodeBody(w, r, &repo) {
			return
		}
		created, err := s.repos.Add(repo)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid_repo", err.Error())
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{"ok": true, "repo": created})
	default:
		writeMethodNotAllowed(w, "GET, POST")
	}
}

func (s *Server) handleRepoAction(w http.ResponseWriter, r *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/repos/"), "/")
	if rest == "" {
		writeNotFound(w)
		return
	}
	action := ""
	for _, candidate := range []string{"issues", "tasks", "pull", "merge"} {
		if strings.HasSuffix(rest, "/"+candidate) {
			action = candidate
			rest = strings.TrimSuffix(rest, "/"+candidate)
			break
		}
	}
	if strings.TrimSpace(rest) == "" {
		writeNotFound(w)
		return
	}
	repo, ok := s.repos.Get(rest)
	if !ok {
		writeNotFound(w)
		return
	}
	if action == "" {
		if r.Method != http.MethodDelete {
			writeMethodNotAllowed(w, "DELETE")
			return
		}
		if err := s.repos.Remove(repo.ID); err != nil {
			writeError(w, http.StatusNotFound, "repo_not_found", err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "id": repo.ID})
		return
	}
	switch action {
	case "issues":
		if r.Method != http.MethodGet {
			writeMethodNotAllowed(w, "GET")
			return
		}
		state := strings.TrimSpace(r.URL.Query().Get("state"))
		limit := 50
		if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
			if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
				limit = parsed
			}
		}
		issues, err := repo.listIssues(r.Context(), state, limit)
		if err != nil {
			writeBadGateway(w, "repo_failed", err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "issues": issues})
	case "tasks":
		if r.Method != http.MethodPost {
			writeMethodNotAllowed(w, "POST")
			return
		}
		var request struct {
			Issue  int    `json:"issue"`
			Prompt string `json:"prompt"`
			Branch string `json:"branch"`
			Kind   string `json:"kind"`
			Weight string `json:"weight"`
		}
		if !decodeBody(w, r, &request) {
			return
		}
		if request.Issue <= 0 {
			writeError(w, http.StatusBadRequest, "invalid_request", "issue is required")
			return
		}
		issues, err := repo.listIssues(r.Context(), "all", 100)
		if err != nil {
			writeBadGateway(w, "repo_failed", err)
			return
		}
		var issue *providerIssue
		for index := range issues {
			if issues[index].Number == request.Issue {
				issue = &issues[index]
				break
			}
		}
		if issue == nil {
			writeError(w, http.StatusNotFound, "issue_not_found", "issue not found")
			return
		}
		prompt := strings.TrimSpace(request.Prompt)
		if prompt == "" {
			prompt = strings.TrimSpace(issue.Title + "\n\n" + issue.Body)
		}
		branch := strings.TrimSpace(request.Branch)
		if branch == "" {
			branch = "job/issue-" + strconv.Itoa(issue.Number)
		}
		kind := strings.TrimSpace(request.Kind)
		if kind == "" {
			kind = "claude"
		}
		weight := strings.TrimSpace(request.Weight)
		if weight == "" {
			weight = "standard"
		}
		task, err := s.sharedLedger.Create(r.Context(), sharedledger.Task{
			ID:          repo.ID + "#" + strconv.Itoa(issue.Number),
			Title:       issue.Title,
			Prompt:      prompt,
			Cwd:         repo.Checkout,
			Branch:      branch,
			Kind:        kind,
			Weight:      weight,
			Repo:        repo.ID,
			CloneURL:    repo.cloneURL(),
			TokenEnv:    repo.TokenEnv,
			BaseBranch:  repo.DefaultBranch,
			TestCommand: repo.TestCommand,
			Issue:       issue.Number,
		})
		if err != nil {
			writeLedgerError(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{"ok": true, "task": task})
	case "pull":
		if r.Method != http.MethodPost {
			writeMethodNotAllowed(w, "POST")
			return
		}
		var request struct {
			Head   string `json:"head"`
			Base   string `json:"base"`
			Title  string `json:"title"`
			Body   string `json:"body"`
			TaskID string `json:"taskId"`
		}
		if !decodeBody(w, r, &request) {
			return
		}
		head := strings.TrimSpace(request.Head)
		if head == "" {
			writeError(w, http.StatusBadRequest, "invalid_request", "head branch is required")
			return
		}
		base := strings.TrimSpace(request.Base)
		if base == "" {
			base = repo.DefaultBranch
		}
		title := strings.TrimSpace(request.Title)
		if title == "" {
			title = "Task " + head
		}
		pull, err := repo.createPull(r.Context(), head, base, title, request.Body)
		if err != nil {
			writeBadGateway(w, "repo_failed", err)
			return
		}
		if request.TaskID != "" {
			if _, err := s.sharedLedger.LinkPR(r.Context(), request.TaskID, pull.Number); err != nil {
				writeLedgerError(w, err)
				return
			}
		}
		writeJSON(w, http.StatusCreated, map[string]any{"ok": true, "pull": pull})
	case "merge":
		if r.Method != http.MethodPost {
			writeMethodNotAllowed(w, "POST")
			return
		}
		var request struct {
			Number int    `json:"number"`
			Method string `json:"method"`
			TaskID string `json:"taskId"`
		}
		if !decodeBody(w, r, &request) {
			return
		}
		if request.Number <= 0 {
			writeError(w, http.StatusBadRequest, "invalid_request", "pull number is required")
			return
		}
		method := strings.TrimSpace(request.Method)
		if method == "" {
			method = "merge"
		}
		pull, err := repo.mergePull(r.Context(), request.Number, method)
		if err != nil {
			writeBadGateway(w, "repo_failed", err)
			return
		}
		if request.TaskID != "" {
			if _, err := s.sharedLedger.LinkPR(r.Context(), request.TaskID, pull.Number); err != nil {
				writeLedgerError(w, err)
				return
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "pull": pull})
	default:
		writeNotFound(w)
	}
}
