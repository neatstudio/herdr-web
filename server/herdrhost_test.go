package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// A started daemon is waited for in production; the tests must not sit through
// that budget, and they never run a real daemon.
func init() {
	hostStartTimeout = 400 * time.Millisecond
	// The start step launches herdr's headless server; a test records the call
	// and lets the fake status probe answer instead.
	hostSpawnDetached = func(string, []string) error { return nil }
}

// liveHerdrStatus is `herdr status --json` captured verbatim from this machine,
// so the parser is exercised against the real shape rather than a guess. The
// two client/server versions are the only field the version tests rewrite.
const liveHerdrStatus = `{"client":{"version":"0.9.0","channel":"stable","protocol":22,"endpoint_protocol_generation":1,"endpoint_capabilities":["surface_interest","presentation_effects_fence","health_check"],"binary":"/home/op/.local/bin/herdr","session":null},"server":{"status":"running","running":true,"version":"0.9.0","protocol":22,"capabilities":{"live_handoff":true,"detached_server_daemon":true,"endpoint_protocol_generation":1,"surface_interest":true,"health_check":true},"compatible":true,"endpoint_compatible":true,"socket":"/home/op/.config/herdr/herdr.sock","session":null,"restart_needed":false,"server_binary_stale":false},"update":{"restart_needed":false,"server_binary_stale":false}}`

// writeFakeHerdrBinary creates a file that stands in for the herdr executable.
// The handlers only need a path that exists; the runner is faked, so its
// contents never run.
func writeFakeHerdrBinary(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "herdr")
	if err := os.WriteFile(path, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatalf("write fake herdr: %v", err)
	}
	return path
}

// stubHostResolver makes the machine look like it has (or lacks) a herdr at
// binary. A test cannot create /opt/homebrew or /nix/store, and must not depend
// on whatever herdr the developer really has installed.
func stubHostResolver(t *testing.T, binary string, found bool) {
	t.Helper()
	hostMu.Lock()
	previous := hostResolve
	hostResolve = func(string) (string, bool) { return binary, found }
	hostMu.Unlock()
	t.Cleanup(func() {
		hostMu.Lock()
		hostResolve = previous
		hostMu.Unlock()
	})
}

// requestHostStatusForVersion answers one status request with a chosen
// installed version and feed version.
func requestHostStatusForVersion(t *testing.T, clientVersion, latestVersion string) map[string]any {
	t.Helper()
	binary := writeFakeHerdrBinary(t)
	SetHerdrBin(binary)
	SetHostDeps(func(context.Context, string, ...string) ([]byte, error) {
		status := strings.ReplaceAll(liveHerdrStatus,
			`"version":"0.9.0"`, `"version":"`+clientVersion+`"`)
		return []byte(status), nil
	}, func(context.Context, string) ([]byte, error) {
		return []byte(`{"version":"` + latestVersion + `","protocol":22}`), nil
	})
	t.Cleanup(func() {
		SetHostDeps(nil, nil)
		SetHerdrBin("")
	})
	response := do(t, http.HandlerFunc(handleHostStatus), http.MethodGet, "/api/v1/herdr/host", "")
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	return decodeMap(t, response)
}

func TestHostStatusReportsAnInstalledRunningHerdr(t *testing.T) {
	binary := writeFakeHerdrBinary(t)
	SetHerdrBin(binary)
	defer SetHerdrBin("")

	SetHostDeps(func(_ context.Context, name string, args ...string) ([]byte, error) {
		if name != binary {
			t.Fatalf("runner name=%q want %q", name, binary)
		}
		if len(args) != 2 || args[0] != "status" || args[1] != "--json" {
			t.Fatalf("runner args=%q", args)
		}
		return []byte(liveHerdrStatus), nil
	}, func(_ context.Context, url string) ([]byte, error) {
		if url != hostLatestURL {
			t.Fatalf("fetch url=%q", url)
		}
		return []byte(`{"version":"0.9.5","protocol":22,"endpoint_generation":1}`), nil
	})
	defer SetHostDeps(nil, nil)

	response := do(t, http.HandlerFunc(handleHostStatus), http.MethodGet, "/api/v1/herdr/host", "")
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	body := decodeMap(t, response)
	for key, want := range map[string]any{
		"installed":         true,
		"binary":            binary,
		"clientVersion":     "0.9.0",
		"channel":           "stable",
		"serverRunning":     true,
		"serverVersion":     "0.9.0",
		"serverStatus":      "running",
		"compatible":        true,
		"socket":            "/home/op/.config/herdr/herdr.sock",
		"restartNeeded":     false,
		"serverBinaryStale": false,
		"installMethod":     "direct",
		"latestVersion":     "0.9.5",
		"updateAvailable":   true,
		"canUpdate":         true,
	} {
		if body[key] != want {
			t.Fatalf("body[%s]=%v want %v (body=%s)", key, body[key], want, response.Body.String())
		}
	}
	if _, present := body["error"]; present {
		t.Fatalf("a healthy host must omit error, body=%s", response.Body.String())
	}
}

