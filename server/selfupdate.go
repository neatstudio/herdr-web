package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// This file lets the console update itself, from GitHub when it can reach it and
// from any release source when it cannot.
//
// The test for "is there a new build" is the checksum of the running binary, not
// a version comparison: the bytes are what runs, and two copies that differ are
// an update whether or not their version strings say so.

const (
	selfUpdateTimeout = 5 * time.Minute
	// selfReleaseName is the GitHub repository the release comes from.
	selfReleaseName = "neatstudio/herdr-web"
)

var selfExecutable = os.Executable

// selfPlatform is the release asset name for this binary, matching the release
// workflow and the name the installer asks for.
func selfPlatform() string {
	return fmt.Sprintf("herdr-web-%s-%s", runtime.GOOS, runtime.GOARCH)
}

// selfSourceURL is the base a release is fetched from: an explicit source wins,
// so a host without GitHub can update from a peer that has the bytes.
func selfSourceURL(from string) string {
	from = strings.TrimSpace(from)
	if from != "" {
		return strings.TrimRight(from, "/")
	}
	return "https://github.com/" + selfReleaseName + "/releases/latest/download"
}

type selfRelease struct {
	Version    string `json:"version"`
	Platform   string `json:"platform"`
	SHA256     string `json:"sha256"`
	Source     string `json:"source"`
	Executable string `json:"executable"`
	Error      string `json:"error,omitempty"`
}

func handleSelfRelease(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, "GET")
		return
	}
	path, err := selfExecutable()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "release_unavailable", err.Error())
		return
	}
	sum, err := fileSHA256(path)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "release_unavailable", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, selfRelease{
		Version:    ConsoleVersion,
		Platform:   selfPlatform(),
		SHA256:     sum,
		Source:     selfSourceURL(""),
		Executable: path,
	})
}

// selfStep is one command of the self-update, shown the way the herdr panel
// shows its sequence.
type selfStep struct {
	Step    string `json:"step"`
	OK      bool   `json:"ok"`
	Detail  string `json:"detail"`
	Changed bool   `json:"changed,omitempty"`
}

type selfUpdateResult struct {
	OK      bool       `json:"ok"`
	Updated bool       `json:"updated"`
	Restart string     `json:"restart,omitempty"`
	Steps   []selfStep `json:"steps"`
	Error   string     `json:"error,omitempty"`
}

