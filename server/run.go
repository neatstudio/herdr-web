package server

import (
	"context"
	"io/fs"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

// DefaultAddr is the flag default, kept here so --help, the README and tests
// agree on one value.
const DefaultAddr = "127.0.0.1:18080"

// Run starts the bridge and blocks until SIGINT or SIGTERM arrives. webFS may
// be nil: the API still serves, and the static handler answers with a hint
// instead of mangling the API routes.
func Run(addr, socketPath string, webFS fs.FS) error {
	handler := NewServer(socketPath, webFS).Handler()
	server := &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}
	stopped := make(chan error, 1)
	go func() {
		stopped <- server.ListenAndServe()
	}()
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	select {
	case err := <-stopped:
		return err
	case <-sig:
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return server.Shutdown(ctx)
	}
}

// DefaultSocketPath resolves the daemon socket the same way herdr does.
func DefaultSocketPath() string {
	if home, err := os.UserHomeDir(); err == nil {
		return home + "/.config/herdr/herdr.sock"
	}
	return "herdr.sock"
}
