package server

import (
	"io/fs"
	"net/http"
	"path"
	"strings"
)

// handleStatic serves the embedded SPA bundle. Extension-bearing misses 404
// (a missing script must not silently become HTML), extensionless misses fall
// back to index.html for client-side routing.
func (s *Server) handleStatic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeMethodNotAllowed(w, "GET, HEAD")
		return
	}
	if s.webFS == nil {
		writeError(w, http.StatusServiceUnavailable, "web_unavailable",
			"the frontend bundle is not embedded; build it with `make web` first")
		return
	}
	cleaned := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	name := cleaned
	if name == "" || name == "." {
		name = "index.html"
	}
	info, err := fs.Stat(s.webFS, name)
	if err != nil || info.IsDir() {
		if path.Ext(cleaned) != "" {
			writeNotFound(w)
			return
		}
		name = "index.html"
	}
	data, err := fs.ReadFile(s.webFS, name)
	if err != nil {
		writeNotFound(w)
		return
	}
	switch {
	case name == "index.html":
		w.Header().Set("Cache-Control", "no-cache")
	case strings.HasPrefix(name, "assets/"):
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	default:
		w.Header().Set("Cache-Control", "public, max-age=300")
	}
	w.Header().Set("Content-Type", contentTypeFor(name))
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodHead {
		return
	}
	_, _ = w.Write(data)
}

func contentTypeFor(name string) string {
	switch strings.ToLower(path.Ext(name)) {
	case ".html":
		return "text/html; charset=utf-8"
	case ".js", ".mjs":
		return "text/javascript; charset=utf-8"
	case ".css":
		return "text/css; charset=utf-8"
	case ".json", ".map":
		return "application/json; charset=utf-8"
	case ".svg":
		return "image/svg+xml"
	case ".png":
		return "image/png"
	case ".woff2":
		return "font/woff2"
	default:
		return "application/octet-stream"
	}
}
