package server

import (
	"context"
	"os"
	"strings"
	"time"

	"herdr-web/server/sharedledger"
)

const orchestratorInterval = 10 * time.Second

// StartOrchestrator watches the shared ledger and starts the next pipeline role
// when a task reaches a hand-off state. HERDR_WEB_ORCHESTRATOR=off disables it;
// the default is on for a NATS-backed fleet.
func (s *Server) StartOrchestrator(ctx context.Context) {
	if !orchestratorEnabled() {
		return
	}
	go s.orchestratorLoop(ctx)
}

func orchestratorEnabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("HERDR_WEB_ORCHESTRATOR"))) {
	case "off", "0", "no", "false":
		return false
	default:
		return true
	}
}

func (s *Server) orchestratorLoop(ctx context.Context) {
	ticker := time.NewTicker(orchestratorInterval)
	defer ticker.Stop()
	s.orchestratorTick(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.orchestratorTick(ctx)
		}
	}
}

// orchestratorTick starts at most one next-role job. The ledger's CAS makes a
// duplicate tick on another console harmless: only one start can claim the task.
func (s *Server) orchestratorTick(ctx context.Context) {
	if s.sharedLedger == nil {
		return
	}
	steps := []struct {
		from sharedledger.State
		role sharedledger.Role
	}{
		{sharedledger.DevDone, sharedledger.RoleReview},
		{sharedledger.ReviewApproved, sharedledger.RoleTest},
		{sharedledger.TestPassed, sharedledger.RoleAudit},
		{sharedledger.AuditApproved, sharedledger.RoleMerge},
	}
	for _, step := range steps {
		tasks, err := s.sharedLedger.List(ctx, sharedledger.Filter{State: step.from})
		if err != nil {
			return
		}
		for _, task := range tasks {
			if limit := maxJobs(); limit > 0 && s.ledger.runningCount() >= limit {
				return
			}
			if step.role == sharedledger.RoleMerge {
				if s.mergeApprovedTask(ctx, task) {
					return
				}
				continue
			}
			if step.role == sharedledger.RoleReview {
				var pulled bool
				task, pulled = s.ensurePull(ctx, task)
				if !pulled {
					continue
				}
			}
			kind := task.Kind
			testCommand := ""
			if step.role == sharedledger.RoleTest && strings.TrimSpace(task.TestCommand) != "" {
				kind = "command"
				testCommand = task.TestCommand
			}
			if !jobKindAvailable(kind) {
				continue
			}
			targets := s.fleetConsoles()
			if len(targets) == 0 {
				continue
			}
			cloneURL, tokenEnv, baseBranch := task.CloneURL, task.TokenEnv, task.BaseBranch
			if repo, found := s.repos.Get(task.Repo); found {
				if cloneURL == "" {
					cloneURL = repo.cloneURL()
				}
				if tokenEnv == "" {
					tokenEnv = repo.TokenEnv
				}
				if baseBranch == "" {
					baseBranch = repo.DefaultBranch
				}
			}
			request := dispatchRequest{
				Prompt:      rolePrompt(task, step.role),
				Kind:        kind,
				TestCommand: testCommand,
				Role:        string(step.role),
				Cwd:         task.Cwd,
				Branch:      task.Branch,
				Repo:        task.Repo,
				CloneURL:    cloneURL,
				TokenEnv:    tokenEnv,
				BaseBranch:  baseBranch,
				Strategy:    "single",
			}
			job, started, err := s.runMarket(ctx, request, targets, task.ID)
			if err != nil || !started {
				continue
			}
			s.storeDispatch(job)
			return
		}
	}
}

func rolePrompt(task sharedledger.Task, role sharedledger.Role) string {
	switch role {
	case sharedledger.RoleReview:
		return "Review the work for task " + task.ID + " in this workspace. Inspect the diff and tests; report findings and do not edit files."
	case sharedledger.RoleTest:
		return "Run the repository's tests for task " + task.ID + " and report the exact commands and results. Do not edit files."
	case sharedledger.RoleAudit:
		return "Audit the review and test evidence for task " + task.ID + ". Report whether it is ready to merge."
	case sharedledger.RoleMerge:
		return "Merge the approved changes for task " + task.ID + " and report the resulting commit."
	default:
		return task.Prompt
	}
}

// mergeApprovedTask performs the merge role server-side through the provider.
// It creates the PR if the task has a branch but no PR yet, claims the merge
// lease, merges, and attests the resulting commit. A provider failure releases
// the lease so the next tick can retry; conflicts stay visible on the board.
func (s *Server) mergeApprovedTask(ctx context.Context, task sharedledger.Task) bool {
	task, ok := s.ensurePull(ctx, task)
	if !ok {
		return false
	}
	pr := task.PR
	repo, ok := s.repos.Get(task.Repo)
	if !ok {
		return false
	}
	mergeLease := 30 * time.Minute
	claimed, err := s.sharedLedger.Claim(ctx, task.ID, sharedledger.RoleMerge, localNodeID(), mergeLease, task.Version,
		signLedgerOperation("claim", task.ID, sharedledger.RoleMerge, task.Version, mergeLease, ""))
	if err != nil {
		return false
	}
	merged, err := repo.mergePull(ctx, pr, "merge")
	if err != nil || (!merged.Merged && merged.SHA == "") {
		_, _ = s.sharedLedger.FailMerge(ctx, task.ID, localNodeID(), "provider merge failed",
			signLedgerOperation("fail_merge", task.ID, sharedledger.RoleMerge, 0, 0, "provider merge failed"))
		return false
	}
	_, err = s.sharedLedger.Attest(ctx, task.ID, sharedledger.RoleMerge, localNodeID(), merged.SHA, "", signAttestation(task.ID, sharedledger.RoleMerge, merged.SHA, ""), claimed.Version)
	return err == nil
}

func (s *Server) ensurePull(ctx context.Context, task sharedledger.Task) (sharedledger.Task, bool) {
	if task.PR != 0 || strings.TrimSpace(task.Repo) == "" {
		return task, true
	}
	repo, ok := s.repos.Get(task.Repo)
	if !ok || strings.TrimSpace(task.Branch) == "" {
		return task, false
	}
	pull, err := repo.createPull(ctx, task.Branch, repo.DefaultBranch, task.Title, task.Prompt)
	if err != nil {
		return task, false
	}
	linked, err := s.sharedLedger.LinkPR(ctx, task.ID, pull.Number)
	if err != nil {
		return task, false
	}
	return linked, true
}
