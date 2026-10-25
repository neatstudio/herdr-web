package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
)

// A pane stream is one poller per pane, fanned out to every SSE client. Without
// the hub, N browser tabs would open N herdr reads per interval; with it, the
// daemon sees one.
type paneStreamHub struct {
	mu      sync.Mutex
	streams map[string]*paneStream
}

type paneStreamEvent struct {
	Kind        string `json:"kind"` // snapshot | delta | reset
	PaneID      string `json:"paneId"`
	Text        string `json:"text,omitempty"`
	Append      string `json:"append,omitempty"`
	Revision    int    `json:"revision"`
	AgentStatus string `json:"agentStatus,omitempty"`
	Truncated   bool   `json:"truncated,omitempty"`
}

type paneStream struct {
	server *Server
	paneID string

	mu          sync.Mutex
	subscribers map[chan paneStreamEvent]struct{}
	lastText    string
	lastRev     int
	lastStatus  string
	lastTrunc   bool
	stop        chan struct{}
	stopOnce    sync.Once
}

func newPaneStreamHub() *paneStreamHub {
	return &paneStreamHub{streams: map[string]*paneStream{}}
}

func (h *paneStreamHub) subscribe(server *Server, paneID string) (<-chan paneStreamEvent, func()) {
	h.mu.Lock()
	stream := h.streams[paneID]
	if stream == nil {
		stream = &paneStream{
			server:      server,
			paneID:      paneID,
			subscribers: map[chan paneStreamEvent]struct{}{},
			stop:        make(chan struct{}),
		}
		h.streams[paneID] = stream
		go stream.run()
	}
	channel := make(chan paneStreamEvent, 16)
	stream.mu.Lock()
	stream.subscribers[channel] = struct{}{}
	if stream.lastText != "" || stream.lastStatus != "" {
		channel <- paneStreamEvent{
			Kind: "snapshot", PaneID: paneID, Text: stream.lastText,
			Revision: stream.lastRev, AgentStatus: stream.lastStatus, Truncated: stream.lastTrunc,
		}
	}
	stream.mu.Unlock()
	h.mu.Unlock()
	return channel, func() { stream.remove(channel) }
}

func (h *paneStreamHub) remove(stream *paneStream) {
	h.mu.Lock()
	delete(h.streams, stream.paneID)
	h.mu.Unlock()
}

func (s *paneStream) remove(channel chan paneStreamEvent) {
	s.mu.Lock()
	delete(s.subscribers, channel)
	close(channel)
	empty := len(s.subscribers) == 0
	s.mu.Unlock()
	if empty {
		s.stopOnce.Do(func() { close(s.stop) })
		s.server.streams.remove(s)
	}
}

func (s *paneStream) run() {
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-s.stop:
			return
		case <-ticker.C:
			s.poll()
		}
	}
}

func (s *paneStream) poll() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	text, revision, truncated, status, err := s.server.readPaneStream(ctx, s.paneID)
	if err != nil {
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if text == s.lastText && status == s.lastStatus && truncated == s.lastTrunc {
		return
	}
	event := paneStreamEvent{
		PaneID: s.paneID, Revision: revision, AgentStatus: status, Truncated: truncated,
	}
	switch {
	case s.lastText == "":
		event.Kind = "snapshot"
		event.Text = text
	case strings.HasPrefix(text, s.lastText):
		event.Kind = "delta"
		event.Append = text[len(s.lastText):]
	case strings.HasPrefix(s.lastText, text):
		// The read window shrank; the client already has more than this.
		event.Kind = "snapshot"
		event.Text = text
	default:
		event.Kind = "reset"
		event.Text = text
	}
	s.lastText, s.lastRev, s.lastStatus, s.lastTrunc = text, revision, status, truncated

	for channel := range s.subscribers {
		select {
		case channel <- event:
		default:
			// A slow client missed a delta. Drain one stale event and send a
			// full snapshot so the terminal can resynchronize.
			select {
			case <-channel:
			default:
			}
			reset := event
			reset.Kind = "reset"
			reset.Text = text
			reset.Append = ""
			select {
			case channel <- reset:
			default:
			}
		}
	}
}

func (s *Server) readPaneStream(ctx context.Context, paneID string) (string, int, bool, string, error) {
	var read struct {
		Read struct {
			Text      string `json:"text"`
			Revision  int    `json:"revision"`
			Truncated bool   `json:"truncated"`
		} `json:"read"`
	}
	if err := s.client().Call(ctx, "pane.read", map[string]any{
		"pane_id": paneID, "source": "recent", "format": "text", "lines": 200,
	}, &read); err != nil {
		return "", 0, false, "", err
	}
	var pane struct {
		Pane struct {
			AgentStatus string `json:"agent_status"`
		} `json:"pane"`
	}
	_ = s.client().Call(ctx, "pane.get", map[string]any{"pane_id": paneID}, &pane)
	return read.Read.Text, read.Read.Revision, read.Read.Truncated, pane.Pane.AgentStatus, nil
}

func (s *Server) handlePaneStream(w http.ResponseWriter, r *http.Request, paneID string) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, "GET")
		return
	}
	paneID = strings.TrimSpace(strings.Trim(paneID, "/"))
	if paneID == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "pane id is required")
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "stream_unsupported", "streaming is not supported")
		return
	}
	channel, cancel := s.streams.subscribe(s, paneID)
	defer cancel()

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	fmt.Fprint(w, "retry: 1000\n\n")
	flusher.Flush()

	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-heartbeat.C:
			fmt.Fprint(w, ": ping\n\n")
			flusher.Flush()
		case event, ok := <-channel:
			if !ok {
				return
			}
			data, err := json.Marshal(event)
			if err != nil {
				continue
			}
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event.Kind, data)
			flusher.Flush()
		}
	}
}
