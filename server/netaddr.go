package server

import (
	"bytes"
	"errors"
	"fmt"
	"net"
	"sort"
	"strconv"
	"strings"
)

// Ports this console is expected to sit on. 5001 is loopback for local
// operators, 5000 is the Tailscale address the previous control plane used,
// so existing links and bookmarks keep working.
const (
	DefaultPort      = "5000"
	DefaultLocalPort = "5001"
)

var tailscaleNetwork = func() *net.IPNet {
	_, network, _ := net.ParseCIDR("100.64.0.0/10")
	return network
}()

// DefaultAddr is the Tailscale-facing listener: the first Tailscale address on
// this host, or loopback when there is no Tailscale interface.
func DefaultAddr() string {
	return net.JoinHostPort(preferredListenHost(activeInterfaceIPv4s()), DefaultPort)
}

// DefaultLocalAddr is the loopback listener.
func DefaultLocalAddr() string {
	return net.JoinHostPort("127.0.0.1", DefaultLocalPort)
}

// preferredListenHost picks the lowest Tailscale IPv4 so the address is stable
// across restarts, falling back to loopback when Tailscale is down.
func preferredListenHost(addresses []net.IP) string {
	candidates := make([]net.IP, 0, len(addresses))
	for _, address := range addresses {
		if ipv4 := address.To4(); ipv4 != nil && tailscaleNetwork.Contains(ipv4) {
			candidates = append(candidates, append(net.IP(nil), ipv4...))
		}
	}
	if len(candidates) == 0 {
		return "127.0.0.1"
	}
	sort.Slice(candidates, func(left, right int) bool {
		return bytes.Compare(candidates[left], candidates[right]) < 0
	})
	return candidates[0].String()
}

// activeInterfaceIPv4s lists the IPv4 addresses of every up, non-loopback
// interface.
func activeInterfaceIPv4s() []net.IP {
	interfaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	addresses := make([]net.IP, 0)
	for _, networkInterface := range interfaces {
		if networkInterface.Flags&net.FlagUp == 0 || networkInterface.Flags&net.FlagLoopback != 0 {
			continue
		}
		interfaceAddresses, err := networkInterface.Addrs()
		if err != nil {
			continue
		}
		for _, interfaceAddress := range interfaceAddresses {
			var address net.IP
			switch value := interfaceAddress.(type) {
			case *net.IPNet:
				address = value.IP
			case *net.IPAddr:
				address = value.IP
			}
			if ipv4 := address.To4(); ipv4 != nil {
				addresses = append(addresses, append(net.IP(nil), ipv4...))
			}
		}
	}
	return addresses
}

// ValidatePrivateBind rejects any listener that could expose the console
// beyond loopback, RFC1918, Tailscale or IPv6 ULA. This binary has no
// authentication, so a wildcard or public bind is a real hazard, and the check
// is based on an IP literal rather than a DNS lookup.
func ValidatePrivateBind(bind string) error {
	value := strings.TrimSpace(bind)
	host, port, err := net.SplitHostPort(value)
	if err != nil {
		return fmt.Errorf("bind must use host:port: %w", err)
	}
	if _, err := strconv.ParseUint(port, 10, 16); err != nil {
		return fmt.Errorf("bind port %q is invalid: %w", port, err)
	}
	host = strings.TrimSpace(host)
	if host == "" {
		return errors.New("bind cannot use a wildcard address")
	}
	if strings.EqualFold(strings.TrimSuffix(host, "."), "localhost") {
		return nil
	}
	ip := net.ParseIP(host)
	if !allowedPrivateBindIP(ip) {
		return fmt.Errorf("bind host %q must be loopback, RFC1918, Tailscale CGNAT, or IPv6 ULA", host)
	}
	return nil
}

func allowedPrivateBindIP(ip net.IP) bool {
	if ip == nil {
		return false
	}
	if mapped := ip.To4(); mapped != nil {
		ip = mapped
	}
	if ip.IsUnspecified() || ip.IsMulticast() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
		return false
	}
	return ip.IsLoopback() || ip.IsPrivate() || tailscaleNetwork.Contains(ip)
}
