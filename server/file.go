package server

// Read-only file preview.
//
// These two handlers let the browser show a file an agent wrote — a rendered
// chart, a build log — without turning this origin into a file server. The
// design is deliberately small:
//
//   - Both handlers only ever read. Nothing here writes, renames, deletes or
//     lists anything.
//   - Every response, success or error, carries X-Content-Type-Options:
//     nosniff, so a browser never reinterprets a body as a different type.
//   - Only regular files are served. A directory, socket, device or fifo is
//     refused instead of opened: opening a fifo blocks until a writer appears,
//     and a device can stream without end. Symlinks are resolved with
//     EvalSymlinks and the *target* is judged, so a link renamed to
//     "chart.png" cannot smuggle in /dev/zero or a directory.
//   - SVG is deliberately absent from the image list. SVG is an XML document
//     that can carry <script>, and these routes are served from the panel's own
//     origin; sending one with an image content type would be an XSS hole.
//     SVG therefore falls through to the text path, where it is returned as a
//     JSON string (or refused by the raw path) and never rendered as a
//     document.
//   - handleFileRead answers JSON only, so its body cannot be executed.
//   - handleFileRaw answers with a fixed raster image content type and refuses
//     everything else, so it cannot be used as a general file download.

import (
	"bytes"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

const (
	// fileProbeBytes is how much of a file is sampled to decide whether it is
	// text. 4 KB covers a shebang, a JSON head or a log preamble, and a NUL
	// byte almost always shows up well before it in a binary file.
	fileProbeBytes = 4096

	// fileTextMaxBytes caps the text carried in the JSON preview. A viewer
	// cannot use more than a quarter megabyte of log in one go, and the JSON
	// body stays small enough to hand to the browser in a single piece.
	fileTextMaxBytes = 256 << 10

	// fileRawMaxBytes caps one image stream. 16 MB is larger than any chart or
	// screenshot an agent realistically writes, and small enough that a browser
	// tab does not stall on it.
	fileRawMaxBytes = 16 << 20

	// fileInspectMaxBytes is the point past which handleFileRead refuses to look
	// at content at all: such a file is reported as "other" rather than probed
	// or sliced. The preview would be a 256 KB sliver of something enormous,
	// and skipping the read keeps one request from pulling a multi-gigabyte log
	// through memory. Images are still recognised by extension, which needs no
	// read, and handleFileRaw refuses them on its own 16 MB cap.
	fileInspectMaxBytes = 64 << 20

	kindImage = "image"
	kindText  = "text"
	kindOther = "other"
)

// imageContentTypes maps every extension this endpoint is willing to stream to
// its media type. It is also the definition of "kind: image". Extensions are
// matched lower-cased, so ".PNG" works.
//
// There is no ".svg" entry, on purpose — see the package comment above.
var imageContentTypes = map[string]string{
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".gif":  "image/gif",
	".webp": "image/webp",
	".bmp":  "image/bmp",
	".ico":  "image/vnd.microsoft.icon",
}

// previewFile is the shared result of the validation both handlers perform.
type previewFile struct {
	// path is the cleaned, symlink-resolved, absolute path of the regular file
	// that was judged. It is the path actually read, not the one requested.
	path string
	// info is the Stat of that resolved target.
	info os.FileInfo
}

// handleFileRead answers GET /api/v1/herdr/file?path=<absolute path> with a
// JSON description of the file and, for text, its first 256 KB.
//
// It has no Server receiver so the route table can register it directly.
func handleFileRead(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, "GET")
		return
	}
	file, ok := resolvePreviewFile(w, r)
	if !ok {
		return
	}
	kind := classifyFile(file.path, file.info)
	body := map[string]any{
		"path":  file.path,
		"name":  filepath.Base(file.path),
		"bytes": file.info.Size(),
		"kind":  kind,
	}
	// "text" and "truncated" are text-only: an image is fetched through
	// handleFileRaw, and "other" has no content worth carrying.
	if kind == kindText {
		text, truncated := readPreviewText(file.path, file.info.Size())
		body["text"] = text
		body["truncated"] = truncated
	}
	writeJSON(w, http.StatusOK, body)
}

// handleFileRaw streams one image's bytes, for an <img> or a download of a
// chart. Anything that is not one of the raster extensions above is refused
// with 415, so this is not a general file download.
//
// It has no Server receiver so the route table can register it directly.
func handleFileRaw(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, "GET")
		return
	}
	file, ok := resolvePreviewFile(w, r)
	if !ok {
		return
	}
	contentType, isImage := imageContentTypes[strings.ToLower(filepath.Ext(file.path))]
	if !isImage {
		writeError(w, http.StatusUnsupportedMediaType, "unsupported_media_type",
			"only image files can be streamed")
		return
	}
	// Checked from the Stat result before the file is opened, so an oversized
	// image is never read into memory.
	if file.info.Size() > fileRawMaxBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "too_large",
			"images are limited to 16 MB")
		return
	}
	handle, err := os.Open(file.path)
	if err != nil {
		writeError(w, http.StatusNotFound, "not_found", "file not found")
		return
	}
	defer func() { _ = handle.Close() }()

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", "inline")
	w.Header().Set("Cache-Control", "private, max-age=60")
	// The image is data, not a document: this stops a rendering of it from
	// loading anything else.
	w.Header().Set("Content-Security-Policy", "default-src 'none'")
	// ServeContent streams the file and sets Content-Length itself; it also
	// understands Range and If-Modified-Since, so a large chart is never
	// buffered in this process.
	http.ServeContent(w, r, filepath.Base(file.path), file.info.ModTime(), handle)
}