// handleSelfUpdate replaces the running binary with the one at the source.
//
// The file is replaced by renaming a complete download over it, which is atomic
// on every platform this runs on and leaves the running process on the old inode
// until it restarts. It never restarts itself: that would drop the answer to the
// request that asked for it.
func handleSelfUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, "POST")
		return
	}
	var body struct {
		From string `json:"from"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&body)
	source := selfSourceURL(body.From)

	execPath, err := selfExecutable()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "release_unavailable", err.Error())
		return
	}
	execPath, err = filepath.EvalSymlinks(execPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "release_unavailable", err.Error())
		return
	}

	ctx, cancel := contextWithTimeout(r, selfUpdateTimeout)
	defer cancel()

	steps := make([]selfStep, 0, 3)
	asset := selfPlatform()
	keep := selfStep{Step: "keep", OK: true}
	// A source without a checksum is refused: an unverified binary is not worth
	// replacing a working console with.
	wantSum, err := selfFetchText(ctx, source+"/"+asset+".sha256")
	if err != nil {
		steps = append(steps, selfStep{Step: "checksum", Detail: "could not read " + source + "/" + asset + ".sha256: " + err.Error()})
		writeJSON(w, http.StatusOK, selfUpdateResult{OK: false, Steps: steps,
			Error: "the release source published no checksum, so nothing was replaced"})
		return
	}
	want := strings.Fields(wantSum)
	if len(want) == 0 {
		steps = append(steps, selfStep{Step: "checksum", Detail: "the checksum file was empty"})
		writeJSON(w, http.StatusOK, selfUpdateResult{OK: false, Steps: steps,
			Error: "the release source published an empty checksum"})
		return
	}
	currentSum, err := fileSHA256(execPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "release_unavailable", err.Error())
		return
	}
	if strings.EqualFold(currentSum, want[0]) {
		keep.Detail = "already running this build (" + shortSum(currentSum) + ")"
		steps = append(steps, keep)
		writeJSON(w, http.StatusOK, selfUpdateResult{OK: true, Updated: false, Steps: steps})
		return
	}

	tmp, err := os.CreateTemp(filepath.Dir(execPath), ".herdr-web-update-*")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "update_unavailable", err.Error())
		return
	}
	tmpPath := tmp.Name()
	// Any failure past this point leaves the running binary untouched.
	defer func() { _ = os.Remove(tmpPath) }()
	if err := selfDownload(ctx, source+"/"+asset, tmp); err != nil {
		_ = tmp.Close()
		steps = append(steps, selfStep{Step: "download", Detail: err.Error()})
		writeJSON(w, http.StatusOK, selfUpdateResult{OK: false, Steps: steps, Error: "the release could not be downloaded"})
		return
	}
	if err := tmp.Close(); err != nil {
		writeError(w, http.StatusInternalServerError, "update_unavailable", err.Error())
		return
	}
	got, err := fileSHA256(tmpPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "update_unavailable", err.Error())
		return
	}
	if !strings.EqualFold(got, want[0]) {
		steps = append(steps, selfStep{Step: "verify", Detail: "checksum mismatch: the source said " + shortSum(want[0]) + ", the file is " + shortSum(got)})
		writeJSON(w, http.StatusOK, selfUpdateResult{OK: false, Steps: steps, Error: "the downloaded release did not match its checksum"})
		return
	}
	steps = append(steps, selfStep{Step: "verify", OK: true, Detail: "checksum matches (" + shortSum(got) + ")"})
	if err := os.Chmod(tmpPath, 0o755); err != nil {
		writeError(w, http.StatusInternalServerError, "update_unavailable", err.Error())
		return
	}
	if err := os.Rename(tmpPath, execPath); err != nil {
		steps = append(steps, selfStep{Step: "replace", Detail: err.Error()})
		writeJSON(w, http.StatusOK, selfUpdateResult{OK: false, Steps: steps, Error: "the new binary could not replace the old one"})
		return
	}
	steps = append(steps, selfStep{Step: "replace", OK: true, Detail: "installed " + shortSum(got) + " at " + execPath, Changed: true})
	writeJSON(w, http.StatusOK, selfUpdateResult{
		OK:      true,
		Updated: true,
		Steps:   steps,
		// The new file is on disk; the running process is still the old one, so
		// the operator (or the service manager) has to start it.
		Restart: restartHint(),
	})
}

// restartHint names the command that starts the new binary, for the unit the
// console is installed as.
func restartHint() string {
	switch runtime.GOOS {
	case "darwin":
		return "launchctl kickstart -k gui/$(id -u)/dev.herdr-web  (or: make service-restart)"
	case "linux":
		return "systemctl --user restart dev.herdr-web  (or: make service-restart)"
	default:
		return "restart the console"
	}
}

func shortSum(sum string) string {
	if len(sum) > 12 {
		return sum[:12]
	}
	return sum
}

func selfFetchText(ctx context.Context, url string) (string, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	request.Header.Set("User-Agent", "herdr-web")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return "", err
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return "", errors.New(response.Status)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 4096))
	if err != nil {
		return "", err
	}
	return string(body), nil
}

func selfDownload(ctx context.Context, url string, dest io.Writer) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	request.Header.Set("User-Agent", "herdr-web")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return err
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("%s answered %s", url, response.Status)
	}
	_, err = io.Copy(dest, io.LimitReader(response.Body, 128<<20))
	return err
}

// contextWithTimeout ties the work to the request, with its own ceiling because
// an update downloads megabytes.
func contextWithTimeout(r *http.Request, d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(r.Context(), d)
}
