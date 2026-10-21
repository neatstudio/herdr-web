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
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeMethodNotAllowed(w, "GET")
		return
	}
	name := strings.Trim(strings.TrimPrefix(r.URL.Path, "/release/"), "/")
	if name == "" || strings.Contains(name, "..") {
		writeError(w, http.StatusNotFound, "not_found", "unknown release file")
		return
	}
	w.Header().Set("Cache-Control", "no-store")

	if name == "install.sh" {
		w.Header().Set("Content-Type", "text/x-shellscript; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="install.sh"`)
		if r.Method == http.MethodHead {
			return
		}
		_, _ = w.Write(installScript)
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
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		http.ServeFile(w, r, path+".sha256")
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
