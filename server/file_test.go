package server

import (
	"bytes"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
)

// onePixelPNG is a real 1×1 PNG, so the image tests exercise bytes a browser
// would actually accept rather than an arbitrary blob with a .png name.
const onePixelPNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

type fileHandlerFunc func(http.ResponseWriter, *http.Request)

func pngBytes(t *testing.T) []byte {
	t.Helper()
	data, err := base64.StdEncoding.DecodeString(onePixelPNG)
	if err != nil {
		t.Fatalf("decode 1x1 png: %v", err)
	}
	return data
}

// resolvedTempDir is t.TempDir with symlinks already resolved. On macOS the
// temp dir lives under /var, which is a symlink to /private/var, so the
// handler's EvalSymlinks result would otherwise not equal the path the test
// joined itself.
func resolvedTempDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	resolved, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatalf("resolve temp dir: %v", err)
	}
	return resolved
}

func writeTempFile(t *testing.T, dir, name string, data []byte) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
	return path
}

// fileQuery builds a read/raw request target for an absolute path.
func fileQuery(path string) string {
	return "/api/v1/herdr/file?path=" + url.QueryEscape(path)
}

func callFileHandler(t *testing.T, handler fileHandlerFunc, method, target string) *httptest.ResponseRecorder {
	t.Helper()
	response := httptest.NewRecorder()
	handler(response, httptest.NewRequest(method, target, nil))
	return response
}

func requireNosniff(t *testing.T, response *httptest.ResponseRecorder) {
	t.Helper()
	if got := response.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Errorf("X-Content-Type-Options = %q, want nosniff", got)
	}
}

func TestFileReadImage(t *testing.T) {
	dir := resolvedTempDir(t)
	data := pngBytes(t)
	path := writeTempFile(t, dir, "chart.png", data)

	response := callFileHandler(t, handleFileRead, http.MethodGet, fileQuery(path))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body %s", response.Code, response.Body.String())
	}
	requireNosniff(t, response)

	body := decodeMap(t, response)
	if body["kind"] != "image" {
		t.Errorf("kind = %v, want image", body["kind"])
	}
	if body["bytes"] != float64(len(data)) {
		t.Errorf("bytes = %v, want %d", body["bytes"], len(data))
	}
	if body["path"] != path {
		t.Errorf("path = %v, want %s", body["path"], path)
	}
	if body["name"] != "chart.png" {
		t.Errorf("name = %v, want chart.png", body["name"])
	}
	if _, ok := body["text"]; ok {
		t.Errorf("image response must not carry text, got %v", body["text"])
	}
	if _, ok := body["truncated"]; ok {
		t.Errorf("image response must not carry truncated, got %v", body["truncated"])
	}
}

func TestFileRawImage(t *testing.T) {
	dir := resolvedTempDir(t)
	data := pngBytes(t)
	path := writeTempFile(t, dir, "chart.png", data)

	response := callFileHandler(t, handleFileRaw, http.MethodGet, fileQuery(path))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body %s", response.Code, response.Body.String())
	}
	requireNosniff(t, response)
	want := map[string]string{
		"Content-Type":            "image/png",
		"Content-Disposition":     "inline",
		"Content-Length":          strconv.Itoa(len(data)),
		"Cache-Control":           "private, max-age=60",
		"Content-Security-Policy": "default-src 'none'",
	}
	for header, value := range want {
		if got := response.Header().Get(header); got != value {
			t.Errorf("%s = %q, want %q", header, got, value)
		}
	}
	if !bytes.Equal(response.Body.Bytes(), data) {
		t.Errorf("raw body = %d bytes, want the %d file bytes", response.Body.Len(), len(data))
	}
}

