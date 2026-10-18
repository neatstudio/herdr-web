package server

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"
)

// UploadLimit caps one request. Images and screenshots are the point, and they
// are large, but a pane prompt is not a file server.
const UploadLimit = 32 << 20

// uploadRoot is where attachments are written: beside herdr-web's own state,
// so a restart or an update never takes the operator's files with it.
func uploadRoot() string {
	if dir := os.Getenv("HERDR_WEB_UPLOAD_DIR"); dir != "" {
		return dir
	}
	if home, err := os.UserHomeDir(); err == nil {
		return filepath.Join(home, ".local", "share", "herdr-web", "uploads")
	}
	return filepath.Join(os.TempDir(), "herdr-web-uploads")
}

// safeName reduces a client-supplied filename to something that can only ever
// name a file inside the upload directory, and to something that survives being
// pasted into a shell or a prompt: no separators, no parent hops, no control
// characters, no whitespace, no shell metacharacters, and never empty.
func safeName(name string) string {
	name = strings.ReplaceAll(name, "\\", "/")
	name = name[strings.LastIndex(name, "/")+1:]
	var kept []rune
	for _, r := range name {
		switch {
		case r < 0x20 || r == 0x7f:
			// Control characters would end up in a shell word.
		case r == '/' || r == '\\':
		case unicode.IsSpace(r):
			// A path with a space is several words to whatever it is pasted
			// into; the stored name stays one word so the path needs no quoting.
			kept = append(kept, '_')
		case strings.ContainsRune(`"'`+"`$;&|<>*?()[]{}!#~", r):
			kept = append(kept, '_')
		default:
			kept = append(kept, r)
		}
	}
	cleaned := strings.Trim(string(kept), " ._")
	if cleaned == "" {
		cleaned = "attachment"
	}
	if len(cleaned) > 96 {
		// Keep the extension, which is what tells an agent how to read it.
		ext := filepath.Ext(cleaned)
		keep := 96 - len(ext)
		if keep < 1 {
			keep = 1
		}
		cleaned = cleaned[:keep] + ext
	}
	return cleaned
}

func newUploadName(name string) string {
	var buf [4]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return fmt.Sprintf("%d-%s", time.Now().UnixNano(), name)
	}
	return time.Now().Format("20060102-150405") + "-" + hex.EncodeToString(buf[:]) + "-" + name
}

// handleUpload stores one attachment and answers with the absolute path on
// this host. That path is the whole point: herdr can only send text, so the way
// to hand an agent an image is to hand it the file, exactly as dragging a file
// into a terminal does.
func (s *Server) handleUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, "POST")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, UploadLimit+1<<20)
	if err := r.ParseMultipartForm(UploadLimit); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "expected a multipart form")
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "a file field is required")
		return
	}
	defer func() { _ = file.Close() }()

	written, path, err := storeUpload(file, header.Filename)
	if err != nil {
		if errors.Is(err, errTooLarge) {
			writeError(w, http.StatusRequestEntityTooLarge, "too_large",
				fmt.Sprintf("attachments are limited to %d MB", UploadLimit>>20))
			return
		}
		writeError(w, http.StatusInternalServerError, "upload_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":    true,
		"path":  path,
		"name":  filepath.Base(path),
		"bytes": written,
		"kind":  header.Header.Get("Content-Type"),
	})
}

var errTooLarge = errors.New("attachment too large")

// storeUpload writes the stream to a fresh file, keeping the original
// extension because that is how an agent decides how to read the file.
func storeUpload(src multipart.File, original string) (int64, string, error) {
	root := uploadRoot()
	if err := os.MkdirAll(root, 0o700); err != nil {
		return 0, "", err
	}
	tmp, err := os.CreateTemp(root, ".incoming-*")
	if err != nil {
		return 0, "", err
	}
	defer func() {
		_ = tmp.Close()
		// Remove on every failure path; a successful rename has already moved it.
		_ = os.Remove(tmp.Name())
	}()

	written, err := io.Copy(tmp, io.LimitReader(src, UploadLimit+1))
	if err != nil {
		return 0, "", err
	}
	if written > UploadLimit {
		return 0, "", errTooLarge
	}
	if err := tmp.Sync(); err != nil {
		return 0, "", err
	}
	final := filepath.Join(root, newUploadName(safeName(original)))
	if err := os.Rename(tmp.Name(), final); err != nil {
		return 0, "", err
	}
	return written, final, nil
}
