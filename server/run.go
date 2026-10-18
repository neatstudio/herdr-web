package server

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

const shutdownTimeout = 5 * time.Second

// Run serves the console on every address in binds until SIGINT or SIGTERM
// arrives, then shuts them all down. webFS may be nil: the API still serves,
// and the static handler answers with a hint instead of mangling the routes.
func Run(binds []string, socketPath string, webFS fs.FS) error {
	handler := NewServer(socketPath, webFS).Handler()
	listeners, err := Listen(binds)
	if err != nil {
		return err
	}
	servers := make([]*http.Server, 0, len(listeners))
	for _, listener := range listeners {
		fmt.Fprintf(os.Stderr, "herdr-web: listening on http://%s\n", listener.Addr())
		servers = append(servers, &http.Server{
			Handler:           handler,
			ReadHeaderTimeout: 10 * time.Second,
		})
	}
	if len(servers) == 0 {
		return errors.New("no usable listen address")
	}

	stopped := make(chan error, len(servers))
	for index, server := range servers {
		go func(server *http.Server, listener net.Listener) {
			err := server.Serve(listener)
			if errors.Is(err, http.ErrServerClosed) {
				err = nil
			}
			stopped <- err
		}(server, listeners[index])
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)

	select {
	case err := <-stopped:
		// One listener died: take the rest down rather than serving partially.
		shutdownAll(servers)
		if err == nil {
			return errors.New("a listener stopped unexpectedly")
		}
		return err
	case <-sig:
		shutdownAll(servers)
		return nil
	}
}

// Listen binds every address, validating each first. If any address is
// rejected or unavailable, listeners already opened are closed, so the caller
// never inherits a half-bound console.
func Listen(binds []string) ([]net.Listener, error) {
	listeners := make([]net.Listener, 0, len(binds))
	closeAll := func() {
		for _, listener := range listeners {
			_ = listener.Close()
		}
	}
	seen := map[string]bool{}
	for _, bind := range binds {
		address := strings.TrimSpace(bind)
		if address == "" {
			continue
		}
		if err := ValidatePrivateBind(address); err != nil {
			closeAll()
			return nil, err
		}
		if seen[address] {
			// Binding the same address twice would fail on the second
			// attempt anyway; say so plainly instead.
			closeAll()
			return nil, fmt.Errorf("listen address %s is repeated", address)
		}
		seen[address] = true
		listener, err := net.Listen("tcp", address)
		if err != nil {
			closeAll()
			return nil, fmt.Errorf("listen %s: %w", address, err)
		}
		listeners = append(listeners, listener)
	}
	if len(listeners) == 0 {
		return nil, errors.New("at least one listen address is required")
	}
	return listeners, nil
}

func shutdownAll(servers []*http.Server) {
	ctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	for _, server := range servers {
		_ = server.Shutdown(ctx)
	}
}

// DefaultSocketPath resolves the daemon socket the same way herdr does.
func DefaultSocketPath() string {
	if home, err := os.UserHomeDir(); err == nil {
		return home + "/.config/herdr/herdr.sock"
	}
	return "herdr.sock"
}