func TestFileReadTextAndRawRefused(t *testing.T) {
	dir := resolvedTempDir(t)
	content := "hello herdr\nsecond line\n"
	path := writeTempFile(t, dir, "build.log", []byte(content))

	response := callFileHandler(t, handleFileRead, http.MethodGet, fileQuery(path))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body %s", response.Code, response.Body.String())
	}
	requireNosniff(t, response)
	body := decodeMap(t, response)
	if body["kind"] != "text" {
		t.Errorf("kind = %v, want text", body["kind"])
	}
	if body["text"] != content {
		t.Errorf("text = %q, want %q", body["text"], content)
	}
	if body["truncated"] != false {
		t.Errorf("truncated = %v, want false", body["truncated"])
	}

	raw := callFileHandler(t, handleFileRaw, http.MethodGet, fileQuery(path))
	if raw.Code != http.StatusUnsupportedMediaType {
		t.Errorf("raw status = %d, want 415; body %s", raw.Code, raw.Body.String())
	}
	requireNosniff(t, raw)
}

func TestFileReadBinaryIsOther(t *testing.T) {
	dir := resolvedTempDir(t)
	path := writeTempFile(t, dir, "blob.dat", []byte{0x00, 0x01, 0x02, 0xff, 0xfe})

	response := callFileHandler(t, handleFileRead, http.MethodGet, fileQuery(path))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body %s", response.Code, response.Body.String())
	}
	body := decodeMap(t, response)
	if body["kind"] != "other" {
		t.Errorf("kind = %v, want other", body["kind"])
	}
	if _, ok := body["text"]; ok {
		t.Errorf("non-text response must not carry text, got %v", body["text"])
	}
}

func TestFileReadTextTruncatedAtCap(t *testing.T) {
	dir := resolvedTempDir(t)
	content := strings.Repeat("a", fileTextMaxBytes+4096)
	path := writeTempFile(t, dir, "big.log", []byte(content))

	response := callFileHandler(t, handleFileRead, http.MethodGet, fileQuery(path))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body %s", response.Code, response.Body.String())
	}
	body := decodeMap(t, response)
	if body["kind"] != "text" {
		t.Fatalf("kind = %v, want text", body["kind"])
	}
	if body["truncated"] != true {
		t.Errorf("truncated = %v, want true", body["truncated"])
	}
	if body["bytes"] != float64(len(content)) {
		t.Errorf("bytes = %v, want %d", body["bytes"], len(content))
	}
	text, _ := body["text"].(string)
	if len(text) != fileTextMaxBytes {
		t.Errorf("text = %d bytes, want the %d byte cap", len(text), fileTextMaxBytes)
	}
	if !strings.HasPrefix(content, text) {
		t.Error("truncated text is not the prefix of the file")
	}
}

// A file past the inspect cap is reported as "other" without reading its
// content: the head of this one is plain ASCII, so a handler that probed it
// would have called it text.
func TestFileReadSkipsHugeFiles(t *testing.T) {
	dir := resolvedTempDir(t)
	path := filepath.Join(dir, "huge.log")
	file, err := os.Create(path)
	if err != nil {
		t.Fatalf("create huge file: %v", err)
	}
	if _, err := file.Write(bytes.Repeat([]byte("a"), fileProbeBytes)); err != nil {
		t.Fatalf("write head: %v", err)
	}
	if err := file.Truncate(fileInspectMaxBytes + 1); err != nil {
		t.Fatalf("truncate: %v", err)
	}
	if err := file.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	response := callFileHandler(t, handleFileRead, http.MethodGet, fileQuery(path))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body %s", response.Code, response.Body.String())
	}
	body := decodeMap(t, response)
	if body["kind"] != "other" {
		t.Errorf("kind = %v, want other for a file past the inspect cap", body["kind"])
	}
	if _, ok := body["text"]; ok {
		t.Errorf("huge file must not carry text, got %d bytes", len(body["text"].(string)))
	}
	if body["bytes"] != float64(fileInspectMaxBytes+1) {
		t.Errorf("bytes = %v, want %d", body["bytes"], fileInspectMaxBytes+1)
	}
}

