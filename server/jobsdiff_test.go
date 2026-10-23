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

	// A second commit on the base branch: "the last ten commits" is not the same
	// thing as "the commits this job made".
	if err := os.WriteFile(filepath.Join(repo, "BASE.md"), []byte("base\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"add", "-A"}, {"commit", "-q", "-m", "second base commit"}} {
		if output, err := exec.Command("git", append([]string{"-C", repo}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, output)
		}
	}

	// A branch and a commit — what the job produced, on top of the base.
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
	// Each entry is "<short sha> <subject>", newest first, and only the commit
	// this job made — not the two it inherited from the base branch.
	if len(diff.Commits) != 1 || !strings.HasSuffix(diff.Commits[0], "audit the docs") {
		t.Fatalf("commits = %v", diff.Commits)
	}
	if !contains(diff.Changed, "?? WIP.md") {
		t.Fatalf("changed = %v", diff.Changed)
	}
}

func TestJobDiffUsesTheWorktreeForkPoint(t *testing.T) {
	// A real herdr worktree lives beside the repository, not in it. The base is
	// the fork point with the repository's HEAD, not the mainline: commits the
	// base branch gained after the fork are not the job's.
	repo := gitRepo(t)
	runGit := func(dir string, args ...string) string {
		t.Helper()
		output, err := exec.Command("git", append([]string{"-C", dir}, args...)...).CombinedOutput()
		if err != nil {
			t.Fatalf("git %v in %s: %v: %s", args, dir, err, output)
		}
		return string(output)
	}
	runGit(repo, "checkout", "-q", "-b", "feature")
	if err := os.WriteFile(filepath.Join(repo, "FEATURE.md"), []byte("feature\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit(repo, "add", "-A")
	runGit(repo, "commit", "-q", "-m", "feature base")

	worktree := filepath.Join(t.TempDir(), "wt")
	runGit(repo, "worktree", "add", "-q", "-b", "job/wt", worktree, "feature")
	if err := os.WriteFile(filepath.Join(worktree, "OUT.md"), []byte("job\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit(worktree, "add", "-A")
	runGit(worktree, "commit", "-q", "-m", "job change")

	socket, state, closeFn := startFakeHerdr(t)
	defer closeFn()
	state.checkoutPath = worktree
	state.repoRoot = repo

	console := newTestHandler(t, socket)
	recorder := httptest.NewRecorder()
	console.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/herdr/job/w1/diff", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", recorder.Code, recorder.Body.String())
	}
	var diff struct {
		Branch  string   `json:"branch"`
		Commits []string `json:"commits"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &diff); err != nil {
		t.Fatal(err)
	}
	if diff.Branch != "job/wt" {
		t.Fatalf("branch = %q", diff.Branch)
	}
	if len(diff.Commits) != 1 || !strings.HasSuffix(diff.Commits[0], "job change") {
		t.Fatalf("commits = %v, want only the job's commit", diff.Commits)
	}
}

func TestJobDiffSaysWhenTheJobCommittedNothing(t *testing.T) {
	// A job that leaves a dirty tree but no commit is a real outcome: the panel
	// must say "no commits" instead of showing the commits it inherited.
	repo := gitRepo(t)
	socket, state, closeFn := startFakeHerdr(t)
	defer closeFn()
	state.checkoutPath = repo

	if output, err := exec.Command("git", "-C", repo, "checkout", "-q", "-b", "job/empty").CombinedOutput(); err != nil {
		t.Fatalf("checkout: %v: %s", err, output)
	}
	if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("changed\n"), 0o644); err != nil {
		t.Fatal(err)
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
		Branch  string   `json:"branch"`
		Commits []string `json:"commits"`
		Changed []string `json:"changed"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &diff); err != nil {
		t.Fatal(err)
	}
	if diff.Branch != "job/empty" {
		t.Fatalf("branch = %q", diff.Branch)
	}
	if len(diff.Commits) != 0 {
		t.Fatalf("commits = %v, want none", diff.Commits)
	}
	// The two status columns survive: a modified tracked file is " M", not "M".
	if !contains(diff.Changed, " M README.md") || !contains(diff.Changed, "?? WIP.md") {
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
