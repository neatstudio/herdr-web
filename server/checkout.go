package server

import (
	"context"
	"fmt"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

// prepareCheckout makes the job's Cwd a usable repository before herdr creates a
// worktree from it. The orchestrator sends the clone URL and the token env name
// because the target may not have the repository in its own registry; the token
// itself is read from the target's environment and never stored in the task.
var (
	checkoutRefPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/-]*$`)
	tokenEnvPattern    = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
)

// validCheckoutRef keeps a branch or base name from becoming a git option.
func validCheckoutRef(ref string) bool {
	return checkoutRefPattern.MatchString(ref) &&
		!strings.HasPrefix(ref, "-") &&
		!strings.Contains(ref, "..") &&
		!strings.Contains(ref, "//") &&
		!strings.HasSuffix(ref, "/") &&
		!strings.HasSuffix(ref, ".lock")
}

func privateGitHost(host string) bool {
	host = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(host)), ".")
	if host == "localhost" || strings.HasSuffix(host, ".local") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && isPrivateV4(ip)
}

// validCloneURL rejects transports that can make git run a local command.
func validCloneURL(raw string) bool {
	raw = strings.TrimSpace(raw)
	parsed, err := url.Parse(raw)
	if err != nil {
		return false
	}
	// A local file remote is useful in tests and for an operator's own bare
	// mirror, but it is also git's command-execution transport. It is opt-in.
	if strings.TrimSpace(os.Getenv("HERDR_WEB_ALLOW_FILE_CLONE")) == "1" &&
		(parsed.Scheme == "file" || (parsed.Scheme == "" && filepath.IsAbs(raw))) {
		return true
	}
	if parsed.Host == "" {
		return false
	}
	switch strings.ToLower(parsed.Scheme) {
	case "https":
		return parsed.User == nil
	case "ssh":
		// ssh://git@host is a username, not a password. A password in the URL
		// would be a secret in the request; reject it.
		if parsed.User == nil {
			return true
		}
		_, hasPassword := parsed.User.Password()
		return !hasPassword
	case "http":
		return parsed.User == nil && privateGitHost(parsed.Hostname())
	default:
		return false
	}
}

// validProviderURL is the API-side equivalent: no file/ext transports, and
// plain HTTP only on a private host.
func validProviderURL(raw string) bool {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Host == "" || parsed.User != nil {
		return false
	}
	switch strings.ToLower(parsed.Scheme) {
	case "https":
		return true
	case "http":
		return privateGitHost(parsed.Hostname())
	default:
		return false
	}
}

// checkoutRoots is where a job may create a new checkout. Existing git
// checkouts outside these roots remain usable; the dangerous operation was
// creating a repository in a path chosen by the caller.
func checkoutRoots() []string {
	roots := make([]string, 0, 4)
	add := func(path string) {
		path = strings.TrimSpace(path)
		if path == "" {
			return
		}
		if abs, err := filepath.Abs(path); err == nil {
			path = abs
		}
		for _, existing := range roots {
			if existing == path {
				return
			}
		}
		roots = append(roots, path)
	}
	for _, item := range strings.FieldsFunc(os.Getenv("HERDR_WEB_CHECKOUT_ROOTS"), func(r rune) bool {
		return r == ',' || r == '\n' || r == '\t'
	}) {
		add(item)
	}
	if home, err := os.UserHomeDir(); err == nil {
		add(filepath.Join(home, ".local", "share", "herdr-web", "checkouts"))
	}
	return roots
}

func checkoutAllowed(s *Server, path, repoID string) bool {
	abs, err := filepath.Abs(path)
	if err != nil {
		return false
	}
	roots := checkoutRoots()
	if repoID != "" {
		if repo, ok := s.repos.Get(repoID); ok && strings.TrimSpace(repo.Checkout) != "" {
			roots = append(roots, repo.Checkout)
		}
	}
	for _, root := range roots {
		rootAbs, err := filepath.Abs(root)
		if err != nil {
			continue
		}
		rel, err := filepath.Rel(rootAbs, abs)
		if err != nil {
			continue
		}
		if rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator))) {
			return true
		}
	}
	return false
}

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
	if !validCheckoutRef(strings.TrimSpace(request.Branch)) || !validCheckoutRef(base) {
		return fmt.Errorf("branch and base branch must be plain git refs")
	}
	if cloneURL != "" && !validCloneURL(cloneURL) {
		return fmt.Errorf("clone URL must be https, ssh, or private http")
	}
	if !allowedTokenEnv(request.TokenEnv) {
		return fmt.Errorf("tokenEnv %q is not allowed", request.TokenEnv)
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
			if !checkoutAllowed(s, cwd, request.Repo) {
				return fmt.Errorf("checkout %s is outside the allowed checkout roots", cwd)
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
	if !checkoutAllowed(s, cwd, request.Repo) {
		return fmt.Errorf("checkout %s is outside the allowed checkout roots", cwd)
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

var defaultTokenEnvs = map[string]bool{
	"GITHUB_TOKEN": true,
	"GITEA_TOKEN":  true,
	"GITLAB_TOKEN": true,
}

// allowedTokenEnv keeps a request from reading an arbitrary process secret into
// a URL or a provider header. The default set is the provider tokens the repo
// registry already names; an operator can add names explicitly.
func allowedTokenEnv(name string) bool {
	name = strings.TrimSpace(name)
	if name == "" {
		return true
	}
	if !tokenEnvPattern.MatchString(name) {
		return false
	}
	lower := strings.ToLower(name)
	if strings.HasPrefix(lower, "herdr_web_") ||
		strings.HasPrefix(lower, "aws_") ||
		lower == "home" || lower == "path" || lower == "ld_preload" {
		return false
	}
	if defaultTokenEnvs[name] {
		return true
	}
	for _, item := range strings.FieldsFunc(os.Getenv("HERDR_WEB_ALLOWED_TOKEN_ENVS"), func(r rune) bool {
		return r == ',' || r == ' ' || r == '\n' || r == '\t'
	}) {
		if strings.TrimSpace(item) == name {
			return true
		}
	}
	return false
}

func checkoutToken(envName string) string {
	envName = strings.TrimSpace(envName)
	if envName == "" || !allowedTokenEnv(envName) {
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
	if !validCheckoutRef(branch) {
		return fmt.Errorf("branch %q is not a plain git ref", branch)
	}
	cloneURL := strings.TrimSpace(event.CloneURL)
	tokenEnv := strings.TrimSpace(event.TokenEnv)
	if cloneURL == "" && strings.TrimSpace(event.Repo) != "" {
		if repo, ok := s.repos.Get(event.Repo); ok {
			cloneURL = repo.cloneURL()
			tokenEnv = repo.TokenEnv
		}
	}
	if !allowedTokenEnv(tokenEnv) {
		return fmt.Errorf("tokenEnv %q is not allowed", tokenEnv)
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

func gitOutput(ctx context.Context, dir string, args ...string) (string, error) {
	commandArgs := args
	if dir != "" {
		commandArgs = append([]string{"-C", dir}, args...)
	}
	command := exec.CommandContext(ctx, "git", commandArgs...)
	command.Env = gitEnv()
	output, err := command.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(output)), nil
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

func (s *Server) workspaceHead(ctx context.Context, workspaceID string) (string, error) {
	checkout, err := s.workspaceCheckout(ctx, workspaceID)
	if err != nil {
		return "", err
	}
	return gitOutput(ctx, checkout, "rev-parse", "HEAD")
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