func TestFileRawRejectsOversizeImage(t *testing.T) {
	dir := resolvedTempDir(t)
	path := filepath.Join(dir, "huge.png")
	file, err := os.Create(path)
	if err != nil {
		t.Fatalf("create oversized image: %v", err)
	}
	if err := file.Truncate(fileRawMaxBytes + 1); err != nil {
		t.Fatalf("truncate: %v", err)
	}
	if err := file.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	response := callFileHandler(t, handleFileRaw, http.MethodGet, fileQuery(path))
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("status = %d, want 413; body %s", response.Code, response.Body.String())
	}
	requireNosniff(t, response)

	// The JSON path still describes it, since it recognises the extension
	// without reading the file.
	read := callFileHandler(t, handleFileRead, http.MethodGet, fileQuery(path))
	if read.Code != http.StatusOK {
		t.Fatalf("read status = %d, want 200", read.Code)
	}
	body := decodeMap(t, read)
	if body["kind"] != "image" {
		t.Errorf("kind = %v, want image", body["kind"])
	}
	if _, ok := body["text"]; ok {
		t.Error("an oversized image must not carry text")
	}
}

func TestFileReadRefusesDirectoryAndFifo(t *testing.T) {
	dir := resolvedTempDir(t)

	t.Run("directory", func(t *testing.T) {
		sub := filepath.Join(dir, "logs")
		if err := os.Mkdir(sub, 0o700); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		response := callFileHandler(t, handleFileRead, http.MethodGet, fileQuery(sub))
		if response.Code != http.StatusBadRequest {
			t.Errorf("status = %d, want 400; body %s", response.Code, response.Body.String())
		}
		requireNosniff(t, response)
	})

	t.Run("fifo", func(t *testing.T) {
		fifo := filepath.Join(dir, "pipe")
		if err := syscall.Mkfifo(fifo, 0o600); err != nil {
			t.Skipf("mkfifo unavailable on this host: %v", err)
		}
		response := callFileHandler(t, handleFileRead, http.MethodGet, fileQuery(fifo))
		if response.Code != http.StatusBadRequest {
			t.Errorf("read status = %d, want 400; body %s", response.Code, response.Body.String())
		}
		requireNosniff(t, response)
		raw := callFileHandler(t, handleFileRaw, http.MethodGet, fileQuery(fifo))
		if raw.Code != http.StatusBadRequest {
			t.Errorf("raw status = %d, want 400; body %s", raw.Code, raw.Body.String())
		}
	})

	t.Run("device", func(t *testing.T) {
		if _, err := os.Stat("/dev/null"); err != nil {
			t.Skipf("no /dev/null on this host: %v", err)
		}
		// /dev/zero would stream forever; a device has to be refused before it
		// is opened, which the Stat-based check does.
		response := callFileHandler(t, handleFileRead, http.MethodGet, fileQuery("/dev/zero"))
		if response.Code != http.StatusBadRequest {
			t.Errorf("device status = %d, want 400; body %s", response.Code, response.Body.String())
		}
		// A symlink to a device is judged by its target, so the .png name on
		// the link does not make it an image.
		link := filepath.Join(dir, "device.png")
		if err := os.Symlink("/dev/zero", link); err != nil {
			t.Skipf("symlinks unavailable on this host: %v", err)
		}
		response = callFileHandler(t, handleFileRead, http.MethodGet, fileQuery(link))
		if response.Code != http.StatusBadRequest {
			t.Errorf("device symlink status = %d, want 400; body %s", response.Code, response.Body.String())
		}
		raw := callFileHandler(t, handleFileRaw, http.MethodGet, fileQuery(link))
		if raw.Code != http.StatusBadRequest {
			t.Errorf("device symlink raw status = %d, want 400; body %s", raw.Code, raw.Body.String())
		}
	})
}

