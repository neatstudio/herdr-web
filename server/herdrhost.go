package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// This file is about herdr on *this* machine, not about the daemon behind the
// socket: it answers whether the CLI is installed, which version it is, what
// the daemon is doing, and whether the CLI can install or update itself from
// the console. That is why it shells out and reads files instead of speaking
// JSON-RPC.

const (
	// hostLatestURL is the release feed the official installer and `herdr
	// update` read, so it is the only source that can agree with them.
	hostLatestURL = "https://herdr.dev/latest.json"

	hostInstallURL = "https://herdr.dev/install.sh"

	// hostInstallCommand is built from compile-time constants only. No value
	// from a request is ever concatenated into it, so the one shell string in
	// this file cannot be steered by a caller.
	hostInstallCommand = "curl -fsSL " + hostInstallURL + " | sh"
	// hostInstallDisplay is how that pipeline is reported back: the argv that
	// actually ran, not a second copy of the pipeline.
	hostInstallDisplay = `sh -c "` + hostInstallCommand + `"`

	// hostStatusTimeout bounds a local command that normally answers in
	// milliseconds. It is short because the panel must not hang the console
	// when the binary wedges.
	hostStatusTimeout = 10 * time.Second
	// hostLatestTimeout is the network budget for the version check. It is
	// generous because the first request from this process pays for DNS and TLS:
	// measured here, a cold check takes about 5.1s and the next ones 60ms, so a
	// five second budget reported a timeout on the very first open of the panel.
	hostLatestTimeout = 15 * time.Second
	// hostCommandTimeout bounds install and update: an installer downloads a
	// binary, and a package manager may compile or wait on a lock.
	hostCommandTimeout = 5 * time.Minute

	// hostFetchLimit keeps a surprising feed from being read into memory.
	hostFetchLimit = 1 << 20

	// hostDaemonSession is the tmux session the console starts herdr in when it
	// has to start the daemon itself. herdr is a TUI and refuses to run without
	// a terminal, so a session manager is the only way to start one unattended.
	hostDaemonSession = "herdr-daemon"
)

// hostRunner runs one command with a fixed argv and returns its combined
// output. Replaceable so tests exercise the handlers without running real
// installers.
type hostRunner func(ctx context.Context, name string, args ...string) ([]byte, error)

// hostFetcher reads one URL. Replaceable for the same reason.
type hostFetcher func(ctx context.Context, url string) ([]byte, error)

var (
	hostMu sync.RWMutex
	// hostBinOverride is SetHerdrBin's value. A launchd or systemd unit does
	// not inherit the shell PATH, so the operator can pin the binary.
	hostBinOverride string
	hostRun         hostRunner  = defaultHostRun
	hostFetch       hostFetcher = defaultHostFetch
	// hostSpawnDetached starts the headless server. Replaceable so a test does
	// not launch a real daemon.
	hostSpawnDetached = spawnDetached
	// hostStartTimeout bounds the wait for a started daemon to answer. A
	// variable so tests do not sit through the real budget.
	hostStartTimeout = 20 * time.Second
	// hostSocketPath is the socket the console talks to. herdr's CLI resolves a
	// session from the socket path, and a stop or start must act on the daemon
	// this console uses rather than on the default one.
	hostSocketPath string
	// hostResolve is a seam for tests: they cannot create /opt/homebrew or
	// /nix/store, so the machine lookup itself is replaceable. Production
	// always uses findHerdrBinary.
	hostResolve = findHerdrBinary
)

// SetHerdrSocket records the socket the console talks to, so a restart targets
// that daemon.
func SetHerdrSocket(path string) {
	hostMu.Lock()
	hostSocketPath = strings.TrimSpace(path)
	hostMu.Unlock()
}

// sessionArgs names the herdr session the CLI should act on, derived from the
// socket path: named sessions live in <config>/sessions/<name>/herdr.sock, and
// the default one is <config>/herdr.sock with no flag.
func sessionArgs() []string {
	hostMu.RLock()
	socket := hostSocketPath
	hostMu.RUnlock()
	if socket == "" {
		return nil
	}
	dir := filepath.Dir(socket)
	if filepath.Base(dir) != "herdr" && filepath.Base(filepath.Dir(dir)) == "sessions" {
		return []string{"--session", filepath.Base(dir)}
	}
	return nil
}

