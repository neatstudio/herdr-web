package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// gitRepo makes a repository with one commit and returns its path.
func gitRepo(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	dir := t.TempDir()
	runs := [][]string{
		{"init", "-q", "-b", "main"},
		{"config", "user.email", "test@example.com"},
		{"config", "user.name", "Test"},
	}
	for _, args := range runs {
		if output, err := exec.Command("git", append([]string{"-C", dir}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, output)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("one\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"add", "-A"}, {"commit", "-q", "-m", "first"}} {
		if output, err := exec.Command("git", append([]string{"-C", dir}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, output)
		}
	}
	return dir
}

func TestJobDiffReportsWhatTheWorktreeHolds(t *testing.T) {
	// The half of a dispatched job that matters: the branch, its commits, and what
	// is still uncommitted on the machine that did the work.
	repo := gitRepo(t)
	socket, state, closeFn := startFakeHerdr(t)
	defer closeFn()
	state.checkoutPath = repo

	// A second commit, a branch, and an uncommitted file — the three things the
	// endpoint has to tell apart.
	if output, err := exec.Command("git", "-C", repo, "checkout", "-q", "-b", "job/audit").CombinedOutput(); err != nil {
		t.Fatalf("checkout: %v: %s", err, output)
	}
	if err := os.WriteFile(filepath.Join(repo, "NOTES.md"), []byte("two\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"add", "-A"}, {"commit", "-q", "-m", "audit the docs"}} {
		if output, err := exec.Command("git", append([]string{"-C", repo}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, output)
		}
	}
	if err := os.WriteFile(filepath.Join(repo, "WIP.md"), []byte("draft\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	console := newTestHandler(t, socket)
	recorder := httptest.NewRecorder()
	console.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/herdr/job/w1/diff", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", recorder.Code, recorder.Body.String())
	}
	var diff struct {
		Branch       string   `json:"branch"`
		CheckoutPath string   `json:"checkoutPath"`
		Commits      []string `json:"commits"`
		Changed      []string `json:"changed"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &diff); err != nil {
		t.Fatal(err)
	}
	if diff.Branch != "job/audit" {
		t.Fatalf("branch = %q", diff.Branch)
	}
	if diff.CheckoutPath != repo {
		t.Fatalf("checkout = %q", diff.CheckoutPath)
	}
	// Each entry is "<short sha> <subject>", newest first.
	if len(diff.Commits) != 2 || !strings.HasSuffix(diff.Commits[0], "audit the docs") {
		t.Fatalf("commits = %v", diff.Commits)
	}
	if !contains(diff.Changed, "?? WIP.md") {
		t.Fatalf("changed = %v", diff.Changed)
	}
}

func TestJobDiffSaysWhenThereIsNoWorktree(t *testing.T) {
	// A job started in a plain workspace has no checkout, and saying so is better
	// than reporting an empty branch.
	socket, _, closeFn := startFakeHerdr(t)
	defer closeFn()
	console := newTestHandler(t, socket)
	recorder := httptest.NewRecorder()
	console.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/herdr/job/w1/diff", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d", recorder.Code)
	}
	if !contains([]string{recorder.Body.String()}, "not a worktree") {
		var answer struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(recorder.Body.Bytes(), &answer)
		if answer.Error == "" {
			t.Fatalf("body = %s", recorder.Body.String())
		}
	}
}

func contains(list []string, want string) bool {
	for _, item := range list {
		if item == want {
			return true
		}
	}
	return false
}
