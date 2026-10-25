package server

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"

	"herdr-web/server/sharedledger"
)

type webhookPayload struct {
	Action     string `json:"action"`
	Repository struct {
		FullName string `json:"full_name"`
	} `json:"repository"`
	Issue *struct {
		Number  int    `json:"number"`
		Title   string `json:"title"`
		Body    string `json:"body"`
		HTMLURL string `json:"html_url"`
		User    struct {
			Login string `json:"login"`
		} `json:"user"`
	} `json:"issue"`
}

// handleWebhook turns provider issue events into shared tasks. The signature is
// verified with the repo's webhook secret before any state changes.
func (s *Server) handleWebhook(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, "POST")
		return
	}
	provider := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/webhooks/"), "/")
	if provider != "github" && provider != "gitea" {
		writeNotFound(w)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "cannot read body")
		return
	}
	var payload webhookPayload
	if json.Unmarshal(body, &payload) != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "invalid JSON")
		return
	}
	repo, ok := s.findWebhookRepo(provider, payload.Repository.FullName)
	if !ok {
		writeError(w, http.StatusNotFound, "repo_not_found", "repository is not registered")
		return
	}
	secret := strings.TrimSpace(os.Getenv(repo.WebhookSecretEnv))
	if secret == "" {
		writeError(w, http.StatusServiceUnavailable, "webhook_unconfigured",
			"webhook secret environment variable is not set")
		return
	}
	signature := r.Header.Get("X-Hub-Signature-256")
	if provider == "gitea" {
		signature = r.Header.Get("X-Gitea-Signature")
	}
	if !validWebhookSignature(secret, body, signature, provider) {
		writeError(w, http.StatusUnauthorized, "invalid_signature", "webhook signature is invalid")
		return
	}
	event := r.Header.Get("X-GitHub-Event")
	if provider == "gitea" {
		event = r.Header.Get("X-Gitea-Event")
	}
	if event != "issues" || payload.Action != "opened" || payload.Issue == nil {
		writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "ignored": true})
		return
	}
	issue := payload.Issue
	taskID := repo.ID + "#" + strconv.Itoa(issue.Number)
	if _, err := s.sharedLedger.Get(r.Context(), taskID); err == nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "taskId": taskID, "existing": true})
		return
	}
	prompt := strings.TrimSpace(issue.Title + "\n\n" + issue.Body)
	task, err := s.sharedLedger.Create(r.Context(), sharedledger.Task{
		ID: taskID, Title: issue.Title, Prompt: prompt,
		Cwd: repo.Checkout, Branch: "job/issue-" + strconv.Itoa(issue.Number),
		Kind: "claude", Weight: "standard", Repo: repo.ID, Issue: issue.Number,
	})
	if err != nil {
		writeLedgerError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"ok": true, "task": task})
}

func (s *Server) findWebhookRepo(provider, fullName string) (Repo, bool) {
	fullName = strings.Trim(strings.TrimSpace(fullName), "/")
	for _, repo := range s.repos.List() {
		if repo.Provider == provider && strings.EqualFold(repo.Owner+"/"+repo.Name, fullName) {
			return repo, true
		}
	}
	return Repo{}, false
}

func validWebhookSignature(secret string, body []byte, signature, provider string) bool {
	if signature == "" {
		return false
	}
	if provider == "github" {
		signature = strings.TrimPrefix(signature, "sha256=")
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write(body)
	expected := hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(expected), []byte(signature))
}
