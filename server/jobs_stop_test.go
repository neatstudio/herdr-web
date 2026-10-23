package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestJobStopClosesTheWorkspace(t *testing.T) {
	socket, state, closeFn := startFakeHerdr(t)
	defer closeFn()
	console := newTestHandler(t, socket)

	recorder := httptest.NewRecorder()
	console.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/api/v1/herdr/job/w1/stop", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", recorder.Code, recorder.Body.String())
	}
	if len(state.closedWorkspaces) != 1 || state.closedWorkspaces[0] != "w1" {
		t.Fatalf("closed = %v, want [w1]", state.closedWorkspaces)
	}
}
