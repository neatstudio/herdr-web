package server

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestPaneStreamSendsSnapshotAndDelta(t *testing.T) {
	socket, state, closeFn := startFakeHerdr(t)
	defer closeFn()
	state.mu.Lock()
	state.readText = "hello"
	state.mu.Unlock()

	console := NewServer(socket, nil)
	server := httptest.NewServer(console.Handler())
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet,
		server.URL+"/api/v1/herdr/panes/w1:p1/stream", nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = response.Body.Close() }()

	scanner := bufio.NewScanner(response.Body)
	next := func() paneStreamEvent {
		t.Helper()
		var kind, data string
		for scanner.Scan() {
			line := scanner.Text()
			if strings.HasPrefix(line, "event: ") {
				kind = strings.TrimPrefix(line, "event: ")
			}
			if strings.HasPrefix(line, "data: ") {
				data = strings.TrimPrefix(line, "data: ")
			}
			if kind != "" && data != "" {
				var event paneStreamEvent
				if err := json.Unmarshal([]byte(data), &event); err != nil {
					t.Fatal(err)
				}
				event.Kind = kind
				return event
			}
		}
		t.Fatalf("stream ended: %v", scanner.Err())
		return paneStreamEvent{}
	}

	first := next()
	if first.Kind != "snapshot" || first.Text != "hello" {
		t.Fatalf("first = %+v", first)
	}
	state.mu.Lock()
	state.readText = "hello world"
	state.mu.Unlock()
	second := next()
	if second.Kind != "delta" || second.Append != " world" {
		t.Fatalf("second = %+v", second)
	}
}
