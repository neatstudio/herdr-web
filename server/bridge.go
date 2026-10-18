package server

import (
	"encoding/json"
	"io/fs"
	"net/http"
	"strconv"
	"strings"
)

// Routes proxied to the herdr daemon. Anything else under /api is 404 so a
// typo never silently hits the SPA fallback.
const (
	maxBodyBytes = 1 << 20
)

// writeJSON encodes value as JSON with the frontend's content type.
func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]any{
			"code":      code,
			"message":   message,
			"retryable": false,
		},
	})
}

func writeNotFound(w http.ResponseWriter) {
	writeError(w, http.StatusNotFound, "not_found", "resource not found")
}

func writeMethodNotAllowed(w http.ResponseWriter, allow string) {
	if strings.TrimSpace(allow) != "" {
		w.Header().Set("Allow", allow)
	}
	writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
}

func writeBadGateway(w http.ResponseWriter, code string, err error) {
	writeError(w, http.StatusBadGateway, code, err.Error())
}

// Server bridges one herdr daemon socket to HTTP and serves the embedded UI.
type Server struct {
	socketPath string
	webFS      fs.FS
}

func NewServer(socketPath string, webFS fs.FS) *Server {
	return &Server{socketPath: socketPath, webFS: webFS}
}

func (s *Server) client() *Client {
	return NewClient(s.socketPath)
}

func decodeBody(w http.ResponseWriter, r *http.Request, dst any) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	if err := decoder.Decode(dst); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "A JSON body is required.")
		return false
	}
	// Reject trailing garbage after the first JSON value.
	if decoder.More() {
		writeError(w, http.StatusBadRequest, "invalid_request", "A single JSON body is required.")
		return false
	}
	return true
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, "GET")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "service": "herdr-web"})
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, "GET")
		return
	}
	out := map[string]any{
		"enabled": true,
		"socket":  s.socketPath,
		"status":  "ok",
	}
	var pong struct {
		Version   string `json:"version"`
		Protocol  int    `json:"protocol"`
		Supported bool   `json:"-"`
	}
	if err := s.client().Call(r.Context(), "ping", nil, &pong); err != nil {
		out["status"] = "error"
		out["error"] = err.Error()
		writeJSON(w, http.StatusOK, out)
		return
	}
	out["version"] = pong.Version
	out["protocol"] = pong.Protocol
	out["protocolTested"] = pong.Protocol >= 20 && pong.Protocol <= 22
	writeJSON(w, http.StatusOK, out)
}

type publicWorkspace struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Runtime     string `json:"runtime"`
	Windows     int    `json:"windows"`
	Attached    bool   `json:"attached"`
	AgentStatus string `json:"agentStatus,omitempty"`
	ActiveTabID string `json:"activeTabId,omitempty"`
	PaneCount   int    `json:"paneCount,omitempty"`
}

// publicPane is what the UI needs to render a pane. The name fields are
// optional in the daemon's schema and omitted when unset, so they are listed
// in the order the UI prefers them.
type publicPane struct {
	ID          string `json:"id"`
	WorkspaceID string `json:"workspaceId"`
	TabID       string `json:"tabId"`
	Focused     bool   `json:"focused"`
	Cwd         string `json:"cwd,omitempty"`
	AgentStatus string `json:"agentStatus,omitempty"`
	Revision    int    `json:"revision,omitempty"`
	// Label is the operator's own rename (herdr pane rename).
	Label string `json:"label,omitempty"`
	// Title is herdr's own title for the pane, distinct from the label.
	Title string `json:"title,omitempty"`
	// TerminalTitle is the OSC title the program in the pane set.
	TerminalTitle string `json:"terminalTitle,omitempty"`
	// Agent identifies the coding agent running in the pane.
	Agent        string `json:"agent,omitempty"`
	DisplayAgent string `json:"displayAgent,omitempty"`
}

