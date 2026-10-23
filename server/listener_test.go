package server

import (
	"encoding/json"
	"net"
	"net/http"
	"testing"
)

func TestTailnetFacingNeedsATailnetListener(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	if hasTailnetListener([]net.Listener{listener}) {
		t.Fatal("a loopback listener is not tailnet-facing")
	}
	if !isTailnetAddress(net.ParseIP("100.89.0.4")) {
		t.Fatal("100.89.0.4 is a tailnet address")
	}
	if isTailnetAddress(net.ParseIP("127.0.0.1")) {
		t.Fatal("loopback is not a tailnet address")
	}
}

func TestLoopbackOnlyConsoleDoesNotFollowOrDiscover(t *testing.T) {
	console := NewServer("", nil)
	console.tailnetFacing = false
	recorder := do(t, console.Handler(), http.MethodGet, "/api/v1/fleet", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("fleet = %d: %s", recorder.Code, recorder.Body.String())
	}
	var answer struct {
		Follow bool `json:"follow"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &answer); err != nil {
		t.Fatal(err)
	}
	if answer.Follow {
		t.Fatal("a loopback-only console must not follow the tailnet")
	}
}