// SetHerdrBin sets the herdr binary to inspect and run. Empty means "find it"
// on PATH.
func SetHerdrBin(path string) {
	hostMu.Lock()
	hostBinOverride = strings.TrimSpace(path)
	hostMu.Unlock()
}

// SetHostDeps replaces the command runner and the HTTP fetch, for tests. A nil
// dependency restores the real one, which is how a test cleans up.
func SetHostDeps(run func(ctx context.Context, name string, args ...string) ([]byte, error),
	fetch func(ctx context.Context, url string) ([]byte, error)) {
	hostMu.Lock()
	defer hostMu.Unlock()
	if run != nil {
		hostRun = run
	} else {
		hostRun = defaultHostRun
	}
	if fetch != nil {
		hostFetch = fetch
	} else {
		hostFetch = defaultHostFetch
	}
}

// hostDeps is one consistent snapshot: a request must not see the runner from
// one test and the fetcher from the next.
type hostDeps struct {
	run     hostRunner
	fetch   hostFetcher
	resolve func(override string) (string, bool)
	binary  string
}

func currentHostDeps() hostDeps {
	hostMu.RLock()
	defer hostMu.RUnlock()
	return hostDeps{
		run:     hostRun,
		fetch:   hostFetch,
		resolve: hostResolve,
		binary:  hostBinOverride,
	}
}

func (d hostDeps) find() (string, bool) {
	return d.resolve(d.binary)
}

// findHerdrBinary resolves the binary the same way a shell would, then makes
// the path absolute so the reported binary is usable from any working
// directory.
func findHerdrBinary(override string) (string, bool) {
	if override != "" {
		info, err := os.Stat(override)
		return override, err == nil && !info.IsDir()
	}
	found, err := exec.LookPath("herdr")
	if err != nil {
		return "", false
	}
	if absolute, err := filepath.Abs(found); err == nil {
		found = absolute
	}
	return found, true
}

// hostStatus is the GET /api/v1/herdr/host payload. Fields are always present
// except error: the UI binds every one of them, and an empty string is a real
// answer ("no server version"), not a reason to omit a key.
type hostStatus struct {
	Installed         bool   `json:"installed"`
	Binary            string `json:"binary"`
	ClientVersion     string `json:"clientVersion"`
	Channel           string `json:"channel"`
	ServerRunning     bool   `json:"serverRunning"`
	ServerVersion     string `json:"serverVersion"`
	ServerStatus      string `json:"serverStatus"`
	Compatible        bool   `json:"compatible"`
	Socket            string `json:"socket"`
	RestartNeeded     bool   `json:"restartNeeded"`
	ServerBinaryStale bool   `json:"serverBinaryStale"`
	InstallMethod     string `json:"installMethod"`
	LatestVersion     string `json:"latestVersion"`
	UpdateAvailable   bool   `json:"updateAvailable"`
	CanUpdate         bool   `json:"canUpdate"`
	Error             string `json:"error,omitempty"`
}

// herdrStatusOutput mirrors `herdr status --json`. Only the fields the panel
// shows are declared; the command emits more.
type herdrStatusOutput struct {
	Client struct {
		Version string `json:"version"`
		Channel string `json:"channel"`
	} `json:"client"`
	Server struct {
		Status            string `json:"status"`
		Running           bool   `json:"running"`
		Version           string `json:"version"`
		Compatible        bool   `json:"compatible"`
		Socket            string `json:"socket"`
		RestartNeeded     bool   `json:"restart_needed"`
		ServerBinaryStale bool   `json:"server_binary_stale"`
	} `json:"server"`
	Update struct {
		RestartNeeded     bool `json:"restart_needed"`
		ServerBinaryStale bool `json:"server_binary_stale"`
	} `json:"update"`
}

func handleHostStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, "GET")
		return
	}
	writeJSON(w, http.StatusOK, collectHostStatus(r.Context()))
}

