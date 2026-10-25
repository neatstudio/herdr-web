package server

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// prepareCheckout makes the job's Cwd a usable repository before herdr creates a
// worktree from it. The orchestrator sends the clone URL and the token env name
// because the target may not have the repository in its own registry; the token
// itself is read from the target's environment and never stored in the task.
func (s *Server) prepareCheckout(ctx context.Context, request jobRequest) error {
	cwd := expandHome(strings.TrimSpace(request.Cwd))
	if cwd == "" || strings.TrimSpace(request.Branch) == "" {
		// A plain directory job does not need a repository; only a worktree job
		// does, because herdr will create the branch from it.
		return nil
	}
	cloneURL := strings.TrimSpace(request.CloneURL)
	base := strings.TrimSpace(request.BaseBranch)
	if base == "" {
		base = "main"
	}
	token := checkoutToken(request.TokenEnv)

	info, err := os.Stat(cwd)
	if err == nil {
		if !info.IsDir() {
			return fmt.Errorf("checkout %s is not a directory", cwd)
		}
		if !isGitRepository(ctx, cwd) {
			empty, err := isEmptyDir(cwd)
			if err != nil {
				return err
			}
			if !empty || cloneURL == "" {
				return fmt.Errorf("checkout %s is not a git repository", cwd)
			}
			if err := cloneRepository(ctx, cwd, cloneURL, token); err != nil {
				return err
			}
		}
		if cloneURL != "" {
			if err := fetchRepository(ctx, cwd, cloneURL, token, base); err != nil {
				return err
			}
		}
		clean, err := gitClean(ctx, cwd)
		if err != nil {
			return err
		}
		if !clean {
			return fmt.Errorf("checkout %s has uncommitted changes; refusing to switch branches", cwd)
		}
		if err := gitRun(ctx, cwd, "checkout", base); err != nil {
			return err
		}
		if cloneURL != "" {
			if err := gitRun(ctx, cwd, "merge", "--ff-only", "FETCH_HEAD"); err != nil {
				return err
			}
		}
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	if cloneURL == "" {
		return fmt.Errorf("checkout %s does not exist and no clone URL is configured", cwd)
	}
	if err := os.MkdirAll(filepath.Dir(cwd), 0o755); err != nil {
		return err
	}
	if err := cloneRepository(ctx, cwd, cloneURL, token); err != nil {
		return err
	}
	if err := gitRun(ctx, cwd, "checkout", base); err != nil {
		return err
	}
	return nil
}

func checkoutToken(envName string) string {
	envName = strings.TrimSpace(envName)
	if envName == "" {
		return ""
	}
	return strings.TrimSpace(os.Getenv(envName))
}

func cloneRepository(ctx context.Context, cwd, cloneURL, token string) error {
	remote := authenticatedURL(cloneURL, token)
	if err := gitRun(ctx, "", "clone", remote, cwd); err != nil {
		return fmt.Errorf("clone %s: %w", cloneURL, err)
	}
	// Keep the credential out of .git/config after the clone; every fetch and
	// push supplies the authenticated URL explicitly.
	if err := gitRun(ctx, cwd, "remote", "set-url", "origin", cloneURL); err != nil {
		return err
	}
	return nil
}

func fetchRepository(ctx context.Context, cwd, cloneURL, token, base string) error {
	remote := authenticatedURL(cloneURL, token)
	if err := gitRun(ctx, cwd, "fetch", "--prune", remote, base); err != nil {
		return fmt.Errorf("fetch %s: %w", cloneURL, err)
	}
	return nil
}

// pushDevBranch publishes the dev job's branch so the PR creation has a head.
// It only runs when the job was started with a clone URL (or a repo this console
// knows); a plain directory job has nothing to push.
func (s *Server) pushDevBranch(ctx context.Context, event ledgerEvent) error {
	branch := strings.TrimSpace(event.Branch)
	if branch == "" {
		return nil
	}
	cloneURL := strings.TrimSpace(event.CloneURL)
	tokenEnv := strings.TrimSpace(event.TokenEnv)
	if cloneURL == "" && strings.TrimSpace(event.Repo) != "" {
		if repo, ok := s.repos.Get(event.Repo); ok {
			cloneURL = repo.cloneURL()
			tokenEnv = repo.TokenEnv
		}
	}
	if cloneURL == "" {
		return nil
	}
	checkout, err := s.workspaceCheckout(ctx, event.WorkspaceID)
	if err != nil {
		return err
	}
	remote := authenticatedURL(cloneURL, checkoutToken(tokenEnv))
	if err := gitRun(ctx, checkout, "push", remote, "HEAD:refs/heads/"+branch); err != nil {
		return fmt.Errorf("push %s: %w", branch, err)
	}
	return nil
}

func authenticatedURL(rawURL, token string) string {
	token = strings.TrimSpace(token)
	if token == "" {
		return rawURL
	}
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Host == "" || parsed.User != nil {
		return rawURL
	}
	parsed.User = url.User(token)
	return parsed.String()
}

func isGitRepository(ctx context.Context, dir string) bool {
	return gitRun(ctx, dir, "rev-parse", "--git-dir") == nil
}

func gitClean(ctx context.Context, dir string) (bool, error) {
	command := exec.CommandContext(ctx, "git", "-C", dir, "status", "--porcelain")
	command.Env = gitEnv()
	output, err := command.Output()
	if err != nil {
		return false, fmt.Errorf("git status: %w", err)
	}
	return strings.TrimSpace(string(output)) == "", nil
}

func isEmptyDir(path string) (bool, error) {
	entries, err := os.ReadDir(path)
	if err != nil {
		return false, err
	}
	return len(entries) == 0, nil
}

func gitRun(ctx context.Context, dir string, args ...string) error {
	commandArgs := args
	if dir != "" {
		commandArgs = append([]string{"-C", dir}, args...)
	}
	command := exec.CommandContext(ctx, "git", commandArgs...)
	command.Env = gitEnv()
	output, err := command.CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(output))
		if message == "" {
			return err
		}
		return fmt.Errorf("%w: %s", err, message)
	}
	return nil
}

func gitEnv() []string {
	return append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GIT_ASKPASS=")
}

func (s *Server) workspaceCheckout(ctx context.Context, workspaceID string) (string, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return "", fmt.Errorf("workspace id is required to push a branch")
	}
	var answer struct {
		Workspace struct {
			Worktree *struct {
				CheckoutPath string `json:"checkout_path"`
			} `json:"worktree"`
		} `json:"workspace"`
	}
	if err := s.client().Call(ctx, "workspace.get", map[string]any{"workspace_id": workspaceID}, &answer); err != nil {
		return "", err
	}
	if answer.Workspace.Worktree == nil || strings.TrimSpace(answer.Workspace.Worktree.CheckoutPath) == "" {
		return "", fmt.Errorf("workspace %s has no checkout", workspaceID)
	}
	return answer.Workspace.Worktree.CheckoutPath, nil
}
