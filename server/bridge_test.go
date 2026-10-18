package server

import (
	"net/http"
	"strings"
	"testing"
)

func TestStatusReportsDaemonVersion(t *testing.T) {
	socket, state, closeFn := startFakeHerdr(t)
	defer closeFn()
	handler := newTestHandler(t, socket)

	response := do(t, handler, http.MethodGet, "/api/v1/herdr/status", "")
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	body := decodeMap(t, response)
	if body["status"] != "ok" || body["version"] != "0.9.0" {
		t.Fatalf("body=%v", body)
	}
	if body["protocolTested"] != true {
		t.Fatalf("protocol 22 must count as tested: %v", body)
	}
	state.waitForCalls(t, 1)
}

func TestStatusStillAnswersWhenDaemonIsMissing(t *testing.T) {
	// A dead socket must not 500: the UI needs this payload to render the
	// "daemon unreachable" state.
	handler := newTestHandler(t, socketPathOrSkip(t))
	response := do(t, handler, http.MethodGet, "/api/v1/herdr/status", "")
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	body := decodeMap(t, response)
	if body["status"] != "error" || body["error"] == nil {
		t.Fatalf("body=%v", body)
	}
}

func TestWorkspacesMapsDaemonFieldsToThePublicShape(t *testing.T) {
	socket, state, closeFn := startFakeHerdr(t)
	defer closeFn()
	handler := newTestHandler(t, socket)

	response := do(t, handler, http.MethodGet, "/api/v1/herdr/workspaces", "")
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	list := decodeList(t, response)
	if len(list) != 1 {
		t.Fatalf("want 1 workspace, got %d (%s)", len(list), response.Body.String())
	}
	first, _ := list[0].(map[string]any)
	for key, want := range map[string]any{
		"id": "w1", "name": "web", "runtime": "herdr",
		"windows": float64(2), "attached": true,
		"agentStatus": "working", "activeTabId": "w1:t1", "paneCount": float64(2),
	} {
		if first[key] != want {
			t.Fatalf("workspace[%s]=%v want %v (body=%s)", key, first[key], want, response.Body.String())
		}
	}
	state.waitForCalls(t, 1)
}

func TestWorkspaceDetailIncludesPanes(t *testing.T) {
	socket, _, closeFn := startFakeHerdr(t)
	defer closeFn()
	handler := newTestHandler(t, socket)

	response := do(t, handler, http.MethodGet, "/api/v1/herdr/workspaces/w1", "")
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	body := decodeMap(t, response)
	workspace, _ := body["workspace"].(map[string]any)
	if workspace["id"] != "w1" {
		t.Fatalf("workspace=%v", body["workspace"])
	}
	panes, _ := body["panes"].([]any)
	if len(panes) != 1 {
		t.Fatalf("panes=%v", body["panes"])
	}
	pane, _ := panes[0].(map[string]any)
	if pane["id"] != "w1:p1" || pane["agentStatus"] != "working" {
		t.Fatalf("pane=%v", pane)
	}
}

func TestWorkspaceDetailCarriesPaneNames(t *testing.T) {
	socket, _, closeFn := startFakeHerdr(t)
	defer closeFn()
	handler := newTestHandler(t, socket)

	response := do(t, handler, http.MethodGet, "/api/v1/herdr/workspaces/w1", "")
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	body := decodeMap(t, response)
	panes, _ := body["panes"].([]any)
	if len(panes) == 0 {
		t.Fatalf("no panes: %s", response.Body.String())
	}
	pane, _ := panes[0].(map[string]any)
	// herdr keeps four independent names; the bridge must not drop any of
	// them, because the UI prefers them over the raw pane id.
	for key, want := range map[string]any{
		"label":         "Deploy Watch",
		"title":         "herdr title",
		"terminalTitle": "stripped title",
		"agent":         "claude",
		"displayAgent":  "Claude",
	} {
		if pane[key] != want {
			t.Fatalf("pane[%s]=%v want %v (body=%s)", key, pane[key], want, response.Body.String())
		}
	}
}

func TestPaneNamesAreOmittedWhenTheDaemonSendsNone(t *testing.T) {
	socket, state, closeFn := startFakeHerdr(t)
	defer closeFn()
	state.mu.Lock()
	state.barePaneNames = true
	state.mu.Unlock()
	handler := newTestHandler(t, socket)

	response := do(t, handler, http.MethodGet, "/api/v1/herdr/workspaces/w1", "")
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d", response.Code)
	}
	body := decodeMap(t, response)
	panes, _ := body["panes"].([]any)
	pane, _ := panes[0].(map[string]any)
	for _, key := range []string{"label", "title", "terminalTitle", "agent", "displayAgent"} {
		if _, present := pane[key]; present {
			t.Fatalf("pane[%s] should be omitted, body=%s", key, response.Body.String())
		}
	}
}

