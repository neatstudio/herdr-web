package server

import (
	"context"
	"encoding/json"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
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

// expandHome turns "~" and "~/x" into the home directory.
//
// The shell on the operator's side would do this before herdr saw it; a form does
// not, and herdr takes the directory literally, so "~" arrived as a directory name
// and the workspace could not be created.
func expandHome(path string) string {
	path = strings.TrimSpace(path)
	if path == "" || !strings.HasPrefix(path, "~") {
		return path
	}
	home, err := os.UserHomeDir()
	if err != nil || strings.TrimSpace(home) == "" {
		return path
	}
	rest := strings.TrimPrefix(path, "~")
	if rest == "" {
		return home
	}
	if !strings.HasPrefix(rest, "/") {
		// "~name" belongs to another user; leave it for the shell to reject
		// rather than guessing whose home was meant.
		return path
	}
	return filepath.Join(home, rest)
}

func writeBadGateway(w http.ResponseWriter, code string, err error) {
	writeError(w, http.StatusBadGateway, code, err.Error())
}

// Server bridges one herdr daemon socket to HTTP and serves the embedded UI.
type Server struct {
	socketPath string
	webFS      fs.FS
	// fleet is the hub's peer list; fleetHub is the console this one follows
	// (empty on the hub itself) and fleetAddr is what it reports as its own.
	fleet      fleetState
	fleetSeeds []string
	fleetAddr  string
	// dispatch is what this console sent where; the jobs themselves live on the
	// machines running them.
	dispatch dispatchState
}

func NewServer(socketPath string, webFS fs.FS) *Server {
	return &Server{
		socketPath: socketPath,
		webFS:      webFS,
		fleet:      fleetState{peers: map[string]fleetPeer{}},
		fleetSeeds: defaultFleetSeeds,
		fleetAddr:  defaultFleetAddr,
	}
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

// ConsoleVersion is stamped by main so the UI can say which build it is.
var ConsoleVersion = "dev"

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, "GET")
		return
	}
	out := map[string]any{
		"enabled": true,
		"socket":  s.socketPath,
		"status":  "ok",
		// Which build of the console is answering, so a second copy on another
		// host can be told apart from this one.
		"consoleVersion": ConsoleVersion,
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

// handlePaneSplit creates a pane by splitting one.
//
// herdr splits the *focused* tab, not an arbitrary pane: measured against a live
// daemon, a split aimed at a pane in another tab landed in the focused tab
// instead. So the pane's tab is focused first — which is what the operator meant
// by aiming at that pane — and only then is the split asked for.
func (s *Server) handlePaneSplit(w http.ResponseWriter, r *http.Request, paneID string) {
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
		Direction string   `json:"direction"`
		Ratio     *float64 `json:"ratio"`
	}
	if !decodeBody(w, r, &request) {
		return
	}
	switch request.Direction {
	case "right", "down":
	default:
		writeError(w, http.StatusBadRequest, "invalid_request", "direction must be right or down")
		return
	}

	var got struct {
		Pane struct {
			TabID string `json:"tab_id"`
		} `json:"pane"`
	}
	if err := s.client().Call(r.Context(), "pane.get", map[string]any{"pane_id": paneID}, &got); err != nil {
		writeBadGateway(w, "herdr_split_failed", err)
		return
	}
	if got.Pane.TabID != "" {
		// Focusing the tab the pane lives in is what makes herdr split *that*
		// pane. It is idempotent when the tab is already in front.
		if err := s.client().Call(r.Context(), "tab.focus",
			map[string]any{"tab_id": got.Pane.TabID}, nil); err != nil {
			writeBadGateway(w, "herdr_split_failed", err)
			return
		}
	}

	params := map[string]any{"pane_id": paneID, "direction": request.Direction}
	if request.Ratio != nil {
		params["ratio"] = *request.Ratio
	}
	var result struct {
		Pane struct {
			PaneID string `json:"pane_id"`
		} `json:"pane"`
	}
	if err := s.client().Call(r.Context(), "pane.split", params, &result); err != nil {
		writeBadGateway(w, "herdr_split_failed", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":     true,
		"paneId": result.Pane.PaneID,
		"tabId":  got.Pane.TabID,
	})
}