func TestHostStatusStillAnswersWhenHerdrIsMissing(t *testing.T) {
	// This is the state the panel exists for: no binary at all. It must be a
	// 200 with fields, not an HTTP error, or the UI cannot render the install
	// button.
	stubHostResolver(t, "", false)
	fetched := false
	SetHostDeps(func(context.Context, string, ...string) ([]byte, error) {
		t.Fatal("status must not run when the binary is missing")
		return nil, nil
	}, func(_ context.Context, url string) ([]byte, error) {
		fetched = true
		return []byte(`{"version":"0.9.5"}`), nil
	})
	defer SetHostDeps(nil, nil)

	response := do(t, http.HandlerFunc(handleHostStatus), http.MethodGet, "/api/v1/herdr/host", "")
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	body := decodeMap(t, response)
	if body["installed"] != false || body["binary"] != "" {
		t.Fatalf("installed=%v binary=%v", body["installed"], body["binary"])
	}
	if body["installMethod"] != "unknown" {
		t.Fatalf("installMethod=%v", body["installMethod"])
	}
	if body["canUpdate"] != false || body["updateAvailable"] != false {
		t.Fatalf("canUpdate=%v updateAvailable=%v", body["canUpdate"], body["updateAvailable"])
	}
	// The feed is still read: the install button can name the version it will
	// install, even though there is nothing to update yet.
	if !fetched || body["latestVersion"] != "0.9.5" {
		t.Fatalf("fetched=%v latestVersion=%v", fetched, body["latestVersion"])
	}
	message, _ := body["error"].(string)
	if !strings.Contains(message, "not installed") {
		t.Fatalf("error=%q", message)
	}
}

func TestHostStatusFlagsANewerRelease(t *testing.T) {
	body := requestHostStatusForVersion(t, "0.9.0", "0.9.5")
	if body["updateAvailable"] != true {
		t.Fatalf("updateAvailable=%v", body["updateAvailable"])
	}
}

func TestHostStatusTreatsEqualVersionsAsUpToDate(t *testing.T) {
	body := requestHostStatusForVersion(t, "0.9.5", "0.9.5")
	if body["updateAvailable"] != false {
		t.Fatalf("updateAvailable=%v", body["updateAvailable"])
	}
}

func TestHostStatusDoesNotCallAPreviewNewerThanItsRelease(t *testing.T) {
	// Same numbers, only a suffix differs: a preview user must not be nagged
	// about an "update" to the release line they already track.
	body := requestHostStatusForVersion(t, "0.9.5", "0.9.5-preview.1")
	if body["updateAvailable"] != false {
		t.Fatalf("updateAvailable=%v latest=%v", body["updateAvailable"], body["latestVersion"])
	}
}

func TestHostStatusComparesVersionPartsNumerically(t *testing.T) {
	body := requestHostStatusForVersion(t, "0.9.5", "0.10.0")
	if body["updateAvailable"] != true {
		t.Fatalf("0.10.0 must be newer than 0.9.5: %v", body["updateAvailable"])
	}
}

func TestHostStatusSurvivesAFailedLatestFetch(t *testing.T) {
	binary := writeFakeHerdrBinary(t)
	SetHerdrBin(binary)
	defer SetHerdrBin("")
	SetHostDeps(func(context.Context, string, ...string) ([]byte, error) {
		return []byte(liveHerdrStatus), nil
	}, func(context.Context, string) ([]byte, error) {
		return nil, errors.New("dial tcp: no route to host")
	})
	defer SetHostDeps(nil, nil)

	body := decodeMap(t, do(t, http.HandlerFunc(handleHostStatus), http.MethodGet, "/api/v1/herdr/host", ""))
	// Offline is not a broken panel: everything the local binary told us stays.
	if body["installed"] != true || body["clientVersion"] != "0.9.0" || body["serverRunning"] != true {
		t.Fatalf("local state lost: %v", body)
	}
	if body["canUpdate"] != true {
		t.Fatalf("canUpdate=%v", body["canUpdate"])
	}
	if body["latestVersion"] != "" || body["updateAvailable"] != false {
		t.Fatalf("latestVersion=%v updateAvailable=%v", body["latestVersion"], body["updateAvailable"])
	}
	message, _ := body["error"].(string)
	if !strings.Contains(message, "latest") {
		t.Fatalf("error=%q", message)
	}
}

