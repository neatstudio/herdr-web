package server

import (
	"context"
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

// Repo is one GitHub or Gitea repository the console can list issues for and
// turn into tasks. The token is never stored: TokenEnv names an environment
// variable the process already has.
type Repo struct {
	ID               string `json:"id"`
	Provider         string `json:"provider"` // github | gitea
	BaseURL          string `json:"baseUrl"`
	Owner            string `json:"owner"`
	Name             string `json:"name"`
	DefaultBranch    string `json:"defaultBranch"`
	Checkout         string `json:"checkout"`
	TokenEnv         string `json:"tokenEnv"`
	WebhookSecretEnv string `json:"webhookSecretEnv"`
	TestCommand      string `json:"testCommand,omitempty"`
}

type repoRegistry struct {
	mu    sync.Mutex
	path  string
	repos map[string]Repo
}

var repoStatePathOverride string

func repoStatePath() string {
	if repoStatePathOverride != "" {
		return repoStatePathOverride
	}
	dir := jobStateDir()
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, "repos.json")
}

func newRepoRegistry() *repoRegistry {
	registry := &repoRegistry{path: repoStatePath(), repos: map[string]Repo{}}
	registry.load()
	return registry
}

func (r *repoRegistry) load() {
	if r.path == "" {
		return
	}
	raw, err := os.ReadFile(r.path)
	if err != nil {
		return
	}
	var stored []Repo
	if json.Unmarshal(raw, &stored) != nil {
		return
	}
	for _, repo := range stored {
		if repo.ID != "" && validProviderURL(repo.BaseURL) && allowedTokenEnv(repo.TokenEnv) {
			r.repos[repo.ID] = repo
		}
	}
}

func (r *repoRegistry) List() []Repo {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]Repo, 0, len(r.repos))
	for _, repo := range r.repos {
		out = append(out, repo)
	}
	sort.SliceStable(out, func(left, right int) bool { return out[left].ID < out[right].ID })
	return out
}

func (r *repoRegistry) Get(id string) (Repo, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	repo, ok := r.repos[id]
	return repo, ok
}

func (r *repoRegistry) Add(repo Repo) (Repo, error) {
	normalized, err := normalizeRepo(repo)
	if err != nil {
		return Repo{}, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.repos[normalized.ID] = normalized
	if err := r.saveLocked(); err != nil {
		return Repo{}, err
	}
	return normalized, nil
}

func (r *repoRegistry) Remove(id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.repos[id]; !ok {
		return errors.New("repository not found")
	}
	delete(r.repos, id)
	return r.saveLocked()
}

func (r *repoRegistry) saveLocked() error {
	if r.path == "" {
		return nil
	}
	out := make([]Repo, 0, len(r.repos))
	for _, repo := range r.repos {
		out = append(out, repo)
	}
	sort.SliceStable(out, func(left, right int) bool { return out[left].ID < out[right].ID })
	raw, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(r.path), 0o700); err != nil {
		return err
	}
	return os.WriteFile(r.path, raw, 0o600)
}

func normalizeRepo(repo Repo) (Repo, error) {
	repo.Provider = strings.ToLower(strings.TrimSpace(repo.Provider))
	repo.Owner = strings.Trim(strings.TrimSpace(repo.Owner), "/")
	repo.Name = strings.Trim(strings.TrimSpace(repo.Name), "/")
	repo.BaseURL = strings.TrimRight(strings.TrimSpace(repo.BaseURL), "/")
	repo.DefaultBranch = strings.TrimSpace(repo.DefaultBranch)
	repo.Checkout = strings.TrimSpace(repo.Checkout)
	repo.TokenEnv = strings.TrimSpace(repo.TokenEnv)
	repo.WebhookSecretEnv = strings.TrimSpace(repo.WebhookSecretEnv)
	repo.TestCommand = strings.TrimSpace(repo.TestCommand)
	if repo.Provider != "github" && repo.Provider != "gitea" {
		return Repo{}, errors.New("provider must be github or gitea")
	}
	if repo.Owner == "" || repo.Name == "" {
		return Repo{}, errors.New("owner and name are required")
	}
	if repo.BaseURL == "" {
		if repo.Provider == "github" {
			repo.BaseURL = "https://api.github.com"
		} else {
			return Repo{}, errors.New("baseUrl is required for gitea")
		}
	}
	if !validProviderURL(repo.BaseURL) {
		return Repo{}, errors.New("baseUrl must be https or private http")
	}
	if repo.TokenEnv == "" {
		if repo.Provider == "github" {
			repo.TokenEnv = "GITHUB_TOKEN"
		} else {
			repo.TokenEnv = "GITEA_TOKEN"
		}
	}
	if !allowedTokenEnv(repo.TokenEnv) {
		return Repo{}, errors.New("tokenEnv is not allowed")
	}
	if repo.WebhookSecretEnv == "" {
		if repo.Provider == "github" {
			repo.WebhookSecretEnv = "GITHUB_WEBHOOK_SECRET"
		} else {
			repo.WebhookSecretEnv = "GITEA_WEBHOOK_SECRET"
		}
	}
	if repo.DefaultBranch == "" {
		repo.DefaultBranch = "main"
	}
	if !validCheckoutRef(repo.DefaultBranch) {
		return Repo{}, errors.New("defaultBranch is not a plain git ref")
	}
	repo.ID = repo.Provider + ":" + repo.Owner + "/" + repo.Name
	return repo, nil
}

