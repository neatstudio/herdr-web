package server

import (
	"net"
	"net/http"
	"strings"
	"testing"
)

func TestDefaultPortsMatchTheRetiredControlPlane(t *testing.T) {
	// Existing bookmarks and Tailscale links must keep working.
	if DefaultPort != "5000" {
		t.Fatalf("remote port=%q", DefaultPort)
	}
	if DefaultLocalPort != "5001" {
		t.Fatalf("local port=%q", DefaultLocalPort)
	}
	if got := DefaultLocalAddr(); got != "127.0.0.1:5001" {
		t.Fatalf("local addr=%q", got)
	}
}

func TestValidatePrivateBindAcceptsOnlyPrivateReach(t *testing.T) {
	accepted := []string{
		"127.0.0.1:5001",
		"localhost:5001",
		"LOCALHOST:5001",
		"100.64.0.7:5000", // Tailscale CGNAT
		"10.0.0.5:5000",
		"192.168.1.20:5000",
		"172.16.4.4:5000",
		"[fd7a:115c:a1e0::1]:5000", // IPv6 ULA: bracketed, as net.SplitHostPort requires
	}
	for _, bind := range accepted {
		if err := ValidatePrivateBind(bind); err != nil {
			t.Fatalf("bind %q rejected: %v", bind, err)
		}
	}

	rejected := []string{
		"",
		":5000",
		"0.0.0.0:5000",
		"[::]:5000",
		"8.8.8.8:5000",
		"example.com:5000",
		"127.0.0.1",
		"127.0.0.1:not-a-port",
		"127.0.0.1:70000",
		"169.254.1.1:5000", // link-local
	}
	for _, bind := range rejected {
		if err := ValidatePrivateBind(bind); err == nil {
			t.Fatalf("bind %q was accepted but should be refused", bind)
		}
	}
}

func TestPreferredListenHostPicksTheLowestTailscaleAddress(t *testing.T) {
	host := preferredListenHost([]net.IP{
		net.ParseIP("192.168.1.9"),
		net.ParseIP("100.90.0.5"),
		net.ParseIP("100.64.0.7"),
		net.ParseIP("127.0.0.1"),
	})
	if host != "100.64.0.7" {
		t.Fatalf("host=%q", host)
	}
	// No Tailscale interface: fall back to loopback rather than failing.
	if got := preferredListenHost([]net.IP{net.ParseIP("192.168.1.9")}); got != "127.0.0.1" {
		t.Fatalf("fallback host=%q", got)
	}
	if got := preferredListenHost(nil); got != "127.0.0.1" {
		t.Fatalf("empty host=%q", got)
	}
}

func TestListenBindsEveryAddressAndSharesOneHandler(t *testing.T) {
	// Port 0 lets the OS pick, so the test never fights a real service.
	listeners, err := Listen([]string{"127.0.0.1:0", "localhost:0"})
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer func() {
		for _, listener := range listeners {
			_ = listener.Close()
		}
	}()
	if len(listeners) != 2 {
		t.Fatalf("want 2 listeners, got %d", len(listeners))
	}

	handler := NewServer(socketPathOrSkip(t), testWebFS()).Handler()
	servers := make([]*http.Server, 0, len(listeners))
	for _, listener := range listeners {
		server := &http.Server{Handler: handler}
		servers = append(servers, server)
		go func(server *http.Server, listener net.Listener) {
			_ = server.Serve(listener)
		}(server, listener)
	}
	defer func() {
		for _, server := range servers {
			_ = server.Close()
		}
	}()

	// Both ports must serve the same console.
	for _, listener := range listeners {
		response, err := http.Get("http://" + listener.Addr().String() + "/")
		if err != nil {
			t.Fatalf("GET %s: %v", listener.Addr(), err)
		}
		body := make([]byte, 256)
		count, _ := response.Body.Read(body)
		_ = response.Body.Close()
		if response.StatusCode != http.StatusOK {
			t.Fatalf("status=%d for %s", response.StatusCode, listener.Addr())
		}
		if !strings.Contains(string(body[:count]), "<title>herdr</title>") {
			t.Fatalf("body=%q for %s", string(body[:count]), listener.Addr())
		}
	}
}

func TestListenRefusesBadInputAndLeavesNothingBound(t *testing.T) {
	if _, err := Listen(nil); err == nil {
		t.Fatal("no addresses should be refused")
	}
	if _, err := Listen([]string{"", "   "}); err == nil {
		t.Fatal("blank addresses should be refused")
	}
	if _, err := Listen([]string{"0.0.0.0:5000"}); err == nil {
		t.Fatal("wildcard bind should be refused")
	}
	if _, err := Listen([]string{"127.0.0.1:0", "127.0.0.1:0"}); err == nil {
		t.Fatal("a repeated address should be refused")
	}
}

func TestListenReleasesEarlierPortsWhenALaterOneFails(t *testing.T) {
	// Occupy a port, then ask for a good one followed by the busy one: the
	// first must not stay bound.
	busy, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer func() { _ = busy.Close() }()

	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	freeAddress := probe.Addr().String()
	_ = probe.Close()

	if _, err := Listen([]string{freeAddress, busy.Addr().String()}); err == nil {
		t.Fatal("expected the busy address to fail the whole bind")
	}
	// The address must be free again, proving it was closed.
	again, err := net.Listen("tcp", freeAddress)
	if err != nil {
		t.Fatalf("first address leaked: %v", err)
	}
	_ = again.Close()
}
