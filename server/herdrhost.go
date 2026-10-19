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
	"strconv"
	"strings"
	"sync"
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
	// hostResolve is a seam for tests: they cannot create /opt/homebrew or
	// /nix/store, so the machine lookup itself is replaceable. Production
	// always uses findHerdrBinary.
	hostResolve = findHerdrBinary
)

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
	switch method := installMethodFor(binary); method {
	case "direct":
		// A fixed argv, never a shell string: no request data can reach this.
		runHostCommand(w, r, deps, "herdr update", binary, "update")
	case "homebrew":
		runHostCommand(w, r, deps, "brew upgrade herdr", "brew", "upgrade", "herdr")
	default:
		writeError(w, http.StatusConflict, "herdr_update_unavailable",
			fmt.Sprintf("herdr is managed by %s; update it with %s instead of herdr update",
				method, method))
	}
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
	// The documented Linux/macOS installer. Its URL and the whole pipeline are
	// compile-time constants, so nothing from the request is involved; the
	// body is deliberately ignored rather than parsed.
	runHostCommand(w, r, deps, hostInstallDisplay, "sh", "-c", hostInstallCommand)
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