func TestInstallMethodFollowsTheBinaryLocation(t *testing.T) {
	if got := installMethodFor("/opt/homebrew/bin/herdr"); got != "homebrew" {
		t.Fatalf("opt/homebrew=%q", got)
	}
	if got := installMethodFor("/usr/local/Cellar/herdr/0.9.5/bin/herdr"); got != "homebrew" {
		t.Fatalf("Cellar=%q", got)
	}
	if got := installMethodFor("/home/linuxbrew/.linuxbrew/bin/herdr"); got != "homebrew" {
		t.Fatalf("linuxbrew=%q", got)
	}
	if got := installMethodFor("/nix/store/2f3-herdr-0.9.5/bin/herdr"); got != "nix" {
		t.Fatalf("nix store=%q", got)
	}
	// A direct install is the official installer's default location.
	if got := installMethodFor("/Users/example/.local/bin/herdr"); got != "direct" {
		t.Fatalf("local bin=%q", got)
	}
}

func TestHostUpdateRefusesANixInstall(t *testing.T) {
	stubHostResolver(t, "/nix/store/2f3-herdr-0.9.5/bin/herdr", true)
	ran := false
	SetHostDeps(func(context.Context, string, ...string) ([]byte, error) {
		ran = true
		return nil, nil
	}, nil)
	defer SetHostDeps(nil, nil)

	response := do(t, http.HandlerFunc(handleHostUpdate), http.MethodPost, "/api/v1/herdr/host/update", "")
	if response.Code != http.StatusConflict {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if ran {
		t.Fatal("herdr update must not run against a nix-managed binary")
	}
	body := decodeMap(t, response)
	errorBody, _ := body["error"].(map[string]any)
	message, _ := errorBody["message"].(string)
	if !strings.Contains(message, "nix") {
		t.Fatalf("message=%q", message)
	}
}

func TestHostUpdateRunsHerdrUpdateForADirectInstall(t *testing.T) {
	binary := writeFakeHerdrBinary(t)
	SetHerdrBin(binary)
	defer SetHerdrBin("")
	var ran []string
	SetHostDeps(func(_ context.Context, name string, args ...string) ([]byte, error) {
		ran = append(ran, strings.Join(append([]string{name}, args...), " "))
		return []byte("updated herdr to 0.9.5\n"), nil
	}, nil)
	defer SetHostDeps(nil, nil)

	response := do(t, http.HandlerFunc(handleHostUpdate), http.MethodPost, "/api/v1/herdr/host/update", "")
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	body := decodeMap(t, response)
	if body["command"] != "herdr update" {
		t.Fatalf("body=%v", body)
	}
	update := hostStepByName(t, body, "update")
	if update["ok"] != true || update["command"] != "herdr update" ||
		update["output"] != "updated herdr to 0.9.5\n" || update["exitCode"] != float64(0) {
		t.Fatalf("update step=%v", update)
	}
	// The binary itself runs `update`, with no shell in between.
	if !strings.Contains(strings.Join(ran, "\n"), binary+" update") {
		t.Fatalf("herdr update was never run:\n%s", strings.Join(ran, "\n"))
	}
	// The daemon is started afterwards, or the console has nothing to talk to.
	if hostStepByName(t, body, "start")["step"] != "start" {
		t.Fatalf("body=%v", body)
	}
}

func TestHostUpdateRunsBrewForAHomebrewInstall(t *testing.T) {
	stubHostResolver(t, "/opt/homebrew/bin/herdr", true)
	var ran []string
	SetHostDeps(func(_ context.Context, name string, args ...string) ([]byte, error) {
		ran = append(ran, strings.Join(append([]string{name}, args...), " "))
		return []byte("==> Upgrading herdr\n"), nil
	}, nil)
	defer SetHostDeps(nil, nil)

	response := do(t, http.HandlerFunc(handleHostUpdate), http.MethodPost, "/api/v1/herdr/host/update", "")
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	body := decodeMap(t, response)
	if body["command"] != "brew upgrade herdr" {
		t.Fatalf("body=%v", body)
	}
	update := hostStepByName(t, body, "update")
	if update["ok"] != true || update["command"] != "brew upgrade herdr" {
		t.Fatalf("update step=%v", update)
	}
	// The package manager is the updater for a Homebrew copy; herdr update would
	// fight it over the same binary.
	if !strings.Contains(strings.Join(ran, "\n"), "brew upgrade herdr") {
		t.Fatalf("brew was never asked to upgrade:\n%s", strings.Join(ran, "\n"))
	}
}

func TestHostUpdateReportsANonZeroExitWithoutFailingTheRequest(t *testing.T) {
	// A failed update is a result the console must show, not a gateway error:
	// the output is the whole point of the request.
	binary := writeFakeHerdrBinary(t)
	SetHerdrBin(binary)
	defer SetHerdrBin("")
	SetHostDeps(func(context.Context, string, ...string) ([]byte, error) {
		return []byte("error: could not replace binary: permission denied\n"),
			&hostExitError{code: 2, err: errors.New("exit status 2")}
	}, nil)
	defer SetHostDeps(nil, nil)

	response := do(t, http.HandlerFunc(handleHostUpdate), http.MethodPost, "/api/v1/herdr/host/update", "")
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	body := decodeMap(t, response)
	if body["ok"] != false {
		t.Fatalf("body=%v", body)
	}
	update := hostStepByName(t, body, "update")
	if update["exitCode"] != float64(2) {
		t.Fatalf("update step=%v", update)
	}
	if update["output"] != "error: could not replace binary: permission denied\n" {
		t.Fatalf("output=%v", update["output"])
	}
	// The old binary is still on disk, so the daemon is started again: leaving
	// nothing running is worse than leaving the old version running.
	if started := hostStepByName(t, body, "start"); started["step"] != "start" {
		t.Fatalf("body=%v", body)
	}
}

func TestHostUpdateReportsATimeoutOnTheUpdateStep(t *testing.T) {
	binary := writeFakeHerdrBinary(t)
	SetHerdrBin(binary)
	defer SetHerdrBin("")
	// The status probe answers first, so the sequence gets as far as the update.
	SetHostDeps(func(_ context.Context, name string, args ...string) ([]byte, error) {
		if strings.HasSuffix(strings.Join(args, " "), "status --json") {
			return []byte(`{"server":{"running":true,"version":"0.9.0"}}`), nil
		}
		return nil, context.DeadlineExceeded
	}, nil)
	defer SetHostDeps(nil, nil)

	response := do(t, http.HandlerFunc(handleHostUpdate), http.MethodPost, "/api/v1/herdr/host/update", "")
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	body := decodeMap(t, response)
	if body["ok"] != false {
		t.Fatalf("body=%v", body)
	}
	update := hostStepByName(t, body, "update")
	if update["exitCode"] != float64(124) {
		t.Fatalf("update step=%v, want exit 124", update)
	}
	output, _ := update["output"].(string)
	if !strings.Contains(output, "timed out") {
		t.Fatalf("output=%q", output)
	}
}

func TestHostUpdateReportsAnUnrunnableCommandInItsStep(t *testing.T) {
	binary := writeFakeHerdrBinary(t)
	SetHerdrBin(binary)
	defer SetHerdrBin("")
	SetHostDeps(func(context.Context, string, ...string) ([]byte, error) {
		return nil, errors.New(`exec: "herdr": executable file not found in $PATH`)
	}, nil)
	defer SetHostDeps(nil, nil)

	// A sequence answers 200 with its steps: which command could not start is
	// information for the operator, and the panel shows it next to the others.
	response := do(t, http.HandlerFunc(handleHostUpdate), http.MethodPost, "/api/v1/herdr/host/update", "")
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	body := decodeMap(t, response)
	if body["ok"] != false {
		t.Fatalf("body=%v", body)
	}
	update := hostStepByName(t, body, "update")
	if output, _ := update["output"].(string); !strings.Contains(output, "executable file not found") {
		t.Fatalf("update step=%v", update)
	}
}

// hostStepByName reads one step out of a sequence response.
func hostStepByName(t *testing.T, body map[string]any, name string) map[string]any {
	t.Helper()
	steps, _ := body["steps"].([]any)
	for _, raw := range steps {
		step, _ := raw.(map[string]any)
		if step["step"] == name {
			return step
		}
	}
	t.Fatalf("no %q step in %v", name, body["steps"])
	return nil
}

func TestHostInstallRefusesWhenHerdrIsAlreadyInstalled(t *testing.T) {
	binary := writeFakeHerdrBinary(t)
	SetHerdrBin(binary)
	defer SetHerdrBin("")
	ran := false
	SetHostDeps(func(context.Context, string, ...string) ([]byte, error) {
		ran = true
		return nil, nil
	}, nil)
	defer SetHostDeps(nil, nil)

	response := do(t, http.HandlerFunc(handleHostInstall), http.MethodPost, "/api/v1/herdr/host/install", "")
	if response.Code != http.StatusConflict {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if ran {
		t.Fatal("the installer must not run over an existing binary")
	}
	body := decodeMap(t, response)
	errorBody, _ := body["error"].(map[string]any)
	message, _ := errorBody["message"].(string)
	if !strings.Contains(message, binary) {
		t.Fatalf("message=%q must name %q", message, binary)
	}
}

func TestHostInstallRunsTheOfficialInstaller(t *testing.T) {
	stubHostResolver(t, "", false)
	const pipeline = `curl -fsSL https://herdr.dev/install.sh | sh`
	if hostInstallCommand != pipeline {
		t.Fatalf("install pipeline=%q want %q", hostInstallCommand, pipeline)
	}
	var gotName string
	var gotArgs []string
	SetHostDeps(func(_ context.Context, name string, args ...string) ([]byte, error) {
		gotName, gotArgs = name, append([]string(nil), args...)
		return []byte("installed herdr 0.9.5\n"), nil
	}, nil)
	defer SetHostDeps(nil, nil)

	// The body is ignored on purpose: the installer takes no input, and
	// nothing from a request may reach the shell string.
	response := do(t, http.HandlerFunc(handleHostInstall), http.MethodPost,
		"/api/v1/herdr/host/install", `{"unexpected":true}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	body := decodeMap(t, response)
	if body["ok"] != true || body["command"] != `sh -c "`+pipeline+`"` || body["output"] != "installed herdr 0.9.5\n" || body["exitCode"] != float64(0) {
		t.Fatalf("body=%v", body)
	}
	if gotName != "sh" {
		t.Fatalf("runner name=%q", gotName)
	}
	if len(gotArgs) != 2 || gotArgs[0] != "-c" || gotArgs[1] != pipeline {
		t.Fatalf("runner args=%q", gotArgs)
	}
}

func TestHostHandlersRejectTheWrongMethod(t *testing.T) {
	if got := do(t, http.HandlerFunc(handleHostStatus), http.MethodPost, "/api/v1/herdr/host", ""); got.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST status=%d", got.Code)
	} else if got.Header().Get("Allow") != "GET" {
		t.Fatalf("Allow=%q", got.Header().Get("Allow"))
	}
	if got := do(t, http.HandlerFunc(handleHostUpdate), http.MethodGet, "/api/v1/herdr/host/update", ""); got.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET update=%d", got.Code)
	} else if got.Header().Get("Allow") != "POST" {
		t.Fatalf("Allow=%q", got.Header().Get("Allow"))
	}
	if got := do(t, http.HandlerFunc(handleHostInstall), http.MethodGet, "/api/v1/herdr/host/install", ""); got.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET install=%d", got.Code)
	} else if got.Header().Get("Allow") != "POST" {
		t.Fatalf("Allow=%q", got.Header().Get("Allow"))
	}
}

// hostSequence is a fake runner that records every command and answers by
// command name, so a stop-update-start sequence can be checked without running
// anything real.
type hostSequence struct {
	mu        sync.Mutex
	ran       []string
	running   *bool
	failOn    string
	startSets bool
}

func (h *hostSequence) run(_ context.Context, name string, args ...string) ([]byte, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	line := strings.Join(append([]string{name}, args...), " ")
	h.ran = append(h.ran, line)

	// herdr status --json is how the sequence decides whether to stop and start.
	if strings.HasSuffix(line, "status --json") {
		state := `"running":false,"version":null`
		if h.running != nil && *h.running {
			state = `"running":true,"version":"0.9.0"`
		}
		return []byte(`{"client":{"version":"0.9.0"},"server":{` + state + `}}`), nil
	}

	if strings.Contains(line, "server stop") {
		if h.running != nil {
			*h.running = false
		}
		return []byte("stopped session default\n"), nil
	}
	if h.failOn != "" && strings.Contains(line, h.failOn) {
		return []byte("boom\n"), &hostExitError{code: 1, err: errors.New("exit status 1")}
	}
	return []byte("done\n"), nil
}

func TestHostUpdateStopsTheDaemonAndStartsItAgain(t *testing.T) {
	running := true
	spawned := recordSpawns(t, &running)
	seq := &hostSequence{running: &running}
	hostResolve = func(string) (string, bool) { return "/usr/local/bin/herdr", true }
	SetHostDeps(seq.run, nil)
	t.Cleanup(func() {
		SetHostDeps(nil, nil)
		hostResolve = findHerdrBinary
	})

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/herdr/host/update", nil)
	handleHostUpdate(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", recorder.Code, recorder.Body.String())
	}
	var body struct {
		OK    bool `json:"ok"`
		Steps []struct {
			Step    string `json:"step"`
			OK      bool   `json:"ok"`
			Command string `json:"command"`
		} `json:"steps"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v (%s)", err, recorder.Body.String())
	}
	if !body.OK {
		t.Fatalf("sequence reported failure: %s", recorder.Body.String())
	}
	if len(body.Steps) != 3 {
		t.Fatalf("steps = %d, want 3 (%s)", len(body.Steps), recorder.Body.String())
	}
	for i, want := range []string{"stop", "update", "start"} {
		if body.Steps[i].Step != want {
			t.Errorf("step %d = %q, want %q", i, body.Steps[i].Step, want)
		}
		if !body.Steps[i].OK {
			t.Errorf("step %q reported failure: %s", want, recorder.Body.String())
		}
	}
	// The order matters: an update on an old server needs the stop first, and
	// the console is unusable until something answers again.
	joined := strings.Join(seq.ran, "\n")
	stopAt := strings.Index(joined, "server stop")
	updateAt := strings.Index(joined, "/usr/local/bin/herdr update")
	if stopAt < 0 || updateAt < 0 {
		t.Fatalf("missing a step:\n%s", joined)
	}
	if !(stopAt < updateAt) {
		t.Fatalf("wrong order:\n%s", joined)
	}
	// herdr runs its own headless server; tmux was one multiplexer hosting
	// another, and starting it must not depend on one being installed.
	if got := spawned(); len(got) != 1 {
		t.Fatalf("headless server started %d times, want 1", len(got))
	} else if joined := strings.Join(got[0], " "); !strings.HasSuffix(joined, "server") {
		t.Fatalf("started %q, want the headless server", joined)
	}
	if !running {
		t.Error("the daemon was not started again, so the console has nothing to talk to")
	}
}

func TestHostUpdateSkipsTheStopWhenNothingRuns(t *testing.T) {
	running := false
	spawned := recordSpawns(t, &running)
	_ = spawned
	seq := &hostSequence{running: &running}
	hostResolve = func(string) (string, bool) { return "/usr/local/bin/herdr", true }
	SetHostDeps(seq.run, nil)
	t.Cleanup(func() {
		SetHostDeps(nil, nil)
		hostResolve = findHerdrBinary
	})

	recorder := httptest.NewRecorder()
	handleHostUpdate(recorder, httptest.NewRequest(http.MethodPost, "/api/v1/herdr/host/update", nil))

	var body struct {
		Steps []struct {
			Step    string `json:"step"`
			Skipped string `json:"skipped"`
		} `json:"steps"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Steps) != 3 {
		t.Fatalf("steps = %d, want 3", len(body.Steps))
	}
	if body.Steps[0].Step != "stop" || body.Steps[0].Skipped == "" {
		t.Errorf("stop step = %+v, want it skipped", body.Steps[0])
	}
	if strings.Contains(strings.Join(seq.ran, "\n"), "server stop") {
		t.Error("a stop was run although no daemon was up")
	}
	// Even so, the daemon is started: an update that leaves nothing running is
	// what left the console disconnected on a deployed host.
	if !running {
		t.Error("the daemon was not started")
	}
}

func TestHostUpdateStartsAgainEvenWhenTheUpdateFails(t *testing.T) {
	running := true
	spawned := recordSpawns(t, &running)
	_ = spawned
	seq := &hostSequence{running: &running, failOn: "herdr update"}
	hostResolve = func(string) (string, bool) { return "/usr/local/bin/herdr", true }
	SetHostDeps(seq.run, nil)
	t.Cleanup(func() {
		SetHostDeps(nil, nil)
		hostResolve = findHerdrBinary
	})

	recorder := httptest.NewRecorder()
	handleHostUpdate(recorder, httptest.NewRequest(http.MethodPost, "/api/v1/herdr/host/update", nil))

	var body struct {
		OK    bool `json:"ok"`
		Steps []struct {
			Step string `json:"step"`
			OK   bool   `json:"ok"`
		} `json:"steps"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.OK {
		t.Error("a failed update must not be reported as success")
	}
	if body.Steps[1].Step != "update" || body.Steps[1].OK {
		t.Errorf("update step = %+v, want a failure", body.Steps[1])
	}
	if !body.Steps[2].OK {
		t.Errorf("start step = %+v, want success: the old binary is still there and usable",
			body.Steps[2])
	}
	if !running {
		t.Error("the daemon was left down after a failed update")
	}
}

func TestHostRestartStopsAndStarts(t *testing.T) {
	running := true
	spawned := recordSpawns(t, &running)
	seq := &hostSequence{running: &running}
	hostResolve = func(string) (string, bool) { return "/usr/local/bin/herdr", true }
	SetHostDeps(seq.run, nil)
	t.Cleanup(func() {
		SetHostDeps(nil, nil)
		hostResolve = findHerdrBinary
	})

	recorder := httptest.NewRecorder()
	handleHostRestart(recorder, httptest.NewRequest(http.MethodPost, "/api/v1/herdr/host/restart", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", recorder.Code, recorder.Body.String())
	}
	joined := strings.Join(seq.ran, "\n")
	if !strings.Contains(joined, "server stop") {
		t.Fatalf("restart did not stop the daemon:\n%s", joined)
	}
	if got := spawned(); len(got) != 1 {
		t.Fatalf("restart started the daemon %d times, want 1; body=%s", len(got), recorder.Body.String())
	}
	if !running {
		t.Error("restart left the daemon down")
	}
}

func TestHostRestartRefusesWhenHerdrIsMissing(t *testing.T) {
	hostResolve = func(string) (string, bool) { return "", false }
	t.Cleanup(func() { hostResolve = findHerdrBinary })

	recorder := httptest.NewRecorder()
	handleHostRestart(recorder, httptest.NewRequest(http.MethodPost, "/api/v1/herdr/host/restart", nil))
	if recorder.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", recorder.Code)
	}
}

func TestSessionArgsNameTheSessionTheSocketBelongsTo(t *testing.T) {
	// A stop or start must act on the daemon this console talks to. herdr's CLI
	// resolves a named session from <config>/sessions/<name>/herdr.sock, so the
	// flag is derived from the socket rather than assumed to be the default.
	SetHerdrSocket("/home/op/.config/herdr/sessions/work/herdr.sock")
	t.Cleanup(func() { SetHerdrSocket("") })
	if got := sessionArgs(); len(got) != 2 || got[0] != "--session" || got[1] != "work" {
		t.Fatalf("sessionArgs = %q, want --session work", got)
	}
	if got := displayWithSession("herdr server stop"); got != "herdr server stop --session work" {
		t.Fatalf("display = %q", got)
	}

	// The default session has no flag.
	SetHerdrSocket("/home/op/.config/herdr/herdr.sock")
	if got := sessionArgs(); got != nil {
		t.Fatalf("sessionArgs = %q, want none for the default socket", got)
	}
	if got := displayWithSession("herdr update"); got != "herdr update" {
		t.Fatalf("display = %q", got)
	}

	SetHerdrSocket("")
	if got := sessionArgs(); got != nil {
		t.Fatalf("sessionArgs = %q, want none without a socket", got)
	}
}

// recordSpawns captures the detached headless-server starts a test triggers and
// restores the real one afterwards.
func recordSpawns(t *testing.T, running *bool) func() [][]string {
	t.Helper()
	var spawned [][]string
	previous := hostSpawnDetached
	hostSpawnDetached = func(binary string, args []string) error {
		spawned = append(spawned, append([]string{binary}, args...))
		if running != nil {
			*running = true
		}
		return nil
	}
	t.Cleanup(func() { hostSpawnDetached = previous })
	// Returned as an accessor: a slice returned by value would be the empty
	// header from before any append, not what the test later recorded.
	return func() [][]string { return spawned }
}
