package server

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// handleHostStat answers whether a path exists on the machine this bridge runs
// on. herdr can drive panes on another host over SSH, and a path printed by such
// a pane exists only there; the console uses this to say so instead of offering
// a preview that cannot work.
func handleHostStat(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, "GET")
		return
	}
	path := strings.TrimSpace(r.URL.Query().Get("path"))
	if path == "" || !filepath.IsAbs(path) {
		writeError(w, http.StatusBadRequest, "invalid_request", "path must be absolute")
		return
	}
	info, err := os.Stat(path)
	if err != nil {
		// A missing path is an answer, not an error: it is how a remote pane's
		// path looks from here.
		writeJSON(w, http.StatusOK, map[string]any{"path": path, "exists": false})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"path":   path,
		"exists": true,
		"isDir":  info.IsDir(),
	})
}