// collectHostStatus never fails the request. A missing binary and a dead
// daemon are states this panel exists to describe, so they become fields, not
// HTTP errors.
func collectHostStatus(ctx context.Context) hostStatus {
	deps := currentHostDeps()
	out := hostStatus{InstallMethod: "unknown"}

	binary, found := deps.find()
	if !found {
		// This is the state the panel is most useful in: no herdr yet, and
		// the install button is the whole point.
		out.Error = "herdr is not installed on this machine; install it to use this console"
	} else {
		out.Installed = true
		out.Binary = binary
		out.InstallMethod = installMethodFor(binary)
		// A Nix store path is read-only and owned by Nix: `herdr update`
		// would fight it, so only the two methods whose upgrade command we
		// know are offered.
		out.CanUpdate = out.InstallMethod == "direct" || out.InstallMethod == "homebrew"

		statusCtx, cancel := context.WithTimeout(ctx, hostStatusTimeout)
		raw, err := deps.run(statusCtx, binary, "status", "--json")
		cancel()
		switch {
		case err != nil:
			// The command exits 0 even without a daemon, so a non-zero exit
			// means the CLI itself is unhappy, not that the server is down.
			out.Error = "could not read herdr status: " + err.Error()
		default:
			var parsed herdrStatusOutput
			if err := json.Unmarshal(raw, &parsed); err != nil {
				out.Error = "could not parse herdr status output: " + err.Error()
			} else if parsed.Client.Version == "" && parsed.Server.Status == "" {
				out.Error = "herdr status reported neither a client version nor a server status"
			} else {
				out.ClientVersion = parsed.Client.Version
				out.Channel = parsed.Client.Channel
				out.ServerRunning = parsed.Server.Running
				out.ServerVersion = parsed.Server.Version
				out.ServerStatus = parsed.Server.Status
				out.Compatible = parsed.Server.Compatible
				out.Socket = parsed.Server.Socket
				// The top-level update block repeats the server block; either
				// one saying "yes" means a stale binary is still running.
				out.RestartNeeded = parsed.Update.RestartNeeded || parsed.Server.RestartNeeded
				out.ServerBinaryStale = parsed.Update.ServerBinaryStale || parsed.Server.ServerBinaryStale
			}
		}
	}

	fetchCtx, cancel := context.WithTimeout(ctx, hostLatestTimeout)
	raw, err := deps.fetch(fetchCtx, hostLatestURL)
	cancel()
	switch {
	case err != nil:
		// Offline is normal. Say so only when nothing more important is
		// already wrong, and otherwise keep the rest of the panel usable.
		if out.Error == "" {
			out.Error = "could not check for the latest herdr release: " + err.Error()
		}
	default:
		// The feed is read even when no binary was found: the install button
		// can name the version it would install.
		var latest struct {
			Version string `json:"version"`
		}
		if err := json.Unmarshal(raw, &latest); err != nil || latest.Version == "" {
			if out.Error == "" {
				out.Error = "could not read the latest herdr release metadata"
			}
			break
		}
		out.LatestVersion = latest.Version
		// Nothing installed means nothing to update to; the panel offers
		// install instead.
		out.UpdateAvailable = out.Installed && out.ClientVersion != "" &&
			newerVersion(latest.Version, out.ClientVersion)
	}
	return out
}

// installMethodFor classifies the binary by the directory that owns it:
// Homebrew's three roots, or the Nix store. Anything else — including
// ~/.local/bin, where the official installer puts a direct download — is a
// direct install.
//
// Symlinks are resolved first because the path herdr reports is the one it was
// invoked as: brew links /usr/local/bin/herdr into /usr/local/Cellar, and a Nix
// profile links into /nix/store. Without resolution both would look "direct",
// and `herdr update` would overwrite a package-managed binary.
func installMethodFor(binary string) string {
	path := filepath.ToSlash(strings.TrimSpace(binary))
	if path == "" {
		return "unknown"
	}
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		path = filepath.ToSlash(resolved)
	}
	switch {
	case underDir(path, "/opt/homebrew/"),
		underDir(path, "/usr/local/Cellar/"),
		underDir(path, "/home/linuxbrew/"):
		return "homebrew"
	case underDir(path, "/nix/store/"):
		return "nix"
	default:
		return "direct"
	}
}

// underDir is a path-prefix test that cannot treat /opt/homebrewed as
// Homebrew.
func underDir(path, dir string) bool {
	return path == strings.TrimSuffix(dir, "/") || strings.HasPrefix(path, dir)
}