// herdrPaneRow mirrors the daemon's pane object. Only the fields this bridge
// uses are declared; extras in the response are ignored.
type herdrPaneRow struct {
	PaneID                string `json:"pane_id"`
	WorkspaceID           string `json:"workspace_id"`
	TabID                 string `json:"tab_id"`
	Focused               bool   `json:"focused"`
	Cwd                   string `json:"cwd"`
	AgentStatus           string `json:"agent_status"`
	Revision              int    `json:"revision"`
	Label                 string `json:"label"`
	Title                 string `json:"title"`
	TerminalTitle         string `json:"terminal_title"`
	TerminalTitleStripped string `json:"terminal_title_stripped"`
	Agent                 string `json:"agent"`
	DisplayAgent          string `json:"display_agent"`
}

// terminalTitle prefers the daemon's stripped form, falling back to trimming
// the padded one. Both are absent for panes whose program sets no title.
func (p herdrPaneRow) terminalTitle() string {
	if strings.TrimSpace(p.TerminalTitleStripped) != "" {
		return strings.TrimSpace(p.TerminalTitleStripped)
	}
	return strings.TrimSpace(p.TerminalTitle)
}

func publicHerdrPane(p herdrPaneRow) publicPane {
	return publicPane{
		ID: p.PaneID, WorkspaceID: p.WorkspaceID, TabID: p.TabID,
		Focused: p.Focused, Cwd: p.Cwd, AgentStatus: p.AgentStatus,
		Revision:      p.Revision,
		Label:         strings.TrimSpace(p.Label),
		Title:         strings.TrimSpace(p.Title),
		TerminalTitle: p.terminalTitle(),
		Agent:         strings.TrimSpace(p.Agent),
		DisplayAgent:  strings.TrimSpace(p.DisplayAgent),
	}
}

func (s *Server) handleWorkspaces(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, "GET")
		return
	}
	var list struct {
		Type       string `json:"type"`
		Workspaces []struct {
			WorkspaceID string `json:"workspace_id"`
			Label       string `json:"label"`
			TabCount    int    `json:"tab_count"`
			Focused     bool   `json:"focused"`
			AgentStatus string `json:"agent_status"`
			ActiveTabID string `json:"active_tab_id"`
			PaneCount   int    `json:"pane_count"`
		} `json:"workspaces"`
	}
	if err := s.client().Call(r.Context(), "workspace.list", nil, &list); err != nil {
		writeBadGateway(w, "herdr_unavailable", err)
		return
	}
	out := make([]publicWorkspace, 0, len(list.Workspaces))
	for _, ws := range list.Workspaces {
		out = append(out, publicWorkspace{
			ID: ws.WorkspaceID, Name: ws.Label, Runtime: "herdr",
			Windows: ws.TabCount, Attached: ws.Focused,
			AgentStatus: ws.AgentStatus, ActiveTabID: ws.ActiveTabID,
			PaneCount: ws.PaneCount,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

// handleWorkspaceRename renames a workspace. herdr requires a non-empty
// label here (unlike a pane, a workspace has no "unnamed" state).
func (s *Server) handleWorkspaceRename(w http.ResponseWriter, r *http.Request, workspaceID string) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, "POST")
		return
	}
	workspaceID = strings.Trim(strings.TrimSpace(workspaceID), "/")
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "workspace id is required")
		return
	}
	var request struct {
		Label string `json:"label"`
	}
	if !decodeBody(w, r, &request) {
		return
	}
	label := strings.TrimSpace(request.Label)
	if label == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "label is required")
		return
	}
	if err := s.client().Call(r.Context(), "workspace.rename",
		map[string]any{"workspace_id": workspaceID, "label": label}, nil); err != nil {
		writeBadGateway(w, "herdr_rename_failed", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "workspaceId": workspaceID})
}

