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
	"os/user"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const shutdownTimeout = 5 * time.Second

// hasTailnetListener reports whether this console is reachable on the tailnet.
// A loopback-only process is local-only: it must not discover or follow peers.
func hasTailnetListener(listeners []net.Listener) bool {
	for _, listener := range listeners {
		address, ok := listener.Addr().(*net.TCPAddr)
		if ok && isTailnetAddress(address.IP) {
			return true
		}
	}
	return false
}

func isTailnetAddress(ip net.IP) bool {
	return ip != nil && tailscaleNetwork.Contains(ip)
}

// Run serves the console on every address in binds until SIGINT or SIGTERM
// arrives, then shuts them all down. webFS may be nil: the API still serves,
// and the static handler answers with a hint instead of mangling the routes.
func Run(binds []string, socketPath string, webFS fs.FS) error {
	console := NewServer(socketPath, webFS)
	listeners, err := Listen(binds)
	if err != nil {
		return err
	}
	console.tailnetFacing = hasTailnetListener(listeners)
	tailnetDiscoveryEnabled = console.tailnetFacing
	handler := GuardRequests(console.Handler(), listeners)
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

	// The heartbeats and the follow loop outlive any one request, so they run on
	// a context that is cancelled with the process.
	background, stopBackground := context.WithCancel(context.Background())
	defer stopBackground()
	console.StartFleet(background)

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
//
// A system service does not get HOME from systemd, and os.UserHomeDir then fails:
// returning a relative "herdr.sock" made the console dial a file in its working
// directory and report that the daemon was missing. The account's own home from
// /etc/passwd is the right answer, and the relative name is only a last resort.
func DefaultSocketPath() string {
	if home, err := os.UserHomeDir(); err == nil && strings.TrimSpace(home) != "" {
		return filepath.Join(home, ".config", "herdr", "herdr.sock")
	}
	if current, err := user.Current(); err == nil && strings.TrimSpace(current.HomeDir) != "" {
		return filepath.Join(current.HomeDir, ".config", "herdr", "herdr.sock")
	}
	return "herdr.sock"
}