// versionParts returns the leading numeric dotted parts of a version and stops
// at the first suffix. "0.9.5-preview.1" is 0,9,5, so a preview of the release
// that is installed does not read as newer.
func versionParts(version string) []int {
	version = strings.TrimPrefix(strings.TrimSpace(version), "v")
	var parts []int
	for _, field := range strings.Split(version, ".") {
		digits := field
		for index := 0; index < len(field); index++ {
			if field[index] < '0' || field[index] > '9' {
				digits = field[:index]
				break
			}
		}
		if digits == "" {
			break
		}
		part, err := strconv.Atoi(digits)
		if err != nil {
			break
		}
		parts = append(parts, part)
		if len(digits) != len(field) {
			break
		}
	}
	return parts
}

// newerVersion compares numerically per dotted part. 0.10 is newer than 0.9,
// which a string comparison gets wrong. Suffixes are dropped rather than
// ordered: preview and stable builds of the same numbers are the same release
// line, and claiming an update there would nag a preview user forever.
func newerVersion(latest, installed string) bool {
	latestParts := versionParts(latest)
	installedParts := versionParts(installed)
	if len(latestParts) == 0 || len(installedParts) == 0 {
		return false
	}
	for index := 0; index < len(latestParts) || index < len(installedParts); index++ {
		latestPart, installedPart := 0, 0
		if index < len(latestParts) {
			latestPart = latestParts[index]
		}
		if index < len(installedParts) {
			installedPart = installedParts[index]
		}
		if latestPart != installedPart {
			return latestPart > installedPart
		}
	}
	return false
}

// hostCommandResult is the body of both POSTs. A failed command is still a
// successful report: the console shows the output either way.
type hostCommandResult struct {
	OK       bool   `json:"ok"`
	Command  string `json:"command"`
	Output   string `json:"output"`
	ExitCode int    `json:"exitCode"`
}

// hostExitError carries a process exit code through the runner interface.
type hostExitError struct {
	code int
	err  error
}

func (e *hostExitError) Error() string {
	if e.err != nil {
		return e.err.Error()
	}
	return fmt.Sprintf("exit status %d", e.code)
}

func (e *hostExitError) Unwrap() error {
	return e.err
}

func defaultHostRun(ctx context.Context, name string, args ...string) ([]byte, error) {
	command := exec.CommandContext(ctx, name, args...)
	output, err := command.CombinedOutput()
	if err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return output, &hostExitError{code: exit.ExitCode(), err: err}
		}
		return output, err
	}
	return output, nil
}

func defaultHostFetch(ctx context.Context, url string) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	// Some feeds reject requests without a user agent.
	request.Header.Set("User-Agent", "herdr-web")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s answered %s", url, response.Status)
	}
	return io.ReadAll(io.LimitReader(response.Body, hostFetchLimit))
}

func handleHostUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, "POST")
		return
	}
	deps := currentHostDeps()
	binary, found := deps.find()
	if !found {
		writeError(w, http.StatusConflict, "herdr_update_unavailable",
			"herdr is not installed on this machine")
		return
	}
	method := installMethodFor(binary)
	var display, name string
	var args []string
	switch method {
	case "direct":
		// A fixed argv, never a shell string: no request data can reach this.
		display, name, args = "herdr update", binary, append(sessionArgs(), "update")
	case "homebrew":
		display, name, args = "brew upgrade herdr", "brew", []string{"upgrade", "herdr"}
	default:
		writeError(w, http.StatusConflict, "herdr_update_unavailable",
			fmt.Sprintf("herdr is managed by %s; update it with %s instead of herdr update",
				method, method))
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), hostCommandTimeout)
	defer cancel()

	// An update on a server from before endpoint generation 1 needs one final
	// stop, and the console is talking to that server: stopping first is what
	// makes the update finish, and starting again is what makes the console
	// connect afterwards. Leaving the daemon down after an update is what the
	// operator reported on a deployed host.
	steps := make([]hostStep, 0, 3)
	stopped := false
	if probe, ok := probeHerdrStatus(ctx, deps, binary); ok && probe.Server.Running {
		stop := stopHostDaemon(ctx, deps, binary)
		steps = append(steps, stop)
		stopped = stop.OK
	} else {
		steps = append(steps, hostStep{Step: "stop", Command: "herdr server stop",
			OK: true, Skipped: "no daemon was running"})
	}

	update := runHostStep(ctx, deps, "update", display, name, args...)
	steps = append(steps, update)

	// A failed update leaves the binary as it was, so starting the old one again
	// keeps the console usable instead of leaving nothing to talk to.
	steps = append(steps, startHostDaemon(ctx, deps, binary))
	_ = stopped
	writeHostSteps(w, display, steps)
}

