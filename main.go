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
	"herdr-web/server/sharedledger"
)

//go:embed all:web/dist
var embeddedWeb embed.FS

//go:embed install.sh
var embeddedInstaller []byte

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

// version is set at build time to the newest tag: -ldflags "-X main.version=$(git describe --tags --abbrev=0)".
// A released binary can then say what it is, which is what the installer and an
// operator need to tell two copies apart.
var version = "dev"

func main() {
	showVersion := flag.Bool("version", false, "print the version and exit")
	addr := flag.String("addr", server.DefaultAddr(),
		"Tailscale-facing listen address; \"\" to skip it (default: first Tailscale IPv4 on port "+server.DefaultPort+")")
	localAddr := flag.String("local-addr", server.DefaultLocalAddr(),
		"loopback listen address; \"\" to skip it")
	socket := flag.String("herdr-socket", "", "herdr daemon socket path (default ~/.config/herdr/herdr.sock)")
	fleetSeeds := flag.String("fleet-seeds", fleetSeedEnv(),
		"comma-separated consoles to start from; the fleet is exchanged peer to peer\n"+
			"and no seed is an authority (env HERDR_WEB_FLEET_SEEDS)")
	herdrBin := flag.String("herdr-bin", "",
		"herdr binary to inspect, install and update (default: herdr on PATH, then ~/.local/bin/herdr)")
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "herdr-web: standalone web UI + API bridge for a herdr daemon.\n\n")
		fmt.Fprintf(os.Stderr, "Usage:\n  herdr-web [-version] [-addr HOST:PORT] [-local-addr HOST:PORT] [-herdr-socket PATH] [-herdr-bin PATH]\n\n")
		fmt.Fprintf(os.Stderr, "Both listeners serve the same console. Only loopback, RFC1918,\n")
		fmt.Fprintf(os.Stderr, "Tailscale and IPv6 ULA addresses are accepted; this binary has no\n")
		fmt.Fprintf(os.Stderr, "authentication of its own.\n\n")
		flag.PrintDefaults()
	}
	flag.Parse()

	if *showVersion {
		fmt.Printf("herdr-web %s\n", version)
		return
	}

	// The console reports and manages herdr on this host, so it needs to know
	// which binary that is. launchd does not inherit the shell PATH, which is
	// why this can be set explicitly.
	server.SetHerdrBin(strings.TrimSpace(*herdrBin))
	server.ConsoleVersion = version
	server.SetInstallScript(embeddedInstaller)

	socketPath := strings.TrimSpace(*socket)
	if socketPath == "" {
		socketPath = server.DefaultSocketPath()
	}
	server.SetHerdrSocket(socketPath)
	// Seeds are an entry point to the fleet, not an authority over it.
	server.SetFleet(*fleetSeeds, *addr)
	// The shared task ledger is optional: unset keeps the in-memory board for a
	// single machine. Set HERDR_WEB_LEDGER_NATS to a NATS URL to make the board
	// shared across machines.
	if ledgerURL := strings.TrimSpace(os.Getenv("HERDR_WEB_LEDGER_NATS")); ledgerURL != "" {
		ledger, err := sharedledger.NewNATS(ledgerURL, "herdr-tasks", "herdr-task-events")
		if err != nil {
			fmt.Fprintln(os.Stderr, "herdr-web: shared ledger:", err)
			os.Exit(1)
		}
		server.SetSharedLedger(ledger)
	}

	fmt.Fprintf(os.Stderr, "herdr-web: socket %s\n", socketPath)
	if err := server.Run([]string{*addr, *localAddr}, socketPath, webFS()); err != nil {
		fmt.Fprintln(os.Stderr, "herdr-web:", err)
		os.Exit(1)
	}
}

// fleetSeedEnv reads the seed list, accepting the old single-hub variable so an
// installed unit keeps working after the rename.
func fleetSeedEnv() string {
	if seeds := strings.TrimSpace(os.Getenv("HERDR_WEB_FLEET_SEEDS")); seeds != "" {
		return seeds
	}
	return strings.TrimSpace(os.Getenv("HERDR_WEB_FLEET_HUB"))
}