// handlePaneClose closes one pane and everything running in it.
func (s *Server) handlePaneClose(w http.ResponseWriter, r *http.Request, paneID string) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, "POST")
		return
	}
	paneID = strings.Trim(strings.TrimSpace(paneID), "/")
	if paneID == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "pane id is required")
		return
	}
	if err := s.client().Call(r.Context(), "pane.close", map[string]any{"pane_id": paneID}, nil); err != nil {
		writeBadGateway(w, "herdr_close_failed", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "paneId": paneID})
}

// handlePaneResize moves one split edge. herdr owns the step size: it ignores
// small amounts and moves in its own increments, clamped so no pane falls below
// its minimum, so the client asks for a direction and then re-reads the layout
// rather than assuming where the edge landed.
func (s *Server) handlePaneResize(w http.ResponseWriter, r *http.Request, paneID string) {
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
		Direction string   `json:"direction"`
		Amount    *float64 `json:"amount"`
	}
	if !decodeBody(w, r, &request) {
		return
	}
	switch request.Direction {
	case "left", "right", "up", "down":
	default:
		writeError(w, http.StatusBadRequest, "invalid_request",
			"direction must be left, right, up or down")
		return
	}
	params := map[string]any{"pane_id": paneID, "direction": request.Direction}
	if request.Amount != nil {
		params["amount"] = *request.Amount
	}
	if err := s.client().Call(r.Context(), "pane.resize", params, nil); err != nil {
		writeBadGateway(w, "herdr_resize_failed", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "paneId": paneID, "direction": request.Direction})
}

// herdrRect is a pane's box in terminal cells, relative to its tab's area.
type herdrRect struct {
	X      int `json:"x"`
	Y      int `json:"y"`
	Width  int `json:"width"`
	Height int `json:"height"`
}

type herdrLayoutPane struct {
	PaneID  string    `json:"pane_id"`
	Focused bool      `json:"focused"`
	Rect    herdrRect `json:"rect"`
}

type herdrSplit struct {
	ID        string    `json:"id"`
	Direction string    `json:"direction"`
	Ratio     float64   `json:"ratio"`
	Rect      herdrRect `json:"rect"`
}

type herdrLayout struct {
	WorkspaceID   string            `json:"workspace_id"`
	TabID         string            `json:"tab_id"`
	Zoomed        bool              `json:"zoomed"`
	Area          herdrRect         `json:"area"`
	FocusedPaneID string            `json:"focused_pane_id"`
	Panes         []herdrLayoutPane `json:"panes"`
	Splits        []herdrSplit      `json:"splits"`
}

