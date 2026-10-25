package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"herdr-web/server/sharedledger"
)

func TestRepoIssuesAndTaskAPI(t *testing.T) {
	isolateState(t)
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/repos/acme/app/issues" {
			http.NotFound(w, r)
			return
		}
		if got := r.Header.Get("Authorization"); got != "Bearer test-token" {
			http.Error(w, "bad auth", http.StatusUnauthorized)
			return
		}
		_ = json.NewEncoder(w).Encode([]map[string]any{{
			"number": 7, "title": "Fix the thing", "body": "Details", "state": "open",
			"html_url": "https://example/7", "user": map[string]any{"login": "me"},
			"labels": []map[string]any{{"name": "bug"}},
		}, {
			"number": 8, "title": "A pull request", "state": "open",
			"pull_request": map[string]any{"url": "https://example/pr/8"},
		}})
	}))
	defer target.Close()
	t.Setenv("TEST_GITHUB_TOKEN", "test-token")

	console := NewServer("", nil)
	repo, err := console.repos.Add(Repo{
		Provider: "github", BaseURL: target.URL, Owner: "acme", Name: "app",
		Checkout: "/repo", TokenEnv: "TEST_GITHUB_TOKEN",
	})
	if err != nil {
		t.Fatal(err)
	}
	handler := console.Handler()

	list := do(t, handler, http.MethodGet, "/api/v1/repos", "")
	if list.Code != http.StatusOK {
		t.Fatalf("list = %d: %s", list.Code, list.Body.String())
	}
	var repos struct {
		Repos []Repo `json:"repos"`
	}
	if err := json.Unmarshal(list.Body.Bytes(), &repos); err != nil {
		t.Fatal(err)
	}
	if len(repos.Repos) != 1 || repos.Repos[0].ID != "github:acme/app" {
		t.Fatalf("repos = %+v", repos.Repos)
	}

	issues := do(t, handler, http.MethodGet, "/api/v1/repos/"+repo.ID+"/issues", "")
	if issues.Code != http.StatusOK {
		t.Fatalf("issues = %d: %s", issues.Code, issues.Body.String())
	}
	var issueList struct {
		Issues []providerIssue `json:"issues"`
	}
	if err := json.Unmarshal(issues.Body.Bytes(), &issueList); err != nil {
		t.Fatal(err)
	}
	if len(issueList.Issues) != 1 || issueList.Issues[0].Number != 7 {
		t.Fatalf("issues = %+v", issueList.Issues)
	}

	create := do(t, handler, http.MethodPost, "/api/v1/repos/"+repo.ID+"/tasks", `{"issue":7}`)
	if create.Code != http.StatusCreated {
		t.Fatalf("create = %d: %s", create.Code, create.Body.String())
	}
	var created struct {
		Task sharedledger.Task `json:"task"`
	}
	if err := json.Unmarshal(create.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	task := created.Task
	if task.Repo != repo.ID || task.Issue != 7 || task.Cwd != "/repo" ||
		task.Branch != "job/issue-7" || !strings.Contains(task.Prompt, "Fix the thing") {
		t.Fatalf("task = %+v", task)
	}
}
