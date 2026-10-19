package server

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"sync"
	"testing"
	"time"
)

// fakeHerdr is an in-process stand-in for the herdr daemon socket. It records
// every call so tests can assert the exact JSON-RPC the bridge emits.
type fakeHerdr struct {
	mu       sync.Mutex
	calls    []string
	sentText []string
	sentKeys []string
	readText string
	// failMethods makes the named methods answer with a daemon error.
	failMethods map[string]bool
	// revisions feeds pane.read so tests can exercise watermark changes.
	revision  int
	truncated bool
	// paramsByMethod keeps the most recent params per method, so an assertion
	// cannot be clobbered by a later call (pane.get follows pane.read).
	paramsByMethod map[string]map[string]any
	// barePaneNames omits every pane name field, the way the daemon does for
	// a pane nothing has named.
	barePaneNames bool
	// terminalTitle is the padded OSC title, used to check the fallback.
	terminalTitle string
	// renamedTo records every pane.rename label, "<clear>" for a null.
	renamedTo []string
	// renamedWorkspace records workspace.rename as "id=label".
	renamedWorkspace []string
	// resized records every pane.resize direction.
	resized []string
	// split records every pane.split direction, closed every pane.close id,
	// focusedTabs every tab.focus.
	split       []string
	closed      []string
	focusedTabs []string
}

func startFakeHerdr(t *testing.T) (socket string, state *fakeHerdr, closeFn func()) {
	t.Helper()
	// Short path: unix sockets cap out at ~104 bytes on macOS, and t.TempDir()
	// paths are already long.
	dir, err := os.MkdirTemp("/tmp", "hw")
	if err != nil {
		t.Fatalf("tempdir: %v", err)
	}
	socket = dir + "/h.sock"
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	state = &fakeHerdr{readText: "prompt% ", failMethods: map[string]bool{}}
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go serveFake(conn, state)
		}
	}()
	return socket, state, func() {
		_ = listener.Close()
		_ = os.RemoveAll(dir)
	}
}

type rpcRequest struct {
	ID     string         `json:"id"`
	Method string         `json:"method"`
	Params map[string]any `json:"params"`
}

