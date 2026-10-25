package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
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
	ID            string `json:"id"`
	Provider      string `json:"provider"` // github | gitea
	BaseURL       string `json:"baseUrl"`
	Owner         string `json:"owner"`
	Name          string `json:"name"`
	DefaultBranch string `json:"defaultBranch"`
	Checkout      string `json:"checkout"`
	TokenEnv      string `json:"tokenEnv"`
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
		if repo.ID != "" {
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
	if repo.TokenEnv == "" {
		if repo.Provider == "github" {
			repo.TokenEnv = "GITHUB_TOKEN"
		} else {
			repo.TokenEnv = "GITEA_TOKEN"
		}
	}
	if repo.DefaultBranch == "" {
		repo.DefaultBranch = "main"
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