func (s *Server) handleWorkspaceGet(w http.ResponseWriter, r *http.Request, workspaceID string) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, "GET")
		return
	}
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		writeNotFound(w)
		return
	}
	var list struct {
		Type       string `json:"type"`
		Workspaces []struct {
			WorkspaceID string `json:"workspace_id"`
			Label       string `json:"label"`
			TabCount    int    `json:"tab_count"`
			Focused     bool   `json:"focused"`
			AgentStatus string `json:"agent_status"`
			ActiveTabID string `json:"active_tab_id"`
			PaneCount   int    `json:"pane_count"`
		} `json:"workspaces"`
	}
	if err := s.client().Call(r.Context(), "workspace.list", nil, &list); err != nil {
		writeBadGateway(w, "herdr_unavailable", err)
		return
	}
	var found *publicWorkspace
	for _, ws := range list.Workspaces {
		if ws.WorkspaceID == workspaceID {
			found = &publicWorkspace{
				ID: ws.WorkspaceID, Name: ws.Label, Runtime: "herdr",
				Windows: ws.TabCount, Attached: ws.Focused,
				AgentStatus: ws.AgentStatus, ActiveTabID: ws.ActiveTabID,
				PaneCount: ws.PaneCount,
			}
			break
		}
	}
	if found == nil {
		writeError(w, http.StatusNotFound, "herdr_workspace_missing", "herdr workspace not found")
		return
	}
	var panes struct {
		Type  string         `json:"type"`
		Panes []herdrPaneRow `json:"panes"`
	}
	if err := s.client().Call(r.Context(), "pane.list", map[string]any{"workspace_id": workspaceID}, &panes); err != nil {
		writeBadGateway(w, "herdr_unavailable", err)
		return
	}
	out := make([]publicPane, 0, len(panes.Panes))
	for _, p := range panes.Panes {
		out = append(out, publicHerdrPane(p))
	}
	writeJSON(w, http.StatusOK, map[string]any{"workspace": found, "panes": out})
}

// handlePanes lists every pane across every workspace in one call. The UI
// groups panes by status, so it needs the whole fleet, not one workspace at a
// time; herdr's pane.list already supports that.
func (s *Server) handlePanes(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, "GET")
		return
	}
	var list struct {
		Type  string         `json:"type"`
		Panes []herdrPaneRow `json:"panes"`
	}
	if err := s.client().Call(r.Context(), "pane.list", nil, &list); err != nil {
		writeBadGateway(w, "herdr_unavailable", err)
		return
	}
	out := make([]publicPane, 0, len(list.Panes))
	for _, pane := range list.Panes {
		out = append(out, publicHerdrPane(pane))
	}
	writeJSON(w, http.StatusOK, map[string]any{"panes": out})
}

func (s *Server) handlePaneRead(w http.ResponseWriter, r *http.Request, paneID string) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, "GET")
		return
	}
	paneID = strings.TrimSpace(strings.Trim(paneID, "/"))
	if paneID == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "pane id is required")
		return
	}
	source := strings.TrimSpace(r.URL.Query().Get("source"))
	if source == "" {
		source = "recent"
	}
	format := strings.TrimSpace(r.URL.Query().Get("format"))
	switch format {
	case "", "text", "ansi":
		if format == "" {
			format = "text"
		}
	default:
		writeError(w, http.StatusBadRequest, "invalid_request", "format must be text or ansi")
		return
	}
	lines := 80
	if raw := strings.TrimSpace(r.URL.Query().Get("lines")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 2000 {
			writeError(w, http.StatusBadRequest, "invalid_request", "lines must be between 1 and 2000")
			return
		}
		lines = parsed
	}
	var result struct {
		Type string `json:"type"`
		Read struct {
			PaneID      string `json:"pane_id"`
			WorkspaceID string `json:"workspace_id"`
			TabID       string `json:"tab_id"`
			Source      string `json:"source"`
			Format      string `json:"format"`
			Text        string `json:"text"`
			Revision    int    `json:"revision"`
			Truncated   bool   `json:"truncated"`
		} `json:"read"`
	}
	params := map[string]any{"pane_id": paneID, "source": source, "format": format, "lines": lines}
	if err := s.client().Call(r.Context(), "pane.read", params, &result); err != nil {
		writeBadGateway(w, "herdr_read_failed", err)
		return
	}
	agentStatus := ""
	var pane struct {
		Type string `json:"type"`
		Pane struct {
			AgentStatus string `json:"agent_status"`
		} `json:"pane"`
	}
	if err := s.client().Call(r.Context(), "pane.get", map[string]any{"pane_id": paneID}, &pane); err == nil {
		agentStatus = pane.Pane.AgentStatus
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"paneId": result.Read.PaneID, "source": result.Read.Source,
		"format": result.Read.Format, "text": result.Read.Text,
		"revision": result.Read.Revision, "truncated": result.Read.Truncated,
		"agentStatus": agentStatus,
	})
}

