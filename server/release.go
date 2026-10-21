package server

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// installScript is the installer the binary hands out, embedded by main so a
// host without GitHub can still be installed from. Set once at startup.
var installScript []byte

// SetInstallScript embeds the installer for /release/install.sh.
func SetInstallScript(script []byte) {
	installScript = script
}

// fileSHA256 hashes a file in chunks; release assets are megabytes.
func fileSHA256(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer func() { _ = file.Close() }()
	sum := sha256.New()
	if _, err := io.Copy(sum, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(sum.Sum(nil)), nil
}

// This file makes an installed console a release source of its own.
//
// A machine that cannot reach GitHub still needs a way to install and update:
// the console that is already running on a peer can hand over the same bytes it
// is running, and the installer it was installed with. That is the whole point
// of serving them from the binary itself — a bastion or any reachable host
// becomes the distribution point, and the files never have to be copied by hand.

// releaseSelfPath is the asset name of the binary serving the request, in the
// same shape the GitHub release uses.
func releaseSelfPath() string {
	arch := runtime.GOARCH
	switch arch {
	case "amd64", "arm64":
	default:
		arch = runtime.GOARCH
	}
	return fmt.Sprintf("herdr-web-%s-%s", runtime.GOOS, arch)
}

// releaseDir is where downloaded release assets are kept for other platforms.
// Missing is normal: a console only knows its own bytes unless someone put the
// rest there.
func releaseDir() string {
	if override := strings.TrimSpace(os.Getenv("HERDR_WEB_RELEASE_DIR")); override != "" {
		return override
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".local", "share", "herdr-web", "releases")
}

// handleRelease serves the installer and the binary for the platform that asks.
//
// The installer is answered for every platform (it is a shell script); a binary
// is answered from the releases directory when it is there, and otherwise the
// running executable is used for its own platform. requestOS/requestArch let a
// client ask for another platform explicitly, which is what a mixed fleet needs.
func handleRelease(w http.ResponseWriter, r *http.Request) {
	// Seeding is the fallback for a network with no way out: one host that can
	// receive the files serves them to the rest of its segment.
	if r.Method == http.MethodPost {
		handleReleaseUpload(w, r)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeMethodNotAllowed(w, "GET, POST")
		return
	}
	name := strings.Trim(strings.TrimPrefix(r.URL.Path, "/release/"), "/")
	if name == "" || strings.Contains(name, "..") {
		writeError(w, http.StatusNotFound, "not_found", "unknown release file")
		return
	}
	w.Header().Set("Cache-Control", "no-store")

	// The version this console publishes, so an updater can tell whether the
	// build it would download is newer before downloading it.
	if name == "version" {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		if r.Method == http.MethodHead {
			return
		}
		_, _ = w.Write([]byte(ConsoleVersion + "\n"))
		return
	}

	if name == "install.sh" {
		w.Header().Set("Content-Type", "text/x-shellscript; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="install.sh"`)
		if r.Method == http.MethodHead {
			return
		}
		_, _ = w.Write(installScript)
		return
	}

	if strings.HasPrefix(name, "herdr-") {
		// herdr's own binary, so a machine without access to herdr.dev installs
		// from a relay the same way this console updates itself.
		dir := releaseDir()
		if dir == "" {
			writeError(w, http.StatusNotFound, "not_found", "no release files on this host")
			return
		}
		path := filepath.Join(dir, filepath.Base(name))
		if info, err := os.Stat(path); err != nil || info.IsDir() {
			writeError(w, http.StatusNotFound, "not_found",
				fmt.Sprintf("%s is not on this host; seed it with a POST to /release/%s", name, name))
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		http.ServeFile(w, r, path)
		return
	}

	if !strings.HasPrefix(name, "herdr-web-") {
		writeError(w, http.StatusNotFound, "not_found", "unknown release file")
		return
	}
	// A checksum beside the binary, so an installer can verify what it fetched.
	wantSum := strings.HasSuffix(name, ".sha256")
	asset := strings.TrimSuffix(name, ".sha256")

	if asset == releaseSelfPath() {
		if wantSum {
			writeChecksumForSelf(w, r)
			return
		}
		serveSelf(w, r)
		return
	}
	// Another platform: only what someone put in the release directory.
	dir := releaseDir()
	if dir == "" {
		writeError(w, http.StatusNotFound, "not_found", "no release files on this host")
		return
	}
	path := filepath.Join(dir, filepath.Base(name))
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		writeError(w, http.StatusNotFound, "not_found",
			fmt.Sprintf("%s is not on this host; this console serves only %s, or files in its release directory",
				asset, releaseSelfPath()))
		return
	}
	if wantSum {
		// `path` already ends in .sha256: the request came for the checksum, not
		// for the binary beside it.
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		http.ServeFile(w, r, path)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	http.ServeFile(w, r, path)
}

// serveSelf streams the running executable. Reading it back while it runs is
// fine on every platform this console supports: the file is not held open for
// writing, and an install replaces it by renaming.
func serveSelf(w http.ResponseWriter, r *http.Request) {
	path, err := os.Executable()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "release_unavailable", err.Error())
		return
	}
	path, err = filepath.EvalSymlinks(path)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "release_unavailable", err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	http.ServeFile(w, r, path)
}

func writeChecksumForSelf(w http.ResponseWriter, r *http.Request) {
	path, err := os.Executable()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "release_unavailable", err.Error())
		return
	}
	path, err = filepath.EvalSymlinks(path)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "release_unavailable", err.Error())
		return
	}
	sum, err := fileSHA256(path)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "release_unavailable", err.Error())
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	if r.Method == http.MethodHead {
		return
	}
	fmt.Fprintf(w, "%s  %s\n", sum, releaseSelfPath())
}

