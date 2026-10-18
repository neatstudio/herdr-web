package server

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"sync/atomic"
	"time"
)

// request is one JSON-RPC line sent to the herdr daemon over its unix socket.
type request struct {
	ID     string         `json:"id"`
	Method string         `json:"method"`
	Params map[string]any `json:"params"`
}

// response is one JSON-RPC line read back from the daemon.
type response struct {
	ID     string          `json:"id"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *apiError       `json:"error,omitempty"`
}

type apiError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *apiError) Error() string {
	if e == nil {
		return ""
	}
	if e.Code != "" {
		return e.Code + ": " + e.Message
	}
	return e.Message
}

// Client speaks the herdr daemon socket protocol: newline-delimited JSON-RPC
// request/response pairs over a unix socket, one connection per call.
type Client struct {
	socketPath string
	timeout    time.Duration
	seq        atomic.Uint64
	dial       func(ctx context.Context, path string) (net.Conn, error)
}

func NewClient(socketPath string) *Client {
	return &Client{
		socketPath: socketPath,
		timeout:    10 * time.Second,
		dial: func(ctx context.Context, path string) (net.Conn, error) {
			var dialer net.Dialer
			return dialer.DialContext(ctx, "unix", path)
		},
	}
}

// Call performs one JSON-RPC round trip. A nil out skips result decoding but
// still surfaces daemon-side errors.
func (c *Client) Call(ctx context.Context, method string, params map[string]any, out any) error {
	if c == nil {
		return errors.New("herdr: nil client")
	}
	if method == "" {
		return errors.New("herdr: method required")
	}
	if params == nil {
		params = map[string]any{}
	}
	if _, ok := ctx.Deadline(); !ok && c.timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, c.timeout)
		defer cancel()
	}

	id := fmt.Sprintf("herdr-web-%d", c.seq.Add(1))
	payload, err := json.Marshal(request{ID: id, Method: method, Params: params})
	if err != nil {
		return err
	}
	payload = append(payload, '\n')

	conn, err := c.dial(ctx, c.socketPath)
	if err != nil {
		return fmt.Errorf("herdr dial %s: %w", c.socketPath, err)
	}
	defer conn.Close()

	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	if _, err := conn.Write(payload); err != nil {
		return fmt.Errorf("herdr write: %w", err)
	}
	line, err := bufio.NewReader(conn).ReadBytes('\n')
	if err != nil {
		return fmt.Errorf("herdr read: %w", err)
	}
	var resp response
	if err := json.Unmarshal(line, &resp); err != nil {
		return fmt.Errorf("herdr decode: %w", err)
	}
	if resp.ID != "" && resp.ID != id {
		return fmt.Errorf("herdr: response id %q does not match request %q", resp.ID, id)
	}
	if resp.Error != nil {
		return resp.Error
	}
	if out == nil {
		return nil
	}
	if len(resp.Result) == 0 || string(resp.Result) == "null" {
		return errors.New("herdr: empty result")
	}
	if err := json.Unmarshal(resp.Result, out); err != nil {
		return fmt.Errorf("herdr result decode: %w", err)
	}
	return nil
}
