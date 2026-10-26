package server

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"herdr-web/server/sharedledger"
)

func writeLedgerError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, sharedledger.ErrNotFound):
		writeError(w, http.StatusNotFound, "ledger_not_found", err.Error())
	case errors.Is(err, sharedledger.ErrConflict):
		writeError(w, http.StatusConflict, "ledger_conflict", err.Error())
	case errors.Is(err, sharedledger.ErrMergeBusy):
		writeError(w, http.StatusConflict, "ledger_merge_busy", err.Error())
	case errors.Is(err, sharedledger.ErrInvalidState), errors.Is(err, sharedledger.ErrLeaseExpired),
		errors.Is(err, sharedledger.ErrNotOwner):
		writeError(w, http.StatusConflict, "ledger_state", err.Error())
	case errors.Is(err, sharedledger.ErrIndependentNode):
		writeError(w, http.StatusForbidden, "ledger_independent_node", err.Error())
	case errors.Is(err, sharedledger.ErrSignature), errors.Is(err, sharedledger.ErrInvalidTask):
		writeError(w, http.StatusBadRequest, "ledger_invalid", err.Error())
	default:
		writeBadGateway(w, "ledger_failed", err)
	}
}

func (s *Server) handleLedgerCreate(w http.ResponseWriter, r *http.Request) {
	var task sharedledger.Task
	if !decodeBody(w, r, &task) {
		return
	}
	if strings.TrimSpace(task.ID) == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "task id is required")
		return
	}
	created, err := s.sharedLedger.Create(r.Context(), task)
	if err != nil {
		writeLedgerError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"ok": true, "task": created})
}

func (s *Server) handleLedgerTaskAction(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, "POST")
		return
	}
	if s.sharedLedger == nil {
		writeError(w, http.StatusServiceUnavailable, "ledger_unavailable", "shared ledger is not configured")
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/api/v1/ledger/tasks/")
	parts := strings.Split(rest, "/")
	if len(parts) != 2 || strings.TrimSpace(parts[0]) == "" {
		writeNotFound(w)
		return
	}
	id := parts[0]
	switch parts[1] {
	case "claim":
		var request struct {
			Role         string `json:"role"`
			Node         string `json:"node"`
			LeaseSeconds int    `json:"leaseSeconds"`
			Version      uint64 `json:"version"`
			Signature    string `json:"signature"`
		}
		if !decodeBody(w, r, &request) {
			return
		}
		role := sharedledger.Role(strings.TrimSpace(request.Role))
		if role == "" || strings.TrimSpace(request.Node) == "" {
			writeError(w, http.StatusBadRequest, "invalid_request", "role and node are required")
			return
		}
		lease := time.Duration(request.LeaseSeconds) * time.Second
		if lease <= 0 {
			lease = 30 * time.Minute
		}
		task, err := s.sharedLedger.Claim(r.Context(), id, role, request.Node, lease, request.Version, request.Signature)
		if err != nil {
			writeLedgerError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "task": task})
	case "pr":
		var request struct {
			Number int `json:"number"`
		}
		if !decodeBody(w, r, &request) {
			return
		}
		if request.Number <= 0 {
			writeError(w, http.StatusBadRequest, "invalid_request", "pull number is required")
			return
		}
		task, err := s.sharedLedger.LinkPR(r.Context(), id, request.Number)
		if err != nil {
			writeLedgerError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "task": task})
	case "attest":
		var request struct {
			Role      string `json:"role"`
			Node      string `json:"node"`
			Commit    string `json:"commit"`
			Digest    string `json:"digest"`
			Signature string `json:"signature"`
			Version   uint64 `json:"version"`
		}
		if !decodeBody(w, r, &request) {
			return
		}
		role := sharedledger.Role(strings.TrimSpace(request.Role))
		if role == "" || strings.TrimSpace(request.Node) == "" {
			writeError(w, http.StatusBadRequest, "invalid_request", "role and node are required")
			return
		}
		task, err := s.sharedLedger.Attest(r.Context(), id, role, request.Node,
			request.Commit, request.Digest, request.Signature, request.Version)
		if err != nil {
			writeLedgerError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "task": task})
	case "release":
		var request struct {
			Role      string `json:"role"`
			Node      string `json:"node"`
			Reason    string `json:"reason"`
			Signature string `json:"signature"`
		}
		if !decodeBody(w, r, &request) {
			return
		}
		role := sharedledger.Role(strings.TrimSpace(request.Role))
		if role == "" || strings.TrimSpace(request.Node) == "" {
			writeError(w, http.StatusBadRequest, "invalid_request", "role and node are required")
			return
		}
		task, err := s.sharedLedger.Release(r.Context(), id, role, request.Node, request.Reason, request.Signature)
		if err != nil {
			writeLedgerError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "task": task})
	case "cancel":
		var request struct {
			Node      string `json:"node"`
			Reason    string `json:"reason"`
			Signature string `json:"signature"`
		}
		if !decodeBody(w, r, &request) {
			return
		}
		task, err := s.sharedLedger.Cancel(r.Context(), id, request.Node, request.Reason, request.Signature)
		if err != nil {
			writeLedgerError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "task": task})
	default:
		writeNotFound(w)
	}
}