// resolvePreviewFile applies the read-only contract shared by both handlers and
// writes the error response itself, returning ok=false when it does.
//
// The type is judged with os.Stat (not Lstat) after EvalSymlinks, so a symlink
// is judged by its target. The handlers then open the resolved path; a file
// swapped in between Stat and Open is outside this endpoint's threat model,
// because the writer is the operator's own agent, not a remote client.
func resolvePreviewFile(w http.ResponseWriter, r *http.Request) (previewFile, bool) {
	raw := strings.TrimSpace(r.URL.Query().Get("path"))
	if raw == "" {
		writeError(w, http.StatusBadRequest, "invalid_request", "path is required")
		return previewFile{}, false
	}
	if !filepath.IsAbs(raw) {
		writeError(w, http.StatusBadRequest, "invalid_request", "path must be absolute")
		return previewFile{}, false
	}
	// Clean first so "..", duplicate slashes and a trailing slash do not change
	// what is judged. Absolute paths are the point: an agent reports the file
	// it just wrote, and this panel is a private control plane on a Tailscale
	// link, so a path may name any file on this host.
	path := filepath.Clean(raw)

	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		if os.IsNotExist(err) {
			writeError(w, http.StatusNotFound, "not_found", "file not found")
			return previewFile{}, false
		}
		writeError(w, http.StatusBadRequest, "invalid_request", "path could not be resolved")
		return previewFile{}, false
	}
	info, err := os.Stat(resolved)
	if err != nil {
		if os.IsNotExist(err) {
			writeError(w, http.StatusNotFound, "not_found", "file not found")
			return previewFile{}, false
		}
		writeError(w, http.StatusBadRequest, "invalid_request", "path is not a readable file")
		return previewFile{}, false
	}
	// Refused rather than opened: a fifo has no content until a writer appears,
	// a device can stream forever, and a directory is not a file.
	if !info.Mode().IsRegular() {
		writeError(w, http.StatusBadRequest, "invalid_request", "path is not a regular file")
		return previewFile{}, false
	}
	return previewFile{path: resolved, info: info}, true
}

// classifyFile decides the preview kind. Images are recognised by extension
// alone: that is enough to pick a renderer and needs no read. Text is decided
// by content, because an extension is only a claim and a log can be named
// anything or nothing.
func classifyFile(path string, info os.FileInfo) string {
	if _, ok := imageContentTypes[strings.ToLower(filepath.Ext(path))]; ok {
		return kindImage
	}
	if info.Size() > fileInspectMaxBytes {
		return kindOther
	}
	if looksLikeText(path, info.Size()) {
		return kindText
	}
	return kindOther
}

// looksLikeText samples the head of the file: no NUL byte and valid UTF-8
// (plain ASCII is a subset of it) means the browser can render it as text.
func looksLikeText(path string, size int64) bool {
	if size == 0 {
		// An empty file is a text file with nothing in it.
		return true
	}
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer func() { _ = file.Close() }()

	probe := make([]byte, fileProbeBytes)
	n, err := io.ReadFull(file, probe)
	if err != nil && err != io.EOF && err != io.ErrUnexpectedEOF {
		return false
	}
	probe = probe[:n]
	if bytes.IndexByte(probe, 0) >= 0 {
		return false
	}
	return validTextPrefix(probe, n == fileProbeBytes)
}

// validTextPrefix reports whether the probe is valid UTF-8. When the probe
// filled the whole buffer, its last bytes may be a multi-byte rune that the cut
// split in half; that is an artefact of sampling, not a property of the file,
// so a few trailing bytes are dropped before giving up. A short probe is never
// excused this way: the file genuinely ends there.
func validTextPrefix(probe []byte, cut bool) bool {
	if utf8.Valid(probe) {
		return true
	}
	if !cut {
		return false
	}
	for trim := 1; trim < utf8.UTFMax; trim++ {
		if utf8.Valid(probe[:len(probe)-trim]) {
			return true
		}
	}
	return false
}

// readPreviewText returns at most fileTextMaxBytes of the file. The truncation
// flag comes from the Stat size, so the answer says whether the file is longer
// than the preview even if the file changed under us.
func readPreviewText(path string, size int64) (string, bool) {
	file, err := os.Open(path)
	if err != nil {
		return "", size > fileTextMaxBytes
	}
	defer func() { _ = file.Close() }()

	data, err := io.ReadAll(io.LimitReader(file, fileTextMaxBytes))
	if err != nil && len(data) == 0 {
		return "", size > fileTextMaxBytes
	}
	return string(data), size > fileTextMaxBytes
}