func handleHostInstall(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, "POST")
		return
	}
	deps := currentHostDeps()
	if binary, found := deps.find(); found {
		writeError(w, http.StatusConflict, "herdr_already_installed",
			fmt.Sprintf("herdr is already installed at %s", binary))
		return
	}
	var body struct {
		From string `json:"from"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&body)

	// A machine that cannot reach herdr.dev installs from a relay instead: any
	// console serves herdr's binary at /release once it has been seeded there.
	sources := []string{}
	if from := strings.TrimSpace(body.From); from != "" {
		sources = append(sources, strings.TrimRight(from, "/"))
	} else {
		for _, candidate := range selfCandidates(r.Context(), "") {
			if candidate.Source != selfOfficialSource {
				sources = append(sources, candidate.Source)
			}
		}
	}
	for _, source := range sources {
		if installed, err := installHerdrFromRelay(r.Context(), source); err == nil && installed {
			writeJSON(w, http.StatusOK, hostCommandResult{
				OK:      true,
				Command: "install herdr from " + source,
				Output:  "installed herdr from " + source + "\n",
			})
			return
		}
	}

	// The documented Linux/macOS installer. Its URL and the whole pipeline are
	// compile-time constants, so nothing from the request is involved.
	runHostCommand(w, r, deps, hostInstallDisplay, "sh", "-c", hostInstallCommand)
}

// installHerdrFromRelay downloads herdr's own binary from a console that serves
// it, and refuses anything that does not match its published checksum.
func installHerdrFromRelay(ctx context.Context, source string) (bool, error) {
	asset := "herdr-" + runtime.GOOS + "-" + runtime.GOARCH
	ctx, cancel := context.WithTimeout(ctx, hostCommandTimeout)
	defer cancel()

	sum, err := selfFetchText(ctx, source+"/"+asset+".sha256")
	if err != nil {
		return false, err
	}
	want := strings.Fields(sum)
	if len(want) == 0 {
		return false, errors.New("no checksum published")
	}
	dir, err := os.UserHomeDir()
	if err != nil {
		return false, err
	}
	binDir := filepath.Join(dir, ".local", "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		return false, err
	}
	tmp, err := os.CreateTemp(binDir, ".herdr-incoming-*")
	if err != nil {
		return false, err
	}
	tmpPath := tmp.Name()
	defer func() { _ = os.Remove(tmpPath) }()
	if err := selfDownload(ctx, source+"/"+asset, tmp); err != nil {
		_ = tmp.Close()
		return false, err
	}
	if err := tmp.Close(); err != nil {
		return false, err
	}
	got, err := fileSHA256(tmpPath)
	if err != nil {
		return false, err
	}
	if !strings.EqualFold(got, want[0]) {
		return false, errors.New("the relayed binary did not match its checksum")
	}
	if err := os.Chmod(tmpPath, 0o755); err != nil {
		return false, err
	}
	target := filepath.Join(binDir, "herdr")
	if err := os.Rename(tmpPath, target); err != nil {
		return false, err
	}
	return true, nil
}

// runHostCommand runs one fixed command and always answers 200 when it ran at
// all, because a failed update is information the console must display. Only a
// command that could not be started at all is a gateway error.
func runHostCommand(w http.ResponseWriter, r *http.Request, deps hostDeps, display, name string, args ...string) {
	ctx, cancel := context.WithTimeout(r.Context(), hostCommandTimeout)
	defer cancel()

	output, err := deps.run(ctx, name, args...)
	if err == nil {
		writeJSON(w, http.StatusOK, hostCommandResult{
			OK:       true,
			Command:  display,
			Output:   string(output),
			ExitCode: 0,
		})
		return
	}

	// exec.CommandContext kills the process on deadline, which surfaces as an
	// exit signal rather than a context error, so check both.
	if errors.Is(err, context.DeadlineExceeded) || ctx.Err() == context.DeadlineExceeded {
		message := "command timed out after " + hostCommandTimeout.String()
		text := strings.TrimSpace(string(output))
		if text != "" {
			text += "\n" + message
		} else {
			text = message
		}
		// 124 is what timeout(1) uses for the same outcome.
		writeJSON(w, http.StatusOK, hostCommandResult{
			Command:  display,
			Output:   text,
			ExitCode: 124,
		})
		return
	}

	if code, ok := hostExitCode(err); ok {
		writeJSON(w, http.StatusOK, hostCommandResult{
			OK:       false,
			Command:  display,
			Output:   string(output),
			ExitCode: code,
		})
		return
	}
	writeBadGateway(w, "herdr_command_failed", err)
}

func hostExitCode(err error) (int, bool) {
	var exit *hostExitError
	if errors.As(err, &exit) {
		return exit.code, true
	}
	var process *exec.ExitError
	if errors.As(err, &process) {
		return process.ExitCode(), true
	}
	return 0, false
}

// hostStep is one command of a stop-update-start sequence. The panel shows each
// step, because "herdr update" on an old server is several operations and the
// operator needs to see which one failed.
type hostStep struct {
	Step     string `json:"step"`
	Command  string `json:"command"`
	OK       bool   `json:"ok"`
	Output   string `json:"output"`
	ExitCode int    `json:"exitCode"`
	Skipped  string `json:"skipped,omitempty"`
}

// herdrStatusProbe is the part of `herdr status --json` a restart decision needs.
type herdrStatusProbe struct {
	Client struct {
		Version string `json:"version"`
	} `json:"client"`
	Server struct {
		Running bool   `json:"running"`
		Version string `json:"version"`
	} `json:"server"`
}

func probeHerdrStatus(ctx context.Context, deps hostDeps, binary string) (herdrStatusProbe, bool) {
	ctx, cancel := context.WithTimeout(ctx, hostStatusTimeout)
	defer cancel()
	raw, err := deps.run(ctx, binary, append(sessionArgs(), "status", "--json")...)
	if err != nil {
		return herdrStatusProbe{}, false
	}
	var probe herdrStatusProbe
	if err := json.Unmarshal(raw, &probe); err != nil {
		return herdrStatusProbe{}, false
	}
	return probe, true
}

// runHostStep runs one fixed command and reports it as a step.
func runHostStep(ctx context.Context, deps hostDeps, step, display, name string, args ...string) hostStep {
	out := hostStep{Step: step, Command: display}
	output, err := deps.run(ctx, name, args...)
	out.Output = string(output)
	if err == nil {
		out.OK = true
		return out
	}
	// exec.CommandContext kills the process on deadline, which surfaces as an
	// exit signal rather than a context error, so check both. 124 is what
	// timeout(1) uses for the same outcome.
	if errors.Is(err, context.DeadlineExceeded) || ctx.Err() == context.DeadlineExceeded {
		message := "command timed out after " + hostCommandTimeout.String()
		if text := strings.TrimSpace(out.Output); text != "" {
			out.Output = text + "\n" + message
		} else {
			out.Output = message
		}
		out.ExitCode = 124
		return out
	}
	if code, ok := hostExitCode(err); ok {
		out.ExitCode = code
		return out
	}
	out.Output = strings.TrimSpace(out.Output + "\n" + err.Error())
	out.ExitCode = -1
	return out
}

// stopHostDaemon stops the running server. It ends the panes in it, which is
// why it only ever runs as part of a sequence the operator asked for.
func stopHostDaemon(ctx context.Context, deps hostDeps, binary string) hostStep {
	return runHostStep(ctx, deps, "stop", displayWithSession("herdr server stop"),
		binary, append(sessionArgs(), "server", "stop")...)
}

// startHostDaemon starts herdr in a detached tmux session and waits until the
// daemon answers. herdr cannot be started without a terminal: measured here,
// running it with no tty reports "cannot attach without a usable terminal".
func startHostDaemon(ctx context.Context, deps hostDeps, binary string) hostStep {
	// herdr runs its own server without a terminal: `herdr server` is a headless
	// daemon (measured: it answers "herdr server running" with no tty). Wrapping
	// it in tmux, as this used to do, was one multiplexer hosting another.
	command := displayWithSession(binary + " server")
	out := hostStep{Step: "start", Command: command}

	args := append(sessionArgs(), "server")
	if err := hostSpawnDetached(binary, args); err != nil {
		out.Output = strings.TrimSpace(out.Output + "\n" + err.Error())
		out.ExitCode = -1
		return out
	}

	deadline := time.Now().Add(hostStartTimeout)
	for time.Now().Before(deadline) {
		if probe, ok := probeHerdrStatus(ctx, deps, binary); ok && probe.Server.Running {
			out.OK = true
			out.Output = strings.TrimSpace(out.Output + "\ndaemon is running " + probe.Server.Version)
			return out
		}
		select {
		case <-ctx.Done():
			out.ExitCode = -1
			return out
		case <-time.After(300 * time.Millisecond):
		}
	}
	out.Output = strings.TrimSpace(out.Output + "\nherdr did not answer after " +
		hostStartTimeout.String() + "; its log is in the herdr config directory")
	out.ExitCode = -1
	return out
}

// spawnDetached starts herdr's headless server and does not wait for it: the
// server runs until it is stopped, and this console keeps answering meanwhile.
// A new session (setsid) keeps it alive after this process would have exited.
func spawnDetached(binary string, args []string) error {
	command := exec.Command(binary, args...)
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	dir, err := os.UserConfigDir()
	if err == nil {
		command.Dir = filepath.Join(dir, "herdr")
	}
	if err := command.Start(); err != nil {
		return fmt.Errorf("could not start %s: %w", binary, err)
	}
	// The child is not waited for: this process must not reap it, and its goal
	// is to outlive this request.
	_ = command.Process.Release()
	return nil
}

// hostStepResponse is what the panel renders for a sequence.
type hostStepResponse struct {
	OK       bool       `json:"ok"`
	Command  string     `json:"command"`
	Output   string     `json:"output"`
	ExitCode int        `json:"exitCode"`
	Steps    []hostStep `json:"steps"`
}

func writeHostSteps(w http.ResponseWriter, display string, steps []hostStep) {
	ok := true
	exitCode := 0
	lines := make([]string, 0, len(steps))
	for _, step := range steps {
		lines = append(lines, step.Command)
		if step.Skipped != "" {
			lines = append(lines, "  skipped: "+step.Skipped)
		}
		if text := strings.TrimSpace(step.Output); text != "" {
			for _, line := range strings.Split(text, "\n") {
				lines = append(lines, "  "+line)
			}
		}
		if !step.OK {
			ok = false
			if step.ExitCode != 0 {
				exitCode = step.ExitCode
			}
		}
	}
	writeJSON(w, http.StatusOK, hostStepResponse{
		OK:       ok,
		Command:  display,
		Output:   strings.Join(lines, "\n"),
		ExitCode: exitCode,
		Steps:    steps,
	})
}

// handleHostRestart stops the daemon and starts it again. The console talks to
// that daemon, so a restart it performs has to leave something answering.
func handleHostRestart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, "POST")
		return
	}
	deps := currentHostDeps()
	binary, found := deps.find()
	if !found {
		writeError(w, http.StatusConflict, "herdr_restart_unavailable",
			"herdr is not installed on this machine")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), hostCommandTimeout)
	defer cancel()

	steps := make([]hostStep, 0, 2)
	if probe, ok := probeHerdrStatus(ctx, deps, binary); ok && probe.Server.Running {
		steps = append(steps, stopHostDaemon(ctx, deps, binary))
	} else {
		steps = append(steps, hostStep{Step: "stop", Command: "herdr server stop",
			OK: true, Skipped: "no daemon was running"})
	}
	steps = append(steps, startHostDaemon(ctx, deps, binary))
	writeHostSteps(w, "herdr server stop && start", steps)
}

// displayWithSession is how a command is shown in the panel: the session flag
// is part of what ran, so it is part of what the operator reads.
func displayWithSession(base string) string {
	if args := sessionArgs(); len(args) == 2 {
		return base + " " + args[0] + " " + args[1]
	}
	return base
}
