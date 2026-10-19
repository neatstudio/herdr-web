package server

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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
	var gotName string
	var gotArgs []string
	SetHostDeps(func(_ context.Context, name string, args ...string) ([]byte, error) {
		gotName, gotArgs = name, append([]string(nil), args...)
		return []byte("updated herdr to 0.9.5\n"), nil
	}, nil)
	defer SetHostDeps(nil, nil)

	response := do(t, http.HandlerFunc(handleHostUpdate), http.MethodPost, "/api/v1/herdr/host/update", "")
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	body := decodeMap(t, response)
	if body["ok"] != true || body["command"] != "herdr update" || body["output"] != "updated herdr to 0.9.5\n" || body["exitCode"] != float64(0) {
		t.Fatalf("body=%v", body)
	}
	if gotName != binary {
		t.Fatalf("runner name=%q want %q", gotName, binary)
	}
	if len(gotArgs) != 1 || gotArgs[0] != "update" {
		t.Fatalf("runner args=%q", gotArgs)
	}
}

func TestHostUpdateRunsBrewForAHomebrewInstall(t *testing.T) {
	stubHostResolver(t, "/opt/homebrew/bin/herdr", true)
	var gotName string
	var gotArgs []string
	SetHostDeps(func(_ context.Context, name string, args ...string) ([]byte, error) {
		gotName, gotArgs = name, append([]string(nil), args...)
		return []byte("==> Upgrading herdr\n"), nil
	}, nil)
	defer SetHostDeps(nil, nil)

	response := do(t, http.HandlerFunc(handleHostUpdate), http.MethodPost, "/api/v1/herdr/host/update", "")
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	body := decodeMap(t, response)
	if body["ok"] != true || body["command"] != "brew upgrade herdr" {
		t.Fatalf("body=%v", body)
	}
	if gotName != "brew" {
		t.Fatalf("runner name=%q", gotName)
	}
	if len(gotArgs) != 2 || gotArgs[0] != "upgrade" || gotArgs[1] != "herdr" {
		t.Fatalf("runner args=%q", gotArgs)
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
	if body["ok"] != false || body["exitCode"] != float64(2) {
		t.Fatalf("body=%v", body)
	}
	if body["output"] != "error: could not replace binary: permission denied\n" {
		t.Fatalf("output=%v", body["output"])
	}
}

func TestHostUpdateReportsATimeoutAsAFailedResult(t *testing.T) {
	binary := writeFakeHerdrBinary(t)
	SetHerdrBin(binary)
	defer SetHerdrBin("")
	SetHostDeps(func(context.Context, string, ...string) ([]byte, error) {
		return nil, context.DeadlineExceeded
	}, nil)
	defer SetHostDeps(nil, nil)

	response := do(t, http.HandlerFunc(handleHostUpdate), http.MethodPost, "/api/v1/herdr/host/update", "")
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	body := decodeMap(t, response)
	if body["ok"] != false || body["exitCode"] != float64(124) {
		t.Fatalf("body=%v", body)
	}
	output, _ := body["output"].(string)
	if !strings.Contains(output, "timed out") {
		t.Fatalf("output=%q", output)
	}
}

func TestHostUpdateReportsAnUnrunnableCommandAsBadGateway(t *testing.T) {
	binary := writeFakeHerdrBinary(t)
	SetHerdrBin(binary)
	defer SetHerdrBin("")
	SetHostDeps(func(context.Context, string, ...string) ([]byte, error) {
		return nil, errors.New(`exec: "herdr": executable file not found in $PATH`)
	}, nil)
	defer SetHostDeps(nil, nil)

	response := do(t, http.HandlerFunc(handleHostUpdate), http.MethodPost, "/api/v1/herdr/host/update", "")
	if response.Code != http.StatusBadGateway {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	body := decodeMap(t, response)
	errorBody, _ := body["error"].(map[string]any)
	if errorBody["code"] != "herdr_command_failed" {
		t.Fatalf("body=%v", body)
	}
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
