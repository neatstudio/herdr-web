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
	// A host that cannot reliably reach GitHub pins its own source instead of
	// asking for it on every update: any console serves one.
	if configured := strings.TrimSpace(os.Getenv("HERDR_WEB_RELEASE_SOURCE")); configured != "" {
		return strings.TrimRight(configured, "/")
	}
	return "https://github.com/" + selfReleaseName + "/releases/latest/download"
}

// selfAttempts is how many times a transfer is tried. GitHub's download endpoint
// redirects to a CDN and a connection dropped mid-body ("unexpected EOF") is
// common enough that one attempt is not a verdict.
const selfAttempts = 3

// selfRetryDelay is the wait between attempts, growing linearly.
var selfRetryDelay = 700 * time.Millisecond

func selfSleep(ctx context.Context, d time.Duration) bool {
	select {
	case <-ctx.Done():
		return false
	case <-time.After(d):
		return true
	}
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
		// "The source published no checksum" and "the source could not be
		// reached" are different problems with different answers, and reporting
		// the first for the second sent an operator looking for a missing file.
		message := "the release source published no checksum, so nothing was replaced"
		if !isNotFound(err) {
			message = "the release source could not be read: " + err.Error() +
				". Nothing was replaced; try again, or point the update at a mirror with \"from\"."
		}
		writeJSON(w, http.StatusOK, selfUpdateResult{OK: false, Steps: steps, Error: message})
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

// selfFetchError carries the status a source answered, so a missing file and an
// unreachable host are not reported as the same thing.
type selfFetchError struct {
	url    string
	status int
	err    error
}

func (e *selfFetchError) Error() string {
	if e.status != 0 {
		return fmt.Sprintf("%s answered %d %s", e.url, e.status, http.StatusText(e.status))
	}
	return e.url + ": " + e.err.Error()
}

func (e *selfFetchError) Unwrap() error { return e.err }

// isNotFound reports whether the source answered "it is not here", which means
// the build was never published rather than the network failing.
func isNotFound(err error) bool {
	var fetch *selfFetchError
	return errors.As(err, &fetch) && fetch.status == http.StatusNotFound
}

func selfFetchText(ctx context.Context, url string) (string, error) {
	var last error
	for attempt := 0; attempt < selfAttempts; attempt++ {
		if attempt > 0 && !selfSleep(ctx, selfRetryDelay*time.Duration(attempt)) {
			break
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return "", err
		}
		request.Header.Set("User-Agent", "herdr-web")
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			last = &selfFetchError{url: url, err: err}
			continue
		}
		body, readErr := io.ReadAll(io.LimitReader(response.Body, 4096))
		_ = response.Body.Close()
		if response.StatusCode != http.StatusOK {
			last = &selfFetchError{url: url, status: response.StatusCode}
			// A missing file will still be missing on the next attempt.
			break
		}
		if readErr != nil {
			// A body cut short is worth another attempt: that is what a CDN
			// redirect under a flaky link looks like.
			last = &selfFetchError{url: url, err: readErr}
			continue
		}
		return string(body), nil
	}
	if last == nil {
		last = &selfFetchError{url: url, err: ctx.Err()}
	}
	return "", last
}

func selfDownload(ctx context.Context, url string, dest io.Writer) error {
	var last error
	for attempt := 0; attempt < selfAttempts; attempt++ {
		if attempt > 0 && !selfSleep(ctx, selfRetryDelay*time.Duration(attempt)) {
			break
		}
		// Each attempt starts the file again: a half-written body is worse than
		// no file, and the checksum would reject it anyway.
		if truncater, ok := dest.(interface{ Truncate(int64) error }); ok {
			_ = truncater.Truncate(0)
			if seeker, ok := dest.(io.Seeker); ok {
				if _, err := seeker.Seek(0, io.SeekStart); err != nil {
					return err
				}
			}
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return err
		}
		request.Header.Set("User-Agent", "herdr-web")
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			last = &selfFetchError{url: url, err: err}
			continue
		}
		status := response.StatusCode
		if status != http.StatusOK {
			_ = response.Body.Close()
			last = &selfFetchError{url: url, status: status}
			break
		}
		_, copyErr := io.Copy(dest, io.LimitReader(response.Body, 128<<20))
		_ = response.Body.Close()
		if copyErr != nil {
			last = &selfFetchError{url: url, err: copyErr}
			continue
		}
		return nil
	}
	if last == nil {
		last = &selfFetchError{url: url, err: ctx.Err()}
	}
	return last
}

// contextWithTimeout ties the work to the request, with its own ceiling because
// an update downloads megabytes.
func contextWithTimeout(r *http.Request, d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(r.Context(), d)
}