// handleReleaseUpload stores a release file so this console can serve it.
//
// A network with no way out still needs the binary, and the machine that can be
// reached by hand is the one to put it on: after this, every other machine in
// that segment installs from here with `install.sh --url http://this-host:5000/release`.
//
// The body is the file itself, and the checksum is computed here rather than
// trusted from the request, so what is served later is exactly what arrived.
func handleReleaseUpload(w http.ResponseWriter, r *http.Request) {
	name := strings.Trim(strings.TrimPrefix(r.URL.Path, "/release/"), "/")
	if name == "" || strings.Contains(name, "..") || strings.Contains(name, "/") {
		writeError(w, http.StatusBadRequest, "invalid_request", "a release file name is required")
		return
	}
	if !strings.HasPrefix(name, "herdr-web-") && !strings.HasPrefix(name, "herdr-") &&
		name != "install.sh" && name != "version" {
		writeError(w, http.StatusBadRequest, "invalid_request",
			"only herdr-web-<os>-<arch>, herdr-<os>-<arch>, their checksums and install.sh can be stored here")
		return
	}
	dir := releaseDir()
	if dir == "" {
		writeError(w, http.StatusInternalServerError, "release_unavailable", "no release directory")
		return
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		writeError(w, http.StatusInternalServerError, "release_unavailable", err.Error())
		return
	}
	path := filepath.Join(dir, filepath.Base(name))
	tmp, err := os.CreateTemp(dir, ".upload-*")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "release_unavailable", err.Error())
		return
	}
	tmpPath := tmp.Name()
	defer func() { _ = os.Remove(tmpPath) }()

	// A binary is megabytes; the cap keeps a stray upload from filling the disk.
	const limit = 256 << 20
	written, err := io.Copy(tmp, io.LimitReader(r.Body, limit+1))
	if err != nil {
		_ = tmp.Close()
		writeError(w, http.StatusBadRequest, "upload_failed", err.Error())
		return
	}
	if written > limit {
		_ = tmp.Close()
		writeError(w, http.StatusRequestEntityTooLarge, "too_large",
			"release files above 256 MiB are not accepted")
		return
	}
	if err := tmp.Close(); err != nil {
		writeError(w, http.StatusInternalServerError, "release_unavailable", err.Error())
		return
	}
	sum, err := fileSHA256(tmpPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "release_unavailable", err.Error())
		return
	}
	if err := os.Chmod(tmpPath, 0o755); err != nil {
		writeError(w, http.StatusInternalServerError, "release_unavailable", err.Error())
		return
	}
	if err := os.Rename(tmpPath, path); err != nil {
		writeError(w, http.StatusInternalServerError, "release_unavailable", err.Error())
		return
	}
	// The checksum the installer looks for, written from what actually arrived.
	if err := os.WriteFile(path+".sha256", []byte(sum+"  "+filepath.Base(name)+"\n"), 0o644); err != nil {
		writeError(w, http.StatusInternalServerError, "release_unavailable", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"stored":   filepath.Base(name),
		"bytes":    written,
		"sha256":   sum,
		"servedAt": "/release/" + filepath.Base(name),
	})
}
