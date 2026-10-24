package sharedledger

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
)

func natsBinary(t *testing.T) string {
	t.Helper()
	if path, err := exec.LookPath("nats-server"); err == nil {
		return path
	}
	if output, err := exec.Command("go", "env", "GOPATH").Output(); err == nil {
		path := filepath.Join(strings.TrimSpace(string(output)), "bin", "nats-server")
		if _, err := os.Stat(path); err == nil {
			return path
		}
	}
	t.Skip("nats-server is not installed")
	return ""
}

func freePort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = listener.Close() }()
	return listener.Addr().(*net.TCPAddr).Port
}

func startNATSServer(t *testing.T) string {
	t.Helper()
	binary := natsBinary(t)
	port := freePort(t)
	command := exec.Command(binary, "-js", "-a", "127.0.0.1", "-p", fmt.Sprint(port), "-sd", t.TempDir())
	command.Stdout = io.Discard
	command.Stderr = io.Discard
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = command.Process.Kill()
		_, _ = command.Process.Wait()
	})
	url := fmt.Sprintf("nats://127.0.0.1:%d", port)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		connection, err := nats.Connect(url, nats.Timeout(200*time.Millisecond))
		if err == nil {
			connection.Close()
			return url
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("nats-server did not start")
	return ""
}

func TestNATSLedgerLifecycle(t *testing.T) {
	url := startNATSServer(t)
	ledger, err := NewNATS(url, "test-tasks", "test-events")
	if err != nil {
		t.Fatal(err)
	}
	defer ledger.Close()
	ctx := context.Background()

	task, err := ledger.Create(ctx, Task{ID: "n1", Title: "nats"})
	if err != nil {
		t.Fatal(err)
	}
	claimed, err := ledger.Claim(ctx, "n1", RoleDev, "dev", time.Minute, task.Version)
	if err != nil {
		t.Fatal(err)
	}
	done, err := ledger.Attest(ctx, "n1", RoleDev, "dev", "abc", "", "sig", claimed.Version)
	if err != nil {
		t.Fatal(err)
	}
	if done.State != DevDone || done.Artifacts.Commit != "abc" {
		t.Fatalf("done = %+v", done)
	}
	events, err := ledger.Events(ctx, "n1")
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 3 || events[0].Type != "created" || events[2].Type != "attested" {
		t.Fatalf("events = %+v", events)
	}
}

func TestNATSConcurrentClaimOnlyOneWins(t *testing.T) {
	url := startNATSServer(t)
	ledger, err := NewNATS(url, "test-concurrent", "test-concurrent-events")
	if err != nil {
		t.Fatal(err)
	}
	defer ledger.Close()
	ctx := context.Background()
	task, err := ledger.Create(ctx, Task{ID: "n2"})
	if err != nil {
		t.Fatal(err)
	}

	results := make(chan error, 2)
	var wait sync.WaitGroup
	for _, node := range []string{"node-a", "node-b"} {
		node := node
		wait.Add(1)
		go func() {
			defer wait.Done()
			_, err := ledger.Claim(ctx, "n2", RoleDev, node, time.Minute, task.Version)
			results <- err
		}()
	}
	wait.Wait()
	close(results)
	successes, conflicts := 0, 0
	for err := range results {
		switch {
		case err == nil:
			successes++
		case errors.Is(err, ErrConflict):
			conflicts++
		default:
			t.Fatalf("unexpected error: %v", err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("successes=%d conflicts=%d", successes, conflicts)
	}
}
