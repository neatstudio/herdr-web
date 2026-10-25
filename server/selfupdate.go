package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
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
	return selfOfficialSource
}

// selfOfficialSource is where the project publishes releases. A variable so a
// test can point it at a dead address instead of the real one.
var selfOfficialSource = "https://github.com/" + selfReleaseName + "/releases/latest/download"

// selfClient bounds the parts of a transfer that can hang forever: an
// unreachable source has to fail, and fail again quickly enough that three
// attempts still fit inside one response.
var selfClient = &http.Client{
	Transport: &http.Transport{
		DialContext:           (&net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		TLSHandshakeTimeout:   15 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
	},
}

// selfSourceTimeout is how long one source gets before the next is tried.
const selfSourceTimeout = 100 * time.Second

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
// handleSelfUpdate replaces the running binary with the one a source publishes.
//
// Which source is not the operator's problem: the remembered one is tried first,
// then GitHub, then the consoles reachable on the tailnet, and the first source
// that answers wins. A host behind a link that drops GitHub's download pays for
// that once and then remembers a source that works.
func handleSelfUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, "POST")
		return
	}
	var body struct {
		From string `json:"from"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&body)

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

	explicit := strings.TrimSpace(body.From) != ""
	candidates := selfCandidates(ctx, body.From)
	if len(candidates) == 0 {
		candidates = []selfCandidate{{Source: selfSourceURL(body.From)}}
	}

	tried := make([]selfStep, 0, 4)
	var lastErr string
	for _, candidate := range candidates {
		source := candidate.Source
		// A source publishing a build that is not newer is not an update: the
		// hash differs, so it would otherwise replace a working console with an
		// older one.
		// "dev" carries no numbers, so nothing published can be compared to it;
		// a release is an improvement over an unstamped build.
		comparable := len(versionParts(ConsoleVersion)) > 0
		if candidate.Version != "" && comparable && !newerVersion(candidate.Version, ConsoleVersion) {
			tried = append(tried, selfStep{Step: "skip", OK: true,
				Detail: selfSourceLabel(source) + " has " + candidate.Version + ", not newer than " + ConsoleVersion})
			continue
		}
		// Each source gets its own budget: a slow download from the one that
		// cannot be reached well must not consume the time the next one needs.
		attemptCtx, attemptCancel := context.WithTimeout(ctx, selfSourceTimeout)
		result, err := selfUpdateFrom(attemptCtx, execPath, source)
		attemptCancel()
		if err == nil {
			rememberSelfSource(source)
			// An explicit source is shown as it was given; a discovered one is
			// named so the operator knows where the build came from.
			if !explicit {
				result.Steps = append([]selfStep{{Step: "source", OK: true,
					Detail: "used " + selfSourceLabel(source)}}, result.Steps...)
			}
			writeJSON(w, http.StatusOK, result)
			return
		}
		if source == selfOfficialSource {
			rememberGitHubFailure()
		}
		tried = append(tried, result.Steps...)
		lastErr = err.Error()
	}
	message := "no release source answered: " + lastErr
	if lastErr == "" {
		message = "every release source publishes a build that is not newer than this one"
	}
	writeJSON(w, http.StatusOK, selfUpdateResult{OK: false, Steps: tried, Error: message})
}

// selfUpdateFrom fetches one source and applies it. An error means the source
// could not provide a verified build, and the caller moves on to the next one.
func selfUpdateFrom(ctx context.Context, execPath, source string) (selfUpdateResult, error) {
	steps := make([]selfStep, 0, 4)
	asset := selfPlatform()

	// Which version a source publishes decides whether this is an update at all.
	// A differing hash alone is not enough: it once replaced a working build with
	// an older release, and an update that can go backwards is worse than none.
	publishedRaw, versionErr := selfFetchText(ctx, source+"/version")
	if versionErr != nil {
		detail := "could not read " + source + "/version: " + versionErr.Error()
		steps = append(steps, selfStep{Step: "version", Detail: detail})
		if isNotFound(versionErr) {
			steps[len(steps)-1].Detail = source + " does not say which version it publishes"
			return selfUpdateResult{OK: false, Steps: steps}, errors.New("the source published no version")
		}
		return selfUpdateResult{OK: false, Steps: steps}, errors.New("the release source could not be read")
	}
	published := strings.TrimSpace(publishedRaw)
	if published == "" {
		steps = append(steps, selfStep{Step: "version",
			Detail: source + " publishes an empty version"})
		return selfUpdateResult{OK: false, Steps: steps}, errors.New("the source published an empty version")
	}
	comparable := len(versionParts(ConsoleVersion)) > 0
	if comparable && !selfNewer(published, ConsoleVersion) {
		steps = append(steps, selfStep{Step: "skip", OK: true,
			Detail: "publishes " + published + ", not newer than " + ConsoleVersion})
		return selfUpdateResult{OK: false, Steps: steps}, errors.New("the published build is not newer")
	}
	// A development build is not a release: its version says dirty because the
	// tree it was built from has uncommitted changes, and adopting one would put
	// somebody's work in progress on the whole fleet.
	if strings.Contains(strings.ToLower(published), "dirty") {
		steps = append(steps, selfStep{Step: "skip", OK: true,
			Detail: "publishes " + published + ", a development build"})
		return selfUpdateResult{OK: false, Steps: steps}, errors.New("the source publishes a development build")
	}

	steps = append(steps, selfStep{Step: "version", OK: true,
		Detail: "publishes " + published + ", this build is " + ConsoleVersion})

	// A source without a checksum is refused: an unverified binary is not worth
	// replacing a working console with.
	wantSum, err := selfFetchText(ctx, source+"/"+asset+".sha256")
	if err != nil {
		detail := "could not read " + source + "/" + asset + ".sha256: " + err.Error()
		steps = append(steps, selfStep{Step: "checksum", Detail: detail})
		if isNotFound(err) {
			return selfUpdateResult{OK: false, Steps: steps},
				errors.New("the release source published no checksum")
		}
		return selfUpdateResult{OK: false, Steps: steps},
			errors.New("the release source could not be read")
	}
	want := strings.Fields(wantSum)
	if len(want) == 0 {
		steps = append(steps, selfStep{Step: "checksum", Detail: "the checksum file was empty"})
		return selfUpdateResult{OK: false, Steps: steps}, errors.New("the checksum file was empty")
	}
	currentSum, err := fileSHA256(execPath)
	if err != nil {
		return selfUpdateResult{}, err
	}
	if strings.EqualFold(currentSum, want[0]) {
		steps = append(steps, selfStep{Step: "keep", OK: true,
			Detail: "already running this build (" + shortSum(currentSum) + ")"})
		return selfUpdateResult{OK: true, Updated: false, Steps: steps}, nil
	}

	tmp, err := os.CreateTemp(filepath.Dir(execPath), ".herdr-web-update-*")
	if err != nil {
		return selfUpdateResult{}, err
	}
	tmpPath := tmp.Name()
	// Any failure past this point leaves the running binary untouched.
	defer func() { _ = os.Remove(tmpPath) }()
	if err := selfDownload(ctx, source+"/"+asset, tmp); err != nil {
		_ = tmp.Close()
		steps = append(steps, selfStep{Step: "download", Detail: err.Error()})
		return selfUpdateResult{OK: false, Steps: steps}, errors.New("the release could not be downloaded")
	}
	if err := tmp.Close(); err != nil {
		return selfUpdateResult{}, err
	}
	got, err := fileSHA256(tmpPath)
	if err != nil {
		return selfUpdateResult{}, err
	}
	if !strings.EqualFold(got, want[0]) {
		steps = append(steps, selfStep{Step: "verify", Detail: "checksum mismatch: the source said " +
			shortSum(want[0]) + ", the file is " + shortSum(got)})
		return selfUpdateResult{OK: false, Steps: steps}, errors.New("the download did not match its checksum")
	}
	steps = append(steps, selfStep{Step: "verify", OK: true, Detail: "checksum matches (" + shortSum(got) + ")"})
	// The file has to say what it is. A checksum only proves the download is
	// intact; it cannot prove the source published the build it named, and a
	// console that served an old file under a new version once downgraded four
	// machines with a valid checksum.
	if err := os.Chmod(tmpPath, 0o755); err != nil {
		return selfUpdateResult{}, err
	}
	// A file that cannot name its version is refused too: "could not ask" is not
	// evidence that it is the build the source promised.
	reported := binaryVersion(tmpPath)
	if reported == "" {
		steps = append(steps, selfStep{Step: "verify",
			Detail: "the file did not answer -version; the source called it " + published})
		return selfUpdateResult{OK: false, Steps: steps},
			errors.New("the published file could not say which build it is")
	}
	if !sameVersion(reported, published) {
		steps = append(steps, selfStep{Step: "verify",
			Detail: "the file is " + reported + ", the source called it " + published})
		return selfUpdateResult{OK: false, Steps: steps},
			errors.New("the published file is not the build it claims")
	}
	// Keep what is being replaced: an update that starts and then misbehaves needs
	// a way back that does not involve another download.
	previousPath := execPath + ".previous"
	if err := copyFile(execPath, previousPath); err != nil {
		// Not fatal: the update is still verified, and a missing fallback is a
		// smaller problem than a console that refuses to update.
		steps = append(steps, selfStep{Step: "keep", Detail: "could not keep the old binary: " + err.Error()})
	}
	if err := os.Rename(tmpPath, execPath); err != nil {
		steps = append(steps, selfStep{Step: "replace", Detail: err.Error()})
		return selfUpdateResult{OK: false, Steps: steps}, errors.New("the new binary could not replace the old one")
	}
	steps = append(steps, selfStep{Step: "replace", OK: true,
		Detail: "installed " + shortSum(got) + " at " + execPath, Changed: true})
	return selfUpdateResult{
		OK:      true,
		Updated: true,
		Steps:   steps,
		// The new file is on disk; the running process is still the old one, so
		// the operator (or the service manager) has to start it.
		Restart: restartHint(),
	}, nil
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

// binaryVersion asks a downloaded executable which build it is, by running it.
//
// "-version" is a read-only question the binary answers without starting anything,
// which is exactly what is needed before it replaces a working console.
func binaryVersion(path string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, path, "-version").Output()
	if err != nil {
		return ""
	}
	fields := strings.Fields(string(output))
	if len(fields) < 2 {
		return ""
	}
	return strings.TrimSpace(fields[len(fields)-1])
}

// sameVersion compares a build's own report with the version a source published.
func sameVersion(reported, published string) bool {
	return strings.TrimSpace(reported) == strings.TrimSpace(published)
}

// copyFile writes src to dst with the same permissions, replacing it.
func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer func() { _ = in.Close() }()
	info, err := in.Stat()
	if err != nil {
		return err
	}
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, info.Mode().Perm())
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}

// handleSelfRollback puts the build that was replaced back in place. It exists
// because an update that starts and then misbehaves is the one failure the
// checksum cannot catch.
func handleSelfRollback(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, "POST")
		return
	}
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
	previous := execPath + ".previous"
	if _, err := os.Stat(previous); err != nil {
		writeError(w, http.StatusNotFound, "no_rollback",
			"there is no previous build on this host: none was replaced since it was installed")
		return
	}
	if err := copyFile(previous, execPath); err != nil {
		writeError(w, http.StatusInternalServerError, "rollback_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"rolled":  true,
		"restart": restartHint(),
	})
}

// mustSelfText reads a short text file and returns "" when it is absent.
func mustSelfText(ctx context.Context, url string) string {
	text, err := selfFetchText(ctx, url)
	if err != nil {
		return ""
	}
	return text
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
		if strings.Contains(url, "/api/v1/herdr-web/release") || strings.Contains(url, "/release/") {
			addConsoleToken(request)
		}
		response, err := selfClient.Do(request)
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
		if strings.Contains(url, "/api/v1/herdr-web/release") || strings.Contains(url, "/release/") {
			addConsoleToken(request)
		}
		response, err := selfClient.Do(request)
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
