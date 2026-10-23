package server

import (
	"bytes"
	"compress/gzip"
	"mime"
	"net/http"
	"path"
	"strconv"
	"strings"
	"sync"
)

// Compression for the console's own output.
//
// A phone on a tailnet relay measured 800 ms per round trip, and the uncompressed
// bundle took thirteen seconds to arrive. That is not a slow console, it is
// uncompressed bytes on a long link: text compresses about four to one, and pane
// reads — which are the bulk of every poll — are text as well.
const (
	// compressMinBytes is where saving the bytes stops being worth the header.
	compressMinBytes = 1024
	// compressedAssetCache bounds what is spent remembering compressed assets.
	compressedAssetCache = 32
)

// compressibleType lists what is worth compressing. Binaries are already dense, and
// release assets are served as-is on purpose.
func compressibleType(contentType string) bool {
	contentType = strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0]))
	if strings.HasPrefix(contentType, "text/") {
		return true
	}
	for _, kind := range []string{
		"application/javascript",
		"application/json",
		"application/xml",
		"application/manifest+json",
		"image/svg+xml",
	} {
		if contentType == kind {
			return true
		}
	}
	return false
}

// gzipHandler compresses what the client asked to compress, and only that.
type gzipHandler struct {
	next http.Handler
	mu   sync.Mutex
	// assets keeps the compressed form of immutable build files by path.
	assets map[string][]byte
	order  []string
}

func withGzip(next http.Handler) http.Handler {
	return &gzipHandler{next: next, assets: map[string][]byte{}}
}

func (g *gzipHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") || r.Method == http.MethodHead {
		g.next.ServeHTTP(w, r)
		return
	}
	if g.serveCachedAsset(w, r) {
		return
	}

	recorder := &compressRecorder{header: http.Header{}, status: http.StatusOK}
	g.next.ServeHTTP(recorder, r)

	contentType := recorder.header.Get("Content-Type")
	if !compressibleType(contentType) || len(recorder.body) < compressMinBytes {
		// Small or already dense: the buffered copy is sent unchanged.
		writeBuffered(w, recorder)
		return
	}
	recorder.header.Del("Content-Length")
	g.writeCompressed(w, recorder.status, recorder.header, gzipBytes(recorder.body), contentType)
}

// serveCachedAsset answers an immutable build file from memory, compressing it once.
// It reports whether it handled the request at all.
func (g *gzipHandler) serveCachedAsset(w http.ResponseWriter, r *http.Request) bool {
	if r.Method != http.MethodGet || !strings.HasPrefix(r.URL.Path, "/assets/") {
		return false
	}
	g.mu.Lock()
	data, found := g.assets[r.URL.Path]
	if !found {
		g.mu.Unlock()
	}
	if found {
		g.mu.Unlock()
		g.writeCompressed(w, http.StatusOK, nil, data, contentTypeForAsset(r.URL.Path))
		return true
	}

	recorder := &compressRecorder{header: http.Header{}, status: http.StatusOK}
	g.next.ServeHTTP(recorder, r)
	if recorder.status != http.StatusOK || len(recorder.body) < compressMinBytes {
		writeBuffered(w, recorder)
		return true
	}
	compressed := gzipBytes(recorder.body)

	g.mu.Lock()
	g.assets[r.URL.Path] = compressed
	g.order = append(g.order, r.URL.Path)
	if len(g.order) > compressedAssetCache {
		delete(g.assets, g.order[0])
		g.order = g.order[1:]
	}
	g.mu.Unlock()

	g.writeCompressed(w, recorder.status, recorder.header, compressed, contentTypeForAsset(r.URL.Path))
	return true
}

// w is the response the request arrived with, kept so the cache miss and the cache
// hit take the same path.
type responseWriterFunc func(*http.Request) http.ResponseWriter

func (g *gzipHandler) writeCompressed(w http.ResponseWriter, status int, header http.Header, data []byte, contentType string) {
	if header != nil {
		copyHeaders(w, header)
	}
	if contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}
	w.Header().Set("Content-Encoding", "gzip")
	w.Header().Set("Vary", "Accept-Encoding")
	w.Header().Del("Content-Length")
	w.WriteHeader(status)
	_, _ = w.Write(data)
}

func gzipBytes(data []byte) []byte {
	var buffer bytes.Buffer
	writer := gzip.NewWriter(&buffer)
	_, _ = writer.Write(data)
	_ = writer.Close()
	return buffer.Bytes()
}

func contentTypeForAsset(name string) string {
	extension := path.Ext(name)
	if contentType := mime.TypeByExtension(extension); contentType != "" {
		return contentType
	}
	switch extension {
	case ".js":
		return "text/javascript; charset=utf-8"
	case ".css":
		return "text/css; charset=utf-8"
	case ".svg":
		return "image/svg+xml"
	case ".woff2":
		return "font/woff2"
	default:
		return ""
	}
}

func copyHeaders(w http.ResponseWriter, header http.Header) {
	for key, value := range header {
		if strings.EqualFold(key, "Content-Length") {
			continue
		}
		for _, item := range value {
			w.Header().Add(key, item)
		}
	}
}

// compressRecorder buffers a handler's response so the middleware can decide
// whether compressing it is worth anything.
type compressRecorder struct {
	header      http.Header
	status      int
	body        []byte
	wroteHeader bool
}

func (c *compressRecorder) Header() http.Header { return c.header }

func (c *compressRecorder) WriteHeader(status int) {
	if c.wroteHeader {
		return
	}
	c.status = status
	c.wroteHeader = true
}

func (c *compressRecorder) Write(data []byte) (int, error) {
	if !c.wroteHeader {
		c.WriteHeader(http.StatusOK)
	}
	c.body = append(c.body, data...)
	return len(data), nil
}

// writeBuffered sends the buffered response unchanged.
func writeBuffered(w http.ResponseWriter, recorder *compressRecorder) {
	copyHeaders(w, recorder.header)
	w.Header().Set("Content-Length", strconv.Itoa(len(recorder.body)))
	w.WriteHeader(recorder.status)
	_, _ = w.Write(recorder.body)
}