func TestWorkspaceDetailFallsBackToThePaddedTerminalTitle(t *testing.T) {
	socket, state, closeFn := startFakeHerdr(t)
	defer closeFn()
	state.mu.Lock()
	state.terminalTitle = "   padded title   "
	state.mu.Unlock()
	handler := newTestHandler(t, socket)

	body := decodeMap(t, do(t, handler, http.MethodGet, "/api/v1/herdr/workspaces/w1", ""))
	panes, _ := body["panes"].([]any)
	pane, _ := panes[0].(map[string]any)
	if pane["terminalTitle"] != "padded title" {
		t.Fatalf("terminalTitle=%v", pane["terminalTitle"])
	}
}

func TestWorkspaceDetailUnknownIDIs404(t *testing.T) {
	socket, _, closeFn := startFakeHerdr(t)
	defer closeFn()
	handler := newTestHandler(t, socket)

	response := do(t, handler, http.MethodGet, "/api/v1/herdr/workspaces/nope", "")
	if response.Code != http.StatusNotFound {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	body := decodeMap(t, response)
	errBody, _ := body["error"].(map[string]any)
	if errBody["code"] != "herdr_workspace_missing" {
		t.Fatalf("body=%v", body)
	}
}

func TestPaneReadPassesFormatAndReportsAgentStatus(t *testing.T) {
	socket, state, closeFn := startFakeHerdr(t)
	defer closeFn()
	handler := newTestHandler(t, socket)

	response := do(t, handler, http.MethodGet, "/api/v1/herdr/panes/w1:p1/read?source=recent&lines=120&format=ansi", "")
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	body := decodeMap(t, response)
	if body["paneId"] != "w1:p1" || body["format"] != "ansi" {
		t.Fatalf("body=%v", body)
	}
	// pane.read cannot report agent status, so the bridge enriches with pane.get.
	if body["agentStatus"] != "blocked" {
		t.Fatalf("agentStatus=%v", body["agentStatus"])
	}
	state.waitForCalls(t, 2)
}

func TestPaneReadValidatesQuery(t *testing.T) {
	socket, _, closeFn := startFakeHerdr(t)
	defer closeFn()
	handler := newTestHandler(t, socket)

	for _, path := range []string{
		"/api/v1/herdr/panes/w1:p1/read?format=html",
		"/api/v1/herdr/panes/w1:p1/read?lines=0",
		"/api/v1/herdr/panes/w1:p1/read?lines=2001",
		"/api/v1/herdr/panes/w1:p1/read?lines=abc",
	} {
		response := do(t, handler, http.MethodGet, path, "")
		if response.Code != http.StatusBadRequest {
			t.Fatalf("path=%s status=%d body=%s", path, response.Code, response.Body.String())
		}
	}
}

func TestPaneReadDefaultsToTextAnd80Lines(t *testing.T) {
	socket, state, closeFn := startFakeHerdr(t)
	defer closeFn()
	handler := newTestHandler(t, socket)

	response := do(t, handler, http.MethodGet, "/api/v1/herdr/panes/w1:p1/read", "")
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	state.mu.Lock()
	readParams := state.paramsByMethod["pane.read"]
	state.mu.Unlock()
	if readParams["format"] != "text" || readParams["lines"] != float64(80) {
		t.Fatalf("params=%v", readParams)
	}
}

func TestPaneInputSendsTextVerbatim(t *testing.T) {
	socket, state, closeFn := startFakeHerdr(t)
	defer closeFn()
	handler := newTestHandler(t, socket)

	response := do(t, handler, http.MethodPost, "/api/v1/herdr/panes/w1:p1/input", `{"text":"echo hi\n"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	state.waitForCalls(t, 1)
	_, sentText, _ := state.snapshot()
	if len(sentText) != 1 || sentText[0] != "echo hi\n" {
		t.Fatalf("sentText=%q", sentText)
	}
}

func TestPaneInputAcceptsDataAlias(t *testing.T) {
	socket, state, closeFn := startFakeHerdr(t)
	defer closeFn()
	handler := newTestHandler(t, socket)

	response := do(t, handler, http.MethodPost, "/api/v1/herdr/panes/w1:p1/input", `{"data":"ls"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	state.waitForCalls(t, 1)
	_, sentText, _ := state.snapshot()
	if len(sentText) != 1 || sentText[0] != "ls" {
		t.Fatalf("sentText=%q", sentText)
	}
}

func TestPaneInputRejectsEmptyAndBadBodies(t *testing.T) {
	socket, _, closeFn := startFakeHerdr(t)
	defer closeFn()
	handler := newTestHandler(t, socket)

	for _, body := range []string{`{}`, `{"text":""}`, `not json`, `{"text":"a"}{"text":"b"}`} {
		response := do(t, handler, http.MethodPost, "/api/v1/herdr/panes/w1:p1/input", body)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("body=%q status=%d (%s)", body, response.Code, response.Body.String())
		}
	}
}

func TestPaneKeysSendsTab(t *testing.T) {
	socket, state, closeFn := startFakeHerdr(t)
	defer closeFn()
	handler := newTestHandler(t, socket)

	response := do(t, handler, http.MethodPost, "/api/v1/herdr/panes/w1:p1/keys", `{"keys":["Tab"]}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	state.waitForCalls(t, 1)
	_, _, sentKeys := state.snapshot()
	if len(sentKeys) != 1 || sentKeys[0] != "Tab" {
		t.Fatalf("sentKeys=%q", sentKeys)
	}
}

func TestPaneKeysRejectsEmptyList(t *testing.T) {
	socket, _, closeFn := startFakeHerdr(t)
	defer closeFn()
	handler := newTestHandler(t, socket)

	response := do(t, handler, http.MethodPost, "/api/v1/herdr/panes/w1:p1/keys", `{"keys":[]}`)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	body := decodeMap(t, response)
	errBody, _ := body["error"].(map[string]any)
	if errBody["code"] != "invalid_request" {
		t.Fatalf("body=%v", body)
	}
}

func TestPaneRenameSetsAndClearsTheLabel(t *testing.T) {
	socket, state, closeFn := startFakeHerdr(t)
	defer closeFn()
	handler := newTestHandler(t, socket)

	named := do(t, handler, http.MethodPost, "/api/v1/herdr/panes/w1:p1/rename", `{"label":"Deploy Watch"}`)
	if named.Code != http.StatusOK {
		t.Fatalf("rename status=%d body=%s", named.Code, named.Body.String())
	}
	// A blank label is a clear, not a label made of spaces.
	blank := do(t, handler, http.MethodPost, "/api/v1/herdr/panes/w1:p1/rename", `{"label":"   "}`)
	if blank.Code != http.StatusOK {
		t.Fatalf("blank status=%d body=%s", blank.Code, blank.Body.String())
	}
	cleared := do(t, handler, http.MethodPost, "/api/v1/herdr/panes/w1:p1/rename", `{"label":null}`)
	if cleared.Code != http.StatusOK {
		t.Fatalf("clear status=%d body=%s", cleared.Code, cleared.Body.String())
	}
	state.waitForCalls(t, 3)
	state.mu.Lock()
	defer state.mu.Unlock()
	want := []string{"Deploy Watch", "<clear>", "<clear>"}
	if len(state.renamedTo) != len(want) {
		t.Fatalf("renamedTo=%q", state.renamedTo)
	}
	for index, label := range want {
		if state.renamedTo[index] != label {
			t.Fatalf("rename[%d]=%q want %q", index, state.renamedTo[index], label)
		}
	}
}

func TestPaneRenameRejectsBadRequests(t *testing.T) {
	socket, _, closeFn := startFakeHerdr(t)
	defer closeFn()
	handler := newTestHandler(t, socket)

	if got := do(t, handler, http.MethodGet, "/api/v1/herdr/panes/w1:p1/rename", ""); got.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET status=%d", got.Code)
	}
	if got := do(t, handler, http.MethodPost, "/api/v1/herdr/panes/w1:p1/rename", "not json"); got.Code != http.StatusBadRequest {
		t.Fatalf("bad body status=%d", got.Code)
	}
}

func TestWorkspaceRenameSetsTheLabel(t *testing.T) {
	socket, state, closeFn := startFakeHerdr(t)
	defer closeFn()
	handler := newTestHandler(t, socket)

	ok := do(t, handler, http.MethodPost, "/api/v1/herdr/workspaces/w1/rename", `{"label":"  prod hosts  "}`)
	if ok.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", ok.Code, ok.Body.String())
	}
	state.waitForCalls(t, 1)
	state.mu.Lock()
	defer state.mu.Unlock()
	if len(state.renamedWorkspace) != 1 || state.renamedWorkspace[0] != "w1=prod hosts" {
		t.Fatalf("renamedWorkspace=%q", state.renamedWorkspace)
	}
}

func TestWorkspaceRenameRejectsAnEmptyLabel(t *testing.T) {
	// A workspace has no unnamed state, so an empty label is a bad request
	// rather than a clear.
	socket, _, closeFn := startFakeHerdr(t)
	defer closeFn()
	handler := newTestHandler(t, socket)

	for _, body := range []string{`{"label":""}`, `{"label":"   "}`, `{}`} {
		got := do(t, handler, http.MethodPost, "/api/v1/herdr/workspaces/w1/rename", body)
		if got.Code != http.StatusBadRequest {
			t.Fatalf("body=%s status=%d", body, got.Code)
		}
	}
	if got := do(t, handler, http.MethodGet, "/api/v1/herdr/workspaces/w1/rename", ""); got.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET status=%d", got.Code)
	}
}

func TestWorkspaceDetailStillRoutesAfterRenameWasAdded(t *testing.T) {
	socket, _, closeFn := startFakeHerdr(t)
	defer closeFn()
	handler := newTestHandler(t, socket)

	got := do(t, handler, http.MethodGet, "/api/v1/herdr/workspaces/w1", "")
	if got.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", got.Code, got.Body.String())
	}
	body := decodeMap(t, got)
	if _, present := body["workspace"]; !present {
		t.Fatalf("detail route lost: %s", got.Body.String())
	}
}

func TestPaneLayoutReportsBoxesAndFocus(t *testing.T) {
	socket, _, closeFn := startFakeHerdr(t)
	defer closeFn()
	handler := newTestHandler(t, socket)

	got := do(t, handler, http.MethodGet, "/api/v1/herdr/panes/w1:p2/layout", "")
	if got.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", got.Code, got.Body.String())
	}
	body := decodeMap(t, got)
	if body["tabId"] != "w1:t1" {
		t.Fatalf("tabId=%v", body["tabId"])
	}
	if body["focusedPaneId"] != "w1:p2" {
		t.Fatalf("focusedPaneId=%v", body["focusedPaneId"])
	}
	panes, ok := body["panes"].([]any)
	if !ok || len(panes) != 2 {
		t.Fatalf("panes=%v", body["panes"])
	}
	second, _ := panes[1].(map[string]any)
	rect, _ := second["rect"].(map[string]any)
	if rect["x"] != float64(60) || rect["width"] != float64(60) {
		t.Fatalf("second rect=%v", rect)
	}
	if method := do(t, handler, http.MethodPost, "/api/v1/herdr/panes/w1:p1/layout", ""); method.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST status=%d", method.Code)
	}
}

func TestPaneResizePassesTheDirectionThrough(t *testing.T) {
	socket, state, closeFn := startFakeHerdr(t)
	defer closeFn()
	handler := newTestHandler(t, socket)

	ok := do(t, handler, http.MethodPost, "/api/v1/herdr/panes/w1:p1/resize", `{"direction":"right"}`)
	if ok.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", ok.Code, ok.Body.String())
	}
	state.waitForCalls(t, 1)
	state.mu.Lock()
	resized := append([]string(nil), state.resized...)
	state.mu.Unlock()
	if len(resized) != 1 || resized[0] != "right" {
		t.Fatalf("resized=%q", resized)
	}

	// A direction herdr does not accept is refused before it is sent.
	for _, body := range []string{`{"direction":"sideways"}`, `{}`} {
		if got := do(t, handler, http.MethodPost, "/api/v1/herdr/panes/w1:p1/resize", body); got.Code != http.StatusBadRequest {
			t.Fatalf("body=%s status=%d", body, got.Code)
		}
	}
	if got := do(t, handler, http.MethodGet, "/api/v1/herdr/panes/w1:p1/resize", ""); got.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET status=%d", got.Code)
	}
}

func TestDaemonErrorBecomesBadGateway(t *testing.T) {
	socket, state, closeFn := startFakeHerdr(t)
	defer closeFn()
	state.mu.Lock()
	state.failMethods["workspace.list"] = true
	state.mu.Unlock()
	handler := newTestHandler(t, socket)

	response := do(t, handler, http.MethodGet, "/api/v1/herdr/workspaces", "")
	if response.Code != http.StatusBadGateway {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	body := decodeMap(t, response)
	errBody, _ := body["error"].(map[string]any)
	if errBody["code"] != "herdr_unavailable" {
		t.Fatalf("body=%v", body)
	}
	if !strings.Contains(errBody["message"].(string), "daemon_error") {
		t.Fatalf("daemon error text lost: %v", errBody)
	}
}

func TestMethodsAreEnforced(t *testing.T) {
	socket, _, closeFn := startFakeHerdr(t)
	defer closeFn()
	handler := newTestHandler(t, socket)

	cases := []struct{ method, path, allow string }{
		{http.MethodPost, "/api/v1/herdr/status", "GET"},
		{http.MethodPost, "/api/v1/herdr/workspaces", "GET"},
		{http.MethodGet, "/api/v1/herdr/panes/w1:p1/input", "POST"},
		{http.MethodGet, "/api/v1/herdr/panes/w1:p1/keys", "POST"},
	}
	for _, testCase := range cases {
		response := do(t, handler, testCase.method, testCase.path, "")
		if response.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s %s status=%d", testCase.method, testCase.path, response.Code)
		}
		if got := response.Header().Get("Allow"); got != testCase.allow {
			t.Fatalf("%s %s allow=%q want %q", testCase.method, testCase.path, got, testCase.allow)
		}
	}
}

func TestUnknownAPIPathNeverFallsBackToTheShell(t *testing.T) {
	handler := newTestHandler(t, socketPathOrSkip(t))

	for _, path := range []string{"/api/v1/herdr/nope", "/api/v1/herdr/panes/w1:p1/nope", "/api/other"} {
		response := do(t, handler, http.MethodGet, path, "")
		if response.Code != http.StatusNotFound {
			t.Fatalf("path=%s status=%d body=%s", path, response.Code, response.Body.String())
		}
		if strings.Contains(response.Body.String(), "<title>") {
			t.Fatalf("path=%s returned the SPA shell", path)
		}
	}
}

func TestStaticServesShellAssetsAndSPAFallback(t *testing.T) {
	handler := newTestHandler(t, socketPathOrSkip(t))

	shell := do(t, handler, http.MethodGet, "/", "")
	if shell.Code != http.StatusOK || !strings.Contains(shell.Body.String(), "<title>herdr</title>") {
		t.Fatalf("shell status=%d body=%s", shell.Code, shell.Body.String())
	}
	if got := shell.Header().Get("Cache-Control"); got != "no-cache" {
		t.Fatalf("shell cache-control=%q", got)
	}
	if got := shell.Header().Get("Content-Type"); !strings.HasPrefix(got, "text/html") {
		t.Fatalf("shell content-type=%q", got)
	}

	// Client-side route: extensionless miss serves the shell.
	route := do(t, handler, http.MethodGet, "/workspaces/w1", "")
	if route.Code != http.StatusOK || !strings.Contains(route.Body.String(), "<title>herdr</title>") {
		t.Fatalf("route status=%d body=%s", route.Code, route.Body.String())
	}

	asset := do(t, handler, http.MethodGet, "/assets/index-abc.js", "")
	if asset.Code != http.StatusOK || !strings.Contains(asset.Body.String(), "console.log") {
		t.Fatalf("asset status=%d body=%s", asset.Code, asset.Body.String())
	}
	if got := asset.Header().Get("Cache-Control"); got != "public, max-age=31536000, immutable" {
		t.Fatalf("asset cache-control=%q", got)
	}
	if got := asset.Header().Get("Content-Type"); !strings.HasPrefix(got, "text/javascript") {
		t.Fatalf("asset content-type=%q", got)
	}

	// A missing asset must 404 rather than return HTML.
	missing := do(t, handler, http.MethodGet, "/assets/missing.js", "")
	if missing.Code != http.StatusNotFound || strings.Contains(missing.Body.String(), "<title>") {
		t.Fatalf("missing asset status=%d body=%s", missing.Code, missing.Body.String())
	}
}

func TestStaticWithoutBundleExplainsItself(t *testing.T) {
	handler := NewServer(socketPathOrSkip(t), nil).Handler()
	response := do(t, handler, http.MethodGet, "/", "")
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	body := decodeMap(t, response)
	errBody, _ := body["error"].(map[string]any)
	if errBody["code"] != "web_unavailable" {
		t.Fatalf("body=%v", body)
	}
}

func TestHealthIsIndependentOfTheDaemon(t *testing.T) {
	handler := newTestHandler(t, socketPathOrSkip(t))
	response := do(t, handler, http.MethodGet, "/api/health", "")
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if body := decodeMap(t, response); body["status"] != "ok" {
		t.Fatalf("body=%v", body)
	}
}
