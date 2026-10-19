// Command herdr-web serves the standalone herdr web UI and bridges its
// seven API routes to a herdr daemon socket. With no daemon (or no built
// bundle) it still starts and reports the backend as unavailable, so the UI
// can show that state instead of a dead page.
package main

import (
	"embed"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"strings"

	"herdr-web/server"
)

//go:embed all:web/dist
var embeddedWeb embed.FS

// webFS returns the embedded frontend bundle, or nil when it was not built
// yet (run `make web` first).
func webFS() fs.FS {
	sub, err := fs.Sub(embeddedWeb, "web/dist")
	if err != nil {
		return nil
	}
	if _, err := fs.Stat(sub, "index.html"); err != nil {
		return nil
	}
	return sub
}

func main() {
	addr := flag.String("addr", server.DefaultAddr(),
		"Tailscale-facing listen address; \"\" to skip it (default: first Tailscale IPv4 on port "+server.DefaultPort+")")
	localAddr := flag.String("local-addr", server.DefaultLocalAddr(),
		"loopback listen address; \"\" to skip it")
	socket := flag.String("herdr-socket", "", "herdr daemon socket path (default ~/.config/herdr/herdr.sock)")
	herdrBin := flag.String("herdr-bin", "",
		"herdr binary to inspect, install and update (default: herdr on PATH, then ~/.local/bin/herdr)")
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "herdr-web: standalone web UI + API bridge for a herdr daemon.\n\n")
		fmt.Fprintf(os.Stderr, "Usage:\n  herdr-web [-addr HOST:PORT] [-local-addr HOST:PORT] [-herdr-socket PATH] [-herdr-bin PATH]\n\n")
		fmt.Fprintf(os.Stderr, "Both listeners serve the same console. Only loopback, RFC1918,\n")
		fmt.Fprintf(os.Stderr, "Tailscale and IPv6 ULA addresses are accepted; this binary has no\n")
		fmt.Fprintf(os.Stderr, "authentication of its own.\n\n")
		flag.PrintDefaults()
	}
	flag.Parse()

	// The console reports and manages herdr on this host, so it needs to know
	// which binary that is. launchd does not inherit the shell PATH, which is
	// why this can be set explicitly.
	server.SetHerdrBin(strings.TrimSpace(*herdrBin))

	socketPath := strings.TrimSpace(*socket)
	if socketPath == "" {
		socketPath = server.DefaultSocketPath()
	}

	fmt.Fprintf(os.Stderr, "herdr-web: socket %s\n", socketPath)
	if err := server.Run([]string{*addr, *localAddr}, socketPath, webFS()); err != nil {
		fmt.Fprintln(os.Stderr, "herdr-web:", err)
		os.Exit(1)
	}
}