func TestFileResolvesSymlinks(t *testing.T) {
	dir := resolvedTempDir(t)
	data := pngBytes(t)
	target := writeTempFile(t, dir, "real.png", data)

	link := filepath.Join(dir, "linked.png")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlinks unavailable on this host: %v", err)
	}

	response := callFileHandler(t, handleFileRead, http.MethodGet, fileQuery(link))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body %s", response.Code, response.Body.String())
	}
	body := decodeMap(t, response)
	if body["kind"] != "image" {
		t.Errorf("kind = %v, want image", body["kind"])
	}
	if body["path"] != target {
		t.Errorf("path = %v, want the resolved target %s", body["path"], target)
	}

	raw := callFileHandler(t, handleFileRaw, http.MethodGet, fileQuery(link))
	if raw.Code != http.StatusOK {
		t.Fatalf("raw status = %d, want 200; body %s", raw.Code, raw.Body.String())
	}
	if !bytes.Equal(raw.Body.Bytes(), data) {
		t.Error("raw body did not match the resolved image")
	}

	// A symlink to a directory is a directory, and is refused.
	sub := filepath.Join(dir, "adir")
	if err := os.Mkdir(sub, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	dirLink := filepath.Join(dir, "dirlink")
	if err := os.Symlink(sub, dirLink); err != nil {
		t.Fatalf("symlink to dir: %v", err)
	}
	response = callFileHandler(t, handleFileRead, http.MethodGet, fileQuery(dirLink))
	if response.Code != http.StatusBadRequest {
		t.Errorf("symlink-to-directory status = %d, want 400; body %s", response.Code, response.Body.String())
	}
}

func TestFileRejectsBadPaths(t *testing.T) {
	dir := resolvedTempDir(t)
	cases := []struct {
		name   string
		target string
		want   int
	}{
		{"empty", "/api/v1/herdr/file", http.StatusBadRequest},
		{"blank", "/api/v1/herdr/file?path=%20%20", http.StatusBadRequest},
		{"relative", fileQuery("relative/log.txt"), http.StatusBadRequest},
		{"relative-dots", fileQuery("../etc/passwd"), http.StatusBadRequest},
		{"missing", fileQuery(filepath.Join(dir, "nope.txt")), http.StatusNotFound},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			response := callFileHandler(t, handleFileRead, http.MethodGet, tc.target)
			if response.Code != tc.want {
				t.Errorf("status = %d, want %d; body %s", response.Code, tc.want, response.Body.String())
			}
			requireNosniff(t, response)
			raw := callFileHandler(t, handleFileRaw, http.MethodGet, tc.target)
			if raw.Code != tc.want {
				t.Errorf("raw status = %d, want %d; body %s", raw.Code, tc.want, raw.Body.String())
			}
		})
	}
}

func TestFileSVGIsTextNotImage(t *testing.T) {
	dir := resolvedTempDir(t)
	svg := `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`
	path := writeTempFile(t, dir, "chart.svg", []byte(svg))

	response := callFileHandler(t, handleFileRead, http.MethodGet, fileQuery(path))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body %s", response.Code, response.Body.String())
	}
	body := decodeMap(t, response)
	if body["kind"] != "text" {
		t.Fatalf("kind = %v, want text: SVG must never be served as an image", body["kind"])
	}
	if body["text"] != svg {
		t.Errorf("text = %q, want %q", body["text"], svg)
	}

	raw := callFileHandler(t, handleFileRaw, http.MethodGet, fileQuery(path))
	if raw.Code != http.StatusUnsupportedMediaType {
		t.Errorf("raw status = %d, want 415; body %s", raw.Code, raw.Body.String())
	}
	requireNosniff(t, raw)
}

func TestFileRejectsNonGet(t *testing.T) {
	dir := resolvedTempDir(t)
	path := writeTempFile(t, dir, "chart.png", pngBytes(t))

	handlers := map[string]fileHandlerFunc{"read": handleFileRead, "raw": handleFileRaw}
	for name, handler := range handlers {
		for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete} {
			t.Run(name+"/"+method, func(t *testing.T) {
				response := callFileHandler(t, handler, method, fileQuery(path))
				if response.Code != http.StatusMethodNotAllowed {
					t.Fatalf("status = %d, want 405; body %s", response.Code, response.Body.String())
				}
				if got := response.Header().Get("Allow"); got != "GET" {
					t.Errorf("Allow = %q, want GET", got)
				}
				requireNosniff(t, response)
			})
		}
	}
}