func serveFake(conn net.Conn, state *fakeHerdr) {
	defer func() { _ = conn.Close() }()
	line, err := bufio.NewReader(conn).ReadBytes('\n')
	if err != nil {
		return
	}
	var req rpcRequest
	if err := json.Unmarshal(line, &req); err != nil {
		return
	}
	state.mu.Lock()
	state.calls = append(state.calls, req.Method)
	if state.paramsByMethod == nil {
		state.paramsByMethod = map[string]map[string]any{}
	}
	state.paramsByMethod[req.Method] = req.Params
	fail := state.failMethods[req.Method]
	var result any
	switch req.Method {
	case "ping":
		result = map[string]any{"type": "pong", "version": "0.9.0", "protocol": 22}
	case "workspace.list":
		result = map[string]any{"type": "workspace_list", "workspaces": []any{
			map[string]any{
				"workspace_id": "w1", "label": "web", "tab_count": 2, "focused": true,
				"agent_status": "working", "active_tab_id": "w1:t1", "pane_count": 2,
			},
		}}
	case "pane.list":
		pane := map[string]any{
			"pane_id": "w1:p1", "workspace_id": "w1", "tab_id": "w1:t1",
			"focused": true, "cwd": "/tmp", "agent_status": "working", "revision": 7,
		}
		if !state.barePaneNames {
			pane["label"] = "Deploy Watch"
			pane["title"] = "herdr title"
			if state.terminalTitle != "" {
				// A daemon that reports only the padded title, so the bridge's
				// trimming fallback is exercised.
				pane["terminal_title"] = state.terminalTitle
			} else {
				pane["terminal_title_stripped"] = "stripped title"
				pane["terminal_title"] = "stripped title" + "          "
			}
			pane["agent"] = "claude"
			pane["display_agent"] = "Claude"
		}
		result = map[string]any{"type": "pane_list", "panes": []any{pane}}
	case "pane.get":
		result = map[string]any{"type": "pane_info", "pane": map[string]any{
			"pane_id": "w1:p1", "workspace_id": "w1", "agent_status": "blocked",
			// The split route reads the tab from here, because herdr splits the
			// focused tab rather than an arbitrary pane.
			"tab_id": "w1:t2",
		}}
	case "pane.read":
		result = map[string]any{"type": "pane_read", "read": map[string]any{
			"pane_id": "w1:p1", "source": "recent", "format": "ansi",
			"text": state.readText, "revision": state.revision, "truncated": state.truncated,
		}}
	case "pane.send_text":
		if text, ok := req.Params["text"].(string); ok {
			state.sentText = append(state.sentText, text)
			state.readText += text
		}
		result = map[string]any{"type": "ok"}
	case "tab.focus":
		tabID, _ := req.Params["tab_id"].(string)
		state.focusedTabs = append(state.focusedTabs, tabID)
		result = map[string]any{"type": "tab_info", "tab": map[string]any{"tab_id": tabID}}
	case "pane.split":
		direction, _ := req.Params["direction"].(string)
		state.split = append(state.split, direction)
		result = map[string]any{"type": "pane_info", "pane": map[string]any{"pane_id": "w1:p9"}}
	case "pane.close":
		paneID, _ := req.Params["pane_id"].(string)
		state.closed = append(state.closed, paneID)
		result = map[string]any{"type": "ok"}
	case "pane.resize":
		direction, _ := req.Params["direction"].(string)
		state.resized = append(state.resized, direction)
		result = map[string]any{"type": "ok"}
	case "pane.layout":
		paneID, _ := req.Params["pane_id"].(string)
		result = map[string]any{
			"type": "pane_layout",
			"layout": map[string]any{
				"workspace_id":    "w1",
				"tab_id":          "w1:t1",
				"zoomed":          false,
				"area":            map[string]int{"x": 0, "y": 0, "width": 120, "height": 40},
				"focused_pane_id": paneID,
				"splits": []map[string]any{
					{"id": "split_0_root", "direction": "right", "ratio": 0.5,
						"rect": map[string]int{"x": 0, "y": 0, "width": 120, "height": 40}},
				},
				"panes": []map[string]any{
					{"pane_id": "w1:p1", "focused": true, "rect": map[string]int{"x": 0, "y": 0, "width": 60, "height": 40}},
					{"pane_id": "w1:p2", "focused": false, "rect": map[string]int{"x": 60, "y": 0, "width": 60, "height": 40}},
				},
			},
		}
	case "workspace.rename":
		if id, ok := req.Params["workspace_id"].(string); ok {
			if label, ok := req.Params["label"].(string); ok {
				state.renamedWorkspace = append(state.renamedWorkspace, id+"="+label)
			}
		}
		result = map[string]any{"type": "ok"}
	case "pane.rename":
		// label is explicitly null to clear; record what arrived either way.
		if raw, present := req.Params["label"]; present {
			if raw == nil {
				state.renamedTo = append(state.renamedTo, "<clear>")
			} else if text, ok := raw.(string); ok {
				state.renamedTo = append(state.renamedTo, text)
			}
		}
		result = map[string]any{"type": "ok"}
	case "pane.send_keys":
		if keys, ok := req.Params["keys"].([]any); ok {
			for _, key := range keys {
				if name, ok := key.(string); ok {
					state.sentKeys = append(state.sentKeys, name)
				}
			}
		}
		result = map[string]any{"type": "ok"}
	default:
		result = map[string]any{"type": "ok"}
	}
	state.mu.Unlock()

	var payload []byte
	if fail {
		payload, _ = json.Marshal(map[string]any{
			"id":    req.ID,
			"error": map[string]any{"code": "daemon_error", "message": "boom"},
		})
	} else {
		raw, _ := json.Marshal(result)
		payload, _ = json.Marshal(map[string]any{"id": req.ID, "result": json.RawMessage(raw)})
	}
	_, _ = conn.Write(append(payload, '\n'))
}

// waitForCalls blocks until the recorded call count reaches want, so tests
// never race the fake server's goroutine.
func (f *fakeHerdr) waitForCalls(t *testing.T, want int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		f.mu.Lock()
		got := len(f.calls)
		f.mu.Unlock()
		if got >= want {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %d daemon calls", want)
}

func (f *fakeHerdr) snapshot() (calls, sentText, sentKeys []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.calls...),
		append([]string(nil), f.sentText...),
		append([]string(nil), f.sentKeys...)
}

func (f *fakeHerdr) callsFor(method string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	count := 0
	for _, call := range f.calls {
		if call == method {
			count++
		}
	}
	return count
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return raw
}

func socketPathOrSkip(t *testing.T) string {
	t.Helper()
	return fmt.Sprintf("%s/herdr-%d.sock", t.TempDir(), time.Now().UnixNano())
}