type providerIssue struct {
	Number      int      `json:"number"`
	Title       string   `json:"title"`
	Body        string   `json:"body"`
	State       string   `json:"state"`
	URL         string   `json:"html_url"`
	Author      string   `json:"author"`
	Labels      []string `json:"labels"`
	PullRequest bool     `json:"pullRequest"`
}

// listIssues reads the provider's issue list and filters out pull requests.
func (r Repo) listIssues(ctx context.Context, state string, limit int) ([]providerIssue, error) {
	if state == "" {
		state = "open"
	}
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	token := strings.TrimSpace(os.Getenv(r.TokenEnv))
	if token == "" {
		return nil, fmt.Errorf("%s is not set", r.TokenEnv)
	}
	switch r.Provider {
	case "github":
		return r.listGitHubIssues(ctx, token, state, limit)
	case "gitea":
		return r.listGiteaIssues(ctx, token, state, limit)
	default:
		return nil, errors.New("unsupported provider")
	}
}

func (r Repo) listGitHubIssues(ctx context.Context, token, state string, limit int) ([]providerIssue, error) {
	url := fmt.Sprintf("%s/repos/%s/%s/issues?state=%s&per_page=%d",
		r.BaseURL, r.Owner, r.Name, state, limit)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("Authorization", "Bearer "+token)
	var raw []struct {
		Number      int    `json:"number"`
		Title       string `json:"title"`
		Body        string `json:"body"`
		State       string `json:"state"`
		HTMLURL     string `json:"html_url"`
		PullRequest any    `json:"pull_request"`
		User        struct {
			Login string `json:"login"`
		} `json:"user"`
		Labels []struct {
			Name string `json:"name"`
		} `json:"labels"`
	}
	if err := getJSON(ctx, request, &raw); err != nil {
		return nil, err
	}
	out := make([]providerIssue, 0, len(raw))
	for _, issue := range raw {
		if issue.PullRequest != nil {
			continue
		}
		labels := make([]string, 0, len(issue.Labels))
		for _, label := range issue.Labels {
			labels = append(labels, label.Name)
		}
		out = append(out, providerIssue{
			Number: issue.Number, Title: issue.Title, Body: issue.Body,
			State: issue.State, URL: issue.HTMLURL, Author: issue.User.Login, Labels: labels,
		})
	}
	return out, nil
}

func (r Repo) listGiteaIssues(ctx context.Context, token, state string, limit int) ([]providerIssue, error) {
	url := fmt.Sprintf("%s/repos/%s/%s/issues?state=%s&limit=%d",
		r.BaseURL, r.Owner, r.Name, state, limit)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "token "+token)
	var raw []struct {
		Number  int    `json:"number"`
		Title   string `json:"title"`
		Body    string `json:"body"`
		State   string `json:"state"`
		HTMLURL string `json:"html_url"`
		User    struct {
			Login string `json:"login"`
		} `json:"user"`
		Labels []struct {
			Name string `json:"name"`
		} `json:"labels"`
		PullRequest any `json:"pull_request"`
	}
	if err := getJSON(ctx, request, &raw); err != nil {
		return nil, err
	}
	out := make([]providerIssue, 0, len(raw))
	for _, issue := range raw {
		if issue.PullRequest != nil {
			continue
		}
		labels := make([]string, 0, len(issue.Labels))
		for _, label := range issue.Labels {
			labels = append(labels, label.Name)
		}
		out = append(out, providerIssue{
			Number: issue.Number, Title: issue.Title, Body: issue.Body,
			State: issue.State, URL: issue.HTMLURL, Author: issue.User.Login, Labels: labels,
		})
	}
	return out, nil
}