// handlePaneLayout reports how the panes of one tab are split. herdr gives each
// pane a box in terminal cells, which is all the client needs: proportions come
// from the boxes, so a nested split needs no tree walking.
func (s *Server) handlePaneLayout(w http.ResponseWriter, r *http.Request, paneID string) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, "GET")
		return
	}
	paneID = strings.Trim(strings.TrimSpace(paneID), "/")
	if paneID == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "pane id is required")
		return
	}
	var result struct {
		Layout herdrLayout `json:"layout"`
	}
	if err := s.client().Call(r.Context(), "pane.layout", map[string]any{"pane_id": paneID}, &result); err != nil {
		writeBadGateway(w, "herdr_layout_failed", err)
		return
	}
	panes := make([]map[string]any, 0, len(result.Layout.Panes))
	for _, pane := range result.Layout.Panes {
		panes = append(panes, map[string]any{
			"id":      pane.PaneID,
			"focused": pane.Focused,
			"rect":    pane.Rect,
		})
	}
	splits := make([]map[string]any, 0, len(result.Layout.Splits))
	for _, split := range result.Layout.Splits {
		splits = append(splits, map[string]any{
			"id":        split.ID,
			"direction": split.Direction,
			"ratio":     split.Ratio,
			"rect":      split.Rect,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"splits":        splits,
		"tabId":         result.Layout.TabID,
		"workspaceId":   result.Layout.WorkspaceID,
		"zoomed":        result.Layout.Zoomed,
		"area":          result.Layout.Area,
		"focusedPaneId": result.Layout.FocusedPaneID,
		"panes":         panes,
	})
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
	// GET lists the workspaces; POST makes one. Two registrations of the same
	// pattern panic at startup, so they share one.
	mux.HandleFunc("/api/v1/fleet", s.handleFleet)
	mux.HandleFunc("/api/v1/fleet/job", s.handleDispatch)
	mux.HandleFunc("/api/v1/fleet/jobs", s.handleDispatchList)
	mux.HandleFunc("/api/v1/fleet/hello", s.handleFleetHello)

	mux.HandleFunc("/api/v1/herdr/job", s.handleJobStart)
	mux.HandleFunc("/api/v1/herdr/job/", func(w http.ResponseWriter, r *http.Request) {
		rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/herdr/job/"), "/")
		if rest == "" {
			writeError(w, http.StatusNotFound, "not_found", "unknown job path")
			return
		}
		if strings.HasSuffix(rest, "/stop") {
			s.handleJobStop(w, r, strings.TrimSuffix(rest, "/stop"))
			return
		}
		if strings.HasSuffix(rest, "/diff") {
			s.handleJobDiff(w, r, strings.TrimSuffix(rest, "/diff"))
			return
		}
		s.handleJobStatus(w, r, rest)
	})
	mux.HandleFunc("/api/v1/herdr/agents", s.handleAgentKinds)

	mux.HandleFunc("/api/v1/herdr/workspaces", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			s.handleWorkspaceCreate(w, r)
			return
		}
		s.handleWorkspaces(w, r)
	})
	mux.HandleFunc("/api/v1/herdr/panes", s.handlePanes)
	mux.HandleFunc("/api/v1/herdr/uploads", s.handleUpload)

	// Read-only file preview: an agent writes a chart or a log, prints its path,
	// and clicking that path shows it. Reads only, regular files only.
	// What herdr is on this machine, and the two ways to change that. These work
	// without herdr installed at all: that is exactly when they matter.
	mux.HandleFunc("/api/v1/herdr/host", handleHostStatus)
	mux.HandleFunc("/api/v1/herdr/host/update", handleHostUpdate)
	mux.HandleFunc("/api/v1/herdr/host/restart", handleHostRestart)
	mux.HandleFunc("/api/v1/herdr/host/install", handleHostInstall)
	mux.HandleFunc("/api/v1/herdr/host/stat", handleHostStat)
	mux.HandleFunc("/api/v1/herdr/file", handleFileRead)
	mux.HandleFunc("/api/v1/herdr/file/raw", handleFileRaw)

	mux.HandleFunc("/api/v1/herdr/tabs", s.handleTabCreate)
	mux.HandleFunc("/api/v1/herdr/tmux", s.handleTmuxSessions)
	mux.HandleFunc("/api/v1/herdr/tmux/output", s.handleTmuxOutput)
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
		case strings.HasSuffix(rest, "/run"):
			s.handlePaneRun(w, r, strings.TrimSuffix(rest, "/run"))
		case strings.HasSuffix(rest, "/keys"):
			s.handlePaneKeys(w, r, strings.TrimSuffix(rest, "/keys"))
		case strings.HasSuffix(rest, "/split"):
			s.handlePaneSplit(w, r, strings.TrimSuffix(rest, "/split"))
		case strings.HasSuffix(rest, "/close"):
			s.handlePaneClose(w, r, strings.TrimSuffix(rest, "/close"))
		case strings.HasSuffix(rest, "/resize"):
			s.handlePaneResize(w, r, strings.TrimSuffix(rest, "/resize"))
		case strings.HasSuffix(rest, "/layout"):
			s.handlePaneLayout(w, r, strings.TrimSuffix(rest, "/layout"))
		case strings.HasSuffix(rest, "/rename"):
			s.handlePaneRename(w, r, strings.TrimSuffix(rest, "/rename"))
		default:
			writeNotFound(w)
		}
	})
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeNotFound(w)
	})
	mux.HandleFunc("/api/v1/herdr-web/release", handleSelfRelease)
	mux.HandleFunc("/api/v1/herdr-web/update", handleSelfUpdate)
	mux.HandleFunc("/api/v1/herdr-web/rollback", handleSelfRollback)
	// The console is also a release source: a host that cannot reach GitHub
	// installs from a peer that can (or from a bastion).
	mux.HandleFunc("/release/", handleRelease)
	mux.HandleFunc("/", s.handleStatic)
	return mux
}

