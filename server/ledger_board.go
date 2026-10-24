package server

import (
	"net/http"
	"strconv"
	"strings"

	"herdr-web/server/sharedledger"
)

// handleLedgerTasks is the read-only any-machine board: it reads the shared
// ledger, not this machine's local job ledger. The UI can filter by state,
// role or owner and cap the result.
func (s *Server) handleLedgerTasks(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, "GET")
		return
	}
	if s.sharedLedger == nil {
		writeError(w, http.StatusServiceUnavailable, "ledger_unavailable", "shared ledger is not configured")
		return
	}
	query := r.URL.Query()
	filter := sharedledger.Filter{
		State: sharedledger.State(strings.TrimSpace(query.Get("state"))),
		Role:  sharedledger.Role(strings.TrimSpace(query.Get("role"))),
		Node:  strings.TrimSpace(query.Get("node")),
	}
	if raw := strings.TrimSpace(query.Get("limit")); raw != "" {
		limit, err := strconv.Atoi(raw)
		if err != nil || limit < 0 {
			writeError(w, http.StatusBadRequest, "invalid_request", "limit must be a non-negative integer")
			return
		}
		filter.Limit = limit
	}
	tasks, err := s.sharedLedger.List(r.Context(), filter)
	if err != nil {
		writeBadGateway(w, "ledger_failed", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "tasks": tasks})
}
