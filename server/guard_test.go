package server

import (
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newGuardFixture(t *testing.T) (http.Handler, string) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	return GuardRequests(next, []net.Listener{listener}), listener.Addr().String()
}

func guardRequest(t *testing.T, host, method, path, contentType, body string) *http.Request {
	t.Helper()
	request := httptest.NewRequest(method, "http://"+host+path, strings.NewReader(body))
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	return request
}

func guardStatus(handler http.Handler, request *http.Request) int {
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder.Code
}

func TestGuardAcceptsItsOwnListenerHost(t *testing.T) {
	handler, host := newGuardFixture(t)
	if status := guardStatus(handler, guardRequest(t, host, http.MethodGet, "/api/health", "", "")); status != http.StatusNoContent {
		t.Fatalf("own listener host: got %d, want %d", status, http.StatusNoContent)
	}
}

func TestGuardRefusesForeignAndRebindingHosts(t *testing.T) {
	handler, host := newGuardFixture(t)
	_, port, err := net.SplitHostPort(host)
	if err != nil {
		t.Fatal(err)
	}
	for _, foreign := range []string{
		"evil.example:" + port,
		"100.89.0.116.nip.io:" + port,
		"127.0.0.1:1",
	} {
		request := guardRequest(t, host, http.MethodGet, "/api/health", "", "")
		request.Host = foreign
		if status := guardStatus(handler, request); status != http.StatusForbidden {
			t.Errorf("Host %q: got %d, want %d", foreign, status, http.StatusForbidden)
		}
	}
}

func TestGuardAcceptsLocalAndTailnetNames(t *testing.T) {
	handler, host := newGuardFixture(t)
	_, port, err := net.SplitHostPort(host)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{
		"localhost:" + port,
		"m2max:" + port,
		"vm-4-43-ubuntu.tail1234.ts.net:" + port,
		"box.local:" + port,
	} {
		request := guardRequest(t, host, http.MethodGet, "/api/health", "", "")
		request.Host = name
		if status := guardStatus(handler, request); status != http.StatusNoContent {
			t.Errorf("Host %q: got %d, want %d", name, status, http.StatusNoContent)
		}
	}
}

func TestGuardAcceptsConfiguredHost(t *testing.T) {
	t.Setenv(allowedHostsEnv, "console.example.com")
	handler, host := newGuardFixture(t)
	_, port, err := net.SplitHostPort(host)
	if err != nil {
		t.Fatal(err)
	}
	request := guardRequest(t, host, http.MethodGet, "/api/health", "", "")
	request.Host = "console.example.com:" + port
	if status := guardStatus(handler, request); status != http.StatusNoContent {
		t.Fatalf("configured host: got %d, want %d", status, http.StatusNoContent)
	}
}

func TestGuardAcceptsSameOriginJSONMutation(t *testing.T) {
	handler, host := newGuardFixture(t)
	request := guardRequest(t, host, http.MethodPost, "/api/v1/fleet/hello", "application/json", "{}")
	request.Header.Set("Origin", "http://"+host)
	request.Header.Set("Sec-Fetch-Site", "same-origin")
	if status := guardStatus(handler, request); status != http.StatusNoContent {
		t.Fatalf("same-origin JSON: got %d, want %d", status, http.StatusNoContent)
	}
}

func TestGuardRefusesCrossOriginMutation(t *testing.T) {
	handler, host := newGuardFixture(t)
	for _, testCase := range []struct {
		name   string
		origin string
		site   string
	}{
		{name: "cross-site origin", origin: "http://evil.example", site: "cross-site"},
		{name: "same-site", origin: "http://" + host, site: "same-site"},
		{name: "null origin", origin: "null", site: "cross-site"},
		{name: "loopback cross-site", origin: "http://127.0.0.1:5175", site: "cross-site"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			request := guardRequest(t, host, http.MethodPost, "/api/v1/herdr-web/update", "application/json", `{"from":"http://evil.example"}`)
			request.Header.Set("Origin", testCase.origin)
			request.Header.Set("Sec-Fetch-Site", testCase.site)
			if status := guardStatus(handler, request); status != http.StatusForbidden {
				t.Fatalf("got %d, want %d", status, http.StatusForbidden)
			}
		})
	}
}