// handleTabCreate adds a tab to a workspace: a new shell beside the ones that are
// already there, which is what the strip's + was supposed to do. Splitting is a
// different action, and it belongs to the pane it splits, not to the strip.
func (s *Server) handleTabCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, "POST")
		return
	}
	var request struct {
		WorkspaceID string `json:"workspaceId"`
		Cwd         string `json:"cwd"`
		Label       string `json:"label"`
	}
	if !decodeBody(w, r, &request) {
		return
	}
	params := map[string]any{"focus": true}
	if workspaceID := strings.TrimSpace(request.WorkspaceID); workspaceID != "" {
		params["workspace_id"] = workspaceID
	}
	if cwd := expandHome(request.Cwd); cwd != "" {
		params["cwd"] = cwd
	}
	if label := strings.TrimSpace(request.Label); label != "" {
		params["label"] = label
	}
	var created struct {
		Tab struct {
			TabID       string `json:"tab_id"`
			WorkspaceID string `json:"workspace_id"`
		} `json:"tab"`
		RootPane struct {
			PaneID string `json:"pane_id"`
		} `json:"root_pane"`
	}
	if err := s.client().Call(r.Context(), "tab.create", params, &created); err != nil {
		writeBadGateway(w, "herdr_tab_failed", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":          true,
		"tabId":       created.Tab.TabID,
		"paneId":      created.RootPane.PaneID,
		"workspaceId": created.Tab.WorkspaceID,
	})
}

// handleWorkspaceCreate makes a workspace, which the console had no way to do:
// it could see and rename the ones that existed and nothing else.
//
// A command may be given, and it is run in the new workspace's root pane. That is
// how an existing tmux session is taken over — herdr has no tmux integration, so
// the pane runs `tmux attach` and the session appears inside it.
func (s *Server) handleWorkspaceCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, "POST")
		return
	}
	var request struct {
		Label   string   `json:"label"`
		Cwd     string   `json:"cwd"`
		Command []string `json:"command"`
	}
	if !decodeBody(w, r, &request) {
		return
	}
	params := map[string]any{"focus": true}
	if label := strings.TrimSpace(request.Label); label != "" {
		params["label"] = label
	}
	if cwd := expandHome(request.Cwd); cwd != "" {
		params["cwd"] = cwd
	}
	var created struct {
		Workspace struct {
			WorkspaceID string `json:"workspace_id"`
			Label       string `json:"label"`
		} `json:"workspace"`
		RootPane struct {
			PaneID string `json:"pane_id"`
		} `json:"root_pane"`
	}
	if err := s.client().Call(r.Context(), "workspace.create", params, &created); err != nil {
		writeBadGateway(w, "herdr_workspace_failed", err)
		return
	}

	out := map[string]any{
		"ok":          true,
		"workspaceId": created.Workspace.WorkspaceID,
		"paneId":      created.RootPane.PaneID,
		"label":       created.Workspace.Label,
	}
	if len(request.Command) > 0 {
		// The pane exists once create returns, so running the command here is
		// ordered after it by construction.
		runParams := map[string]any{
			"pane_id": created.RootPane.PaneID,
			"command": request.Command,
		}
		if err := s.client().Call(r.Context(), "pane.run", runParams, nil); err != nil {
			// The workspace exists; saying so is more useful than pretending it
			// does not, so the failure is reported next to it.
			out["commandError"] = err.Error()
		}
	}
	writeJSON(w, http.StatusOK, out)
}