func (s *Server) handlePaneInput(w http.ResponseWriter, r *http.Request, paneID string) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, "POST")
		return
	}
	paneID = strings.Trim(strings.TrimSpace(paneID), "/")
	if paneID == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "pane id is required")
		return
	}
	var request struct {
		Text string `json:"text"`
		Data string `json:"data"`
	}
	if !decodeBody(w, r, &request) {
		return
	}
	text := request.Text
	if text == "" {
		text = request.Data
	}
	if text == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "text is required")
		return
	}
	if err := s.client().Call(r.Context(), "pane.send_text", map[string]any{"pane_id": paneID, "text": text}, nil); err != nil {
		writeBadGateway(w, "herdr_input_failed", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "paneId": paneID})
}

// handlePaneRename sets or clears a pane's own label. herdr treats a null
// label as "clear", which is how its own rename --clear works.
func (s *Server) handlePaneRename(w http.ResponseWriter, r *http.Request, paneID string) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, "POST")
		return
	}
	paneID = strings.Trim(strings.TrimSpace(paneID), "/")
	if paneID == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "pane id is required")
		return
	}
	var request struct {
		Label *string `json:"label"`
	}
	if !decodeBody(w, r, &request) {
		return
	}
	// A blank label is a clear, not a label made of spaces.
	label := request.Label
	if label != nil {
		trimmed := strings.TrimSpace(*label)
		if trimmed == "" {
			label = nil
		} else {
			label = &trimmed
		}
	}
	params := map[string]any{"pane_id": paneID}
	if label == nil {
		params["label"] = nil
	} else {
		params["label"] = *label
	}
	if err := s.client().Call(r.Context(), "pane.rename", params, nil); err != nil {
		writeBadGateway(w, "herdr_rename_failed", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "paneId": paneID})
}

func (s *Server) handlePaneKeys(w http.ResponseWriter, r *http.Request, paneID string) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, "POST")
		return
	}
	paneID = strings.Trim(strings.TrimSpace(paneID), "/")
	if paneID == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "pane id is required")
		return
	}
	var request struct {
		Keys []string `json:"keys"`
	}
	if !decodeBody(w, r, &request) {
		return
	}
	if len(request.Keys) == 0 {
		writeError(w, http.StatusBadRequest, "invalid_request", "keys is required")
		return
	}
	if err := s.client().Call(r.Context(), "pane.send_keys", map[string]any{"pane_id": paneID, "keys": request.Keys}, nil); err != nil {
		writeBadGateway(w, "herdr_keys_failed", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "paneId": paneID})
}

// Handler wires every route. Unknown /api paths 404 so a typo never falls
// through to the SPA shell.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", s.handleHealth)
	mux.HandleFunc("/api/v1/herdr/status", s.handleStatus)
	mux.HandleFunc("/api/v1/herdr/workspaces", s.handleWorkspaces)
	mux.HandleFunc("/api/v1/herdr/panes", s.handlePanes)
	mux.HandleFunc("/api/v1/herdr/workspaces/", func(w http.ResponseWriter, r *http.Request) {
		rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/herdr/workspaces/"), "/")
		if strings.HasSuffix(rest, "/rename") {
			s.handleWorkspaceRename(w, r, strings.TrimSuffix(rest, "/rename"))
			return
		}
		s.handleWorkspaceGet(w, r, rest)
	})
	mux.HandleFunc("/api/v1/herdr/panes/", func(w http.ResponseWriter, r *http.Request) {
		rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/herdr/panes/"), "/")
		switch {
		case strings.HasSuffix(rest, "/read"):
			s.handlePaneRead(w, r, strings.TrimSuffix(rest, "/read"))
		case strings.HasSuffix(rest, "/input"):
			s.handlePaneInput(w, r, strings.TrimSuffix(rest, "/input"))
		case strings.HasSuffix(rest, "/keys"):
			s.handlePaneKeys(w, r, strings.TrimSuffix(rest, "/keys"))
		case strings.HasSuffix(rest, "/rename"):
			s.handlePaneRename(w, r, strings.TrimSuffix(rest, "/rename"))
		default:
			writeNotFound(w)
		}
	})
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeNotFound(w)
	})
	mux.HandleFunc("/", s.handleStatic)
	return mux
}
