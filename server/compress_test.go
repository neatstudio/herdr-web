package server

import (
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func gzipTestHandler(body string, contentType string) http.Handler {
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", contentType)
		_, _ = io.WriteString(w, body)
	})
	return withGzip(inner)
}

func TestGzipCompressesTextWhenTheClientAsksForIt(t *testing.T) {
	body := strings.Repeat("the transcript of a working agent, at length. ", 200)
	request := httptest.NewRequest(http.MethodGet, "/api/v1/herdr/panes/w1:p1/read", nil)
	request.Header.Set("Accept-Encoding", "gzip")
	recorder := httptest.NewRecorder()
	gzipTestHandler(body, "application/json").ServeHTTP(recorder, request)

	if got := recorder.Header().Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("content-encoding = %q", got)
	}
	reader, err := gzip.NewReader(recorder.Body)
	if err != nil {
		t.Fatalf("gzip: %v", err)
	}
	decoded, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(decoded) != body {
		t.Fatalf("body did not round-trip")
	}
	if recorder.Body.Len() >= len(body)/2 {
		t.Fatalf("compressed %d bytes of %d", recorder.Body.Len(), len(body))
	}
}

func TestGzipLeavesUnaskedAndBinaryAlone(t *testing.T) {
	// No gzip in Accept-Encoding: the response must be exactly what the handler
	// wrote, because the client cannot decode anything else.
	body := strings.Repeat("plain ", 400)
	request := httptest.NewRequest(http.MethodGet, "/api/v1/herdr/status", nil)
	recorder := httptest.NewRecorder()
	gzipTestHandler(body, "text/plain").ServeHTTP(recorder, request)
	if recorder.Header().Get("Content-Encoding") != "" || recorder.Body.String() != body {
		t.Fatalf("unasked response was altered")
	}

	// A binary is already dense; compressing it wastes CPU and gains nothing.
	request = httptest.NewRequest(http.MethodGet, "/release/herdr-web-linux-amd64", nil)
	request.Header.Set("Accept-Encoding", "gzip")
	recorder = httptest.NewRecorder()
	gzipTestHandler(strings.Repeat("binary", 400), "application/octet-stream").ServeHTTP(recorder, request)
	if recorder.Header().Get("Content-Encoding") != "" {
		t.Fatalf("a binary was compressed")
	}
}

func TestGzipStreamsBinaryWithoutBufferingIt(t *testing.T) {
	// A release binary or a raw image must reach the client as it is written:
	// buffering it costs the whole file in memory per concurrent download.
	outer := httptest.NewRecorder()
	chunk := strings.Repeat("\x7fELF", 1024)
	var seenBeforeReturn int
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Length", "8192")
		_, _ = io.WriteString(w, chunk)
		seenBeforeReturn = outer.Body.Len()
		_, _ = io.WriteString(w, chunk)
	})
	request := httptest.NewRequest(http.MethodGet, "/release/herdr-web-linux-amd64", nil)
	request.Header.Set("Accept-Encoding", "gzip")
	withGzip(inner).ServeHTTP(outer, request)

	if seenBeforeReturn != len(chunk) {
		t.Fatalf("client had %d bytes mid-response, want %d (the body was buffered)", seenBeforeReturn, len(chunk))
	}
	if outer.Body.Len() != 2*len(chunk) || outer.Header().Get("Content-Encoding") != "" {
		t.Fatalf("body=%d encoding=%q", outer.Body.Len(), outer.Header().Get("Content-Encoding"))
	}
	if outer.Header().Get("Content-Length") != "8192" {
		t.Fatalf("content-length = %q, the handler's value must survive", outer.Header().Get("Content-Length"))
	}
}

func TestGzipKeepsTheStatusAndHeaders(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusTeapot)
		_, _ = io.WriteString(w, strings.Repeat("x", 4000))
	})
	request := httptest.NewRequest(http.MethodGet, "/api/v1/fleet", nil)
	request.Header.Set("Accept-Encoding", "gzip")
	recorder := httptest.NewRecorder()
	withGzip(inner).ServeHTTP(recorder, request)
	if recorder.Code != http.StatusTeapot || recorder.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("status = %d, cache-control = %q", recorder.Code, recorder.Header().Get("Cache-Control"))
	}
}

func TestGzipCachesBuildAssets(t *testing.T) {
	// The bundle is immutable and hashed: compressing it per page load is wasted
	// work on a small machine, and it is the one file nobody can avoid downloading.
	builds := 0
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		builds += 1
		w.Header().Set("Content-Type", "text/javascript")
		_, _ = io.WriteString(w, strings.Repeat("console.log(1);", 500))
	})
	handler := withGzip(inner)
	for attempt := 0; attempt < 3; attempt++ {
		request := httptest.NewRequest(http.MethodGet, "/assets/index-abc.js", nil)
		request.Header.Set("Accept-Encoding", "gzip")
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		if recorder.Header().Get("Content-Encoding") != "gzip" {
			t.Fatalf("attempt %d: not compressed", attempt)
		}
	}
	if builds != 1 {
		t.Fatalf("the asset was rebuilt %d times", builds)
	}
}