// handlePaneRun runs a command in an existing pane.
func (s *Server) handlePaneRun(w http.ResponseWriter, r *http.Request, paneID string) {
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
		Command []string `json:"command"`
	}
	if !decodeBody(w, r, &request) {
		return
	}
	if len(request.Command) == 0 {
		writeError(w, http.StatusBadRequest, "invalid_request", "command is required")
		return
	}
	if err := s.client().Call(r.Context(), "pane.run",
		map[string]any{"pane_id": paneID, "command": request.Command}, nil); err != nil {
		writeBadGateway(w, "herdr_run_failed", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "paneId": paneID})
}

// handleTmuxOutput shows a tmux session's screen without attaching to it.
//
// Attaching adds a client, and tmux then sizes the window to the client used
// last: a session someone is working in arrives squashed. Reading the pane with
// capture-pane changes nothing, which is what a session with live work in it
// needs when the question is only "what is it doing".
func (s *Server) handleTmuxOutput(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, "GET")
		return
	}
	session := strings.TrimSpace(r.URL.Query().Get("session"))
	if session == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "session is required")
		return
	}
	lines := 120
	if raw := strings.TrimSpace(r.URL.Query().Get("lines")); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 && parsed <= 1000 {
			lines = parsed
		}
	}
	binary, err := exec.LookPath("tmux")
	if err != nil {
		writeError(w, http.StatusNotFound, "tmux_missing", "tmux is not installed on this host")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), hostStatusTimeout)
	defer cancel()

	// The name is checked against the sessions that exist rather than passed
	// through: tmux targets are a small language, and this endpoint takes a word.
	listed, listErr := exec.CommandContext(ctx, binary, "list-sessions", "-F", "#{session_name}").Output()
	if listErr != nil && len(listed) == 0 {
		writeError(w, http.StatusNotFound, "tmux_missing", "no tmux server is running on this host")
		return
	}
	known := false
	for _, name := range strings.Split(strings.TrimSpace(string(listed)), "\n") {
		if strings.TrimSpace(name) == session {
			known = true
			break
		}
	}
	if !known {
		writeError(w, http.StatusNotFound, "unknown_session", "no such tmux session: "+session)
		return
	}

	// -J joins wrapped lines so the console can wrap them to its own width, and -p
	// prints to stdout instead of a terminal.
	output, captureErr := exec.CommandContext(ctx, binary,
		"capture-pane", "-p", "-J", "-t", session, "-S", "-"+strconv.Itoa(lines)).Output()
	if captureErr != nil && len(output) == 0 {
		writeBadGateway(w, "tmux_capture_failed", captureErr)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"session": session,
		"lines":   lines,
		"output":  string(output),
	})
}

// handleTmuxSessions lists the tmux sessions on this host, so a session that was
// already running can be taken over instead of abandoned.
func (s *Server) handleTmuxSessions(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, "GET")
		return
	}
	type session struct {
		Name     string `json:"name"`
		Windows  int    `json:"windows"`
		Attached int    `json:"attached"`
	}
	out := map[string]any{"sessions": []session{}, "available": false}

	binary, err := exec.LookPath("tmux")
	if err != nil {
		writeJSON(w, http.StatusOK, out)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), hostStatusTimeout)
	defer cancel()
	raw, runErr := exec.CommandContext(ctx, binary, "list-sessions",
		"-F", "#{session_name}\t#{session_windows}\t#{session_attached}").Output()
	sessions := make([]session, 0, 4)
	for _, line := range strings.Split(string(raw), "\n") {
		fields := strings.Split(strings.TrimSpace(line), "\t")
		if len(fields) < 3 {
			continue
		}
		windows, _ := strconv.Atoi(fields[1])
		attached, _ := strconv.Atoi(fields[2])
		sessions = append(sessions, session{Name: fields[0], Windows: windows, Attached: attached})
	}
	// "no server running" is an empty list, not a failure.
	out["sessions"] = sessions
	out["available"] = true
	if runErr != nil && len(sessions) == 0 && !strings.Contains(runErr.Error(), "exit status") {
		out["error"] = runErr.Error()
	}
	writeJSON(w, http.StatusOK, out)
}