type providerPull struct {
	Number  int    `json:"number"`
	URL     string `json:"html_url"`
	State   string `json:"state"`
	Merged  bool   `json:"merged"`
	SHA     string `json:"sha,omitempty"`
	Message string `json:"message,omitempty"`
}

func (r Repo) token() (string, error) {
	if !allowedTokenEnv(r.TokenEnv) {
		return "", fmt.Errorf("%s is not an allowed token environment", r.TokenEnv)
	}
	token := strings.TrimSpace(os.Getenv(r.TokenEnv))
	if token == "" {
		return "", fmt.Errorf("%s is not set", r.TokenEnv)
	}
	return token, nil
}

func (r Repo) createPull(ctx context.Context, head, base, title, body string) (providerPull, error) {
	token, err := r.token()
	if err != nil {
		return providerPull{}, err
	}
	payload, err := json.Marshal(map[string]string{
		"head": head, "base": base, "title": title, "body": body,
	})
	if err != nil {
		return providerPull{}, err
	}
	url := fmt.Sprintf("%s/repos/%s/%s/pulls", r.BaseURL, r.Owner, r.Name)
	auth := "Bearer " + token
	if r.Provider == "gitea" {
		auth = "token " + token
	}
	var raw struct {
		Number  int    `json:"number"`
		HTMLURL string `json:"html_url"`
		State   string `json:"state"`
		Merged  bool   `json:"merged"`
		SHA     string `json:"sha"`
		Message string `json:"message"`
	}
	if err := doJSON(ctx, http.MethodPost, url, auth, payload, &raw); err != nil {
		return providerPull{}, err
	}
	return providerPull{Number: raw.Number, URL: raw.HTMLURL, State: raw.State,
		Merged: raw.Merged, SHA: raw.SHA, Message: raw.Message}, nil
}

func (r Repo) mergePull(ctx context.Context, number int, method string) (providerPull, error) {
	token, err := r.token()
	if err != nil {
		return providerPull{}, err
	}
	if method == "" {
		method = "merge"
	}
	url := fmt.Sprintf("%s/repos/%s/%s/pulls/%d/merge", r.BaseURL, r.Owner, r.Name, number)
	var payload []byte
	httpMethod := http.MethodPut
	auth := "Bearer " + token
	if r.Provider == "gitea" {
		httpMethod = http.MethodPost
		auth = "token " + token
		payload, err = json.Marshal(map[string]string{"Do": method})
	} else {
		payload, err = json.Marshal(map[string]string{"merge_method": method})
	}
	if err != nil {
		return providerPull{}, err
	}
	var raw struct {
		Merged  bool   `json:"merged"`
		SHA     string `json:"sha"`
		Message string `json:"message"`
	}
	if err := doJSON(ctx, httpMethod, url, auth, payload, &raw); err != nil {
		return providerPull{}, err
	}
	return providerPull{Number: number, Merged: raw.Merged, SHA: raw.SHA, Message: raw.Message}, nil
}

func doJSON(ctx context.Context, method, url, authorization string, payload []byte, out any) error {
	request, err := http.NewRequestWithContext(ctx, method, url, strings.NewReader(string(payload)))
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", authorization)
	client := &http.Client{Timeout: 20 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("provider returned %s", response.Status)
	}
	return json.NewDecoder(response.Body).Decode(out)
}

func getJSON(ctx context.Context, request *http.Request, out any) error {
	client := &http.Client{Timeout: 15 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("provider returned %s", response.Status)
	}
	return json.NewDecoder(response.Body).Decode(out)
}

// cloneURL is the git remote for the repository. The GitHub API base is not the
// git host (api.github.com vs github.com), so it is mapped explicitly; a Gitea
// base URL is the web/git host.
func (r Repo) cloneURL() string {
	if r.Provider == "github" {
		host := "https://github.com"
		if parsed, err := url.Parse(r.BaseURL); err == nil && parsed.Host != "" {
			host = parsed.Scheme + "://" + parsed.Host
		}
		return strings.TrimRight(host, "/") + "/" + r.Owner + "/" + r.Name + ".git"
	}
	return strings.TrimRight(r.BaseURL, "/") + "/" + r.Owner + "/" + r.Name + ".git"
}
