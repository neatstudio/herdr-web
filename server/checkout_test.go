package server

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func gitTest(t *testing.T, dir string, args ...string) string {
	t.Helper()
	command := exec.Command("git", args...)
	command.Dir = dir
	command.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, output)
	}
	return strings.TrimSpace(string(output))
}

func seedRemote(t *testing.T) (remote, seed string) {
	t.Helper()
	remote = filepath.Join(t.TempDir(), "remote.git")
	gitTest(t, "", "init", "-q", "--bare", remote)
	seed = t.TempDir()
	gitTest(t, seed, "init", "-q")
	gitTest(t, seed, "config", "user.email", "test@example.com")
	gitTest(t, seed, "config", "user.name", "test")
	gitTest(t, seed, "branch", "-M", "main")
	if err := os.WriteFile(filepath.Join(seed, "README.md"), []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitTest(t, seed, "add", "README.md")
	gitTest(t, seed, "commit", "-q", "-m", "initial")
	gitTest(t, seed, "remote", "add", "origin", remote)
	gitTest(t, seed, "push", "-q", "-u", "origin", "main")
	return remote, seed
}

func TestPrepareCheckoutClonesAndChecksOutBase(t *testing.T) {
	remote, _ := seedRemote(t)
	checkout := filepath.Join(t.TempDir(), "checkout")
	console := NewServer("", nil)
	err := console.prepareCheckout(context.Background(), jobRequest{
		Cwd: checkout, Branch: "job/1", CloneURL: remote, BaseBranch: "main",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := gitTest(t, checkout, "rev-parse", "--abbrev-ref", "HEAD"); got != "main" {
		t.Fatalf("branch = %q", got)
	}
	if got := gitTest(t, checkout, "remote", "get-url", "origin"); got != remote {
		t.Fatalf("origin = %q; token must not be persisted", got)
	}
	// A second preparation updates the base without touching the worktree.
	err = console.prepareCheckout(context.Background(), jobRequest{
		Cwd: checkout, Branch: "job/1", CloneURL: remote, BaseBranch: "main",
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestPrepareCheckoutRefusesDirtyCheckout(t *testing.T) {
	remote, _ := seedRemote(t)
	checkout := filepath.Join(t.TempDir(), "checkout")
	console := NewServer("", nil)
	if err := console.prepareCheckout(context.Background(), jobRequest{
		Cwd: checkout, Branch: "job/1", CloneURL: remote, BaseBranch: "main",
	}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(checkout, "dirty.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := console.prepareCheckout(context.Background(), jobRequest{
		Cwd: checkout, Branch: "job/1", CloneURL: remote, BaseBranch: "main",
	}); err == nil || !strings.Contains(err.Error(), "uncommitted") {
		t.Fatalf("dirty checkout error = %v", err)
	}
}

func TestPushDevBranchPushesTheWorktreeHead(t *testing.T) {
	remote, seed := seedRemote(t)
	checkout := filepath.Join(t.TempDir(), "checkout")
	gitTest(t, "", "clone", "-q", remote, checkout)
	gitTest(t, checkout, "config", "user.email", "test@example.com")
	gitTest(t, checkout, "config", "user.name", "test")
	gitTest(t, checkout, "checkout", "-q", "-b", "job/42")
	if err := os.WriteFile(filepath.Join(checkout, "fix.txt"), []byte("fixed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitTest(t, checkout, "add", "fix.txt")
	gitTest(t, checkout, "commit", "-q", "-m", "fix")
	_ = seed

	socket, state, closeFn := startFakeHerdr(t)
	defer closeFn()
	state.checkoutPath = checkout
	console := NewServer(socket, nil)
	if err := console.pushDevBranch(context.Background(), ledgerEvent{
		WorkspaceID: "w1", Branch: "job/42", CloneURL: remote,
	}); err != nil {
		t.Fatal(err)
	}
	pushed := gitTest(t, remote, "rev-parse", "refs/heads/job/42")
	local := gitTest(t, checkout, "rev-parse", "HEAD")
	if pushed != local {
		t.Fatalf("remote head = %q, local = %q", pushed, local)
	}
}