func TestGuardAcceptsLoopbackDevProxyOrigin(t *testing.T) {
	handler, host := newGuardFixture(t)
	request := guardRequest(t, host, http.MethodPost, "/api/v1/fleet/hello", "application/json", "{}")
	request.Header.Set("Origin", "http://127.0.0.1:5175")
	request.Header.Set("Sec-Fetch-Site", "same-origin")
	if status := guardStatus(handler, request); status != http.StatusNoContent {
		t.Fatalf("vite proxy origin: got %d, want %d", status, http.StatusNoContent)
	}
}

func TestGuardAcceptsConfiguredOriginName(t *testing.T) {
	t.Setenv(allowedHostsEnv, "console.example.com")
	handler, host := newGuardFixture(t)
	request := guardRequest(t, host, http.MethodPost, "/api/v1/fleet/hello", "application/json", "{}")
	request.Header.Set("Origin", "http://console.example.com")
	request.Header.Set("Sec-Fetch-Site", "same-origin")
	if status := guardStatus(handler, request); status != http.StatusNoContent {
		t.Fatalf("configured origin: got %d, want %d", status, http.StatusNoContent)
	}
}

func TestGuardRequiresJSONForAPIEnvelopes(t *testing.T) {
	handler, host := newGuardFixture(t)
	request := guardRequest(t, host, http.MethodPost, "/api/v1/fleet/hello", "text/plain", `{}`)
	request.Header.Set("Origin", "http://"+host)
	request.Header.Set("Sec-Fetch-Site", "same-origin")
	if status := guardStatus(handler, request); status != http.StatusUnsupportedMediaType {
		t.Fatalf("text/plain JSON endpoint: got %d, want %d", status, http.StatusUnsupportedMediaType)
	}
}

func TestGuardKeepsCLIClientsWorking(t *testing.T) {
	handler, host := newGuardFixture(t)
	request := guardRequest(t, host, http.MethodPost, "/api/v1/fleet/hello", "application/json", "{}")
	if status := guardStatus(handler, request); status != http.StatusNoContent {
		t.Fatalf("CLI JSON: got %d, want %d", status, http.StatusNoContent)
	}

	text := guardRequest(t, host, http.MethodPost, "/api/v1/fleet/hello", "text/plain", "{}")
	if status := guardStatus(handler, text); status != http.StatusUnsupportedMediaType {
		t.Fatalf("CLI text/plain: got %d, want %d", status, http.StatusUnsupportedMediaType)
	}
}

func TestGuardSkipsJSONForNonAPIAndUploads(t *testing.T) {
	handler, host := newGuardFixture(t)
	release := guardRequest(t, host, http.MethodPost, "/release/install.sh", "text/plain", "body")
	if status := guardStatus(handler, release); status != http.StatusNoContent {
		t.Fatalf("release upload: got %d, want %d", status, http.StatusNoContent)
	}

	upload := guardRequest(t, host, http.MethodPost, "/api/v1/herdr/uploads", "multipart/form-data; boundary=x", "--x--")
	upload.Header.Set("Origin", "http://"+host)
	upload.Header.Set("Sec-Fetch-Site", "same-origin")
	if status := guardStatus(handler, upload); status != http.StatusNoContent {
		t.Fatalf("multipart upload: got %d, want %d", status, http.StatusNoContent)
	}
}

func TestGuardAllowsBodylessMutation(t *testing.T) {
	handler, host := newGuardFixture(t)
	request := guardRequest(t, host, http.MethodPost, "/api/v1/herdr-web/rollback", "", "")
	request.Header.Set("Origin", "http://"+host)
	request.Header.Set("Sec-Fetch-Site", "same-origin")
	if status := guardStatus(handler, request); status != http.StatusNoContent {
		t.Fatalf("bodyless mutation: got %d, want %d", status, http.StatusNoContent)
	}
}

func TestGuardLetsReadsThrough(t *testing.T) {
	handler, host := newGuardFixture(t)
	request := guardRequest(t, host, http.MethodGet, "/api/v1/herdr/file?path=/etc/passwd", "", "")
	request.Header.Set("Origin", "http://evil.example")
	request.Header.Set("Sec-Fetch-Site", "cross-site")
	if status := guardStatus(handler, request); status != http.StatusNoContent {
		t.Fatalf("GET: got %d, want %d (reads are protected by Host and the absence of CORS)", status, http.StatusNoContent)
	}
}
