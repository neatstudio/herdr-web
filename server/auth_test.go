package server

import (
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
)

func tokenTestHandler(t *testing.T) (http.Handler, string) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	console := NewServer("", testWebFS())
	return GuardRequests(console.Handler(), []net.Listener{listener}), listener.Addr().String()
}

func tokenRequest(t *testing.T, handler http.Handler, host, method, path string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, "http://"+host+path, nil)
	request.Host = host
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func TestConsoleTokenGuardsAPI(t *testing.T) {
	t.Setenv(consoleTokenEnv, "secret")
	handler, host := tokenTestHandler(t)
	path := "/api/v1/herdr/jobs/ledger"

	if response := tokenRequest(t, handler, host, http.MethodGet, path, nil); response.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous = %d: %s", response.Code, response.Body.String())
	}
	if response := tokenRequest(t, handler, host, http.MethodGet, path, map[string]string{"Authorization": "Bearer wrong"}); response.Code != http.StatusUnauthorized {
		t.Fatalf("wrong token = %d", response.Code)
	}
	if response := tokenRequest(t, handler, host, http.MethodGet, path, map[string]string{"Authorization": "Bearer secret"}); response.Code != http.StatusOK {
		t.Fatalf("bearer = %d: %s", response.Code, response.Body.String())
	}
	if response := tokenRequest(t, handler, host, http.MethodGet, path, map[string]string{"X-Herdr-Token": "secret"}); response.Code != http.StatusOK {
		t.Fatalf("header = %d: %s", response.Code, response.Body.String())
	}
	request := httptest.NewRequest(http.MethodGet, "http://"+host+path, nil)
	request.Host = host
	request.AddCookie(&http.Cookie{Name: "herdr_web_token", Value: "secret"})
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("cookie = %d: %s", response.Code, response.Body.String())
	}
}

func TestConsoleTokenLeavesHealthAndWebhooksOpen(t *testing.T) {
	t.Setenv(consoleTokenEnv, "secret")
	handler, host := tokenTestHandler(t)

	if response := tokenRequest(t, handler, host, http.MethodGet, "/api/health", nil); response.Code != http.StatusOK {
		t.Fatalf("health = %d: %s", response.Code, response.Body.String())
	}
	if response := tokenRequest(t, handler, host, http.MethodPost, "/api/v1/webhooks/github", map[string]string{"Content-Type": "application/json"}); response.Code == http.StatusUnauthorized {
		t.Fatalf("webhook was token-rejected: %d", response.Code)
	}
}

func TestConsoleTokenOffByDefault(t *testing.T) {
	t.Setenv(consoleTokenEnv, "")
	handler, host := tokenTestHandler(t)
	if response := tokenRequest(t, handler, host, http.MethodGet, "/api/v1/herdr/jobs/ledger", nil); response.Code != http.StatusOK {
		t.Fatalf("default = %d: %s", response.Code, response.Body.String())
	}
}

func TestConsoleAuthSetsCookie(t *testing.T) {
	t.Setenv(consoleTokenEnv, "secret")
	handler, host := tokenTestHandler(t)
	request := httptest.NewRequest(http.MethodGet, "http://"+host+"/auth?token=secret", nil)
	request.Host = host
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusFound {
		t.Fatalf("auth = %d: %s", response.Code, response.Body.String())
	}
	found := false
	for _, cookie := range response.Result().Cookies() {
		if cookie.Name == "herdr_web_token" && cookie.Value == "secret" && cookie.HttpOnly {
			found = true
		}
	}
	if !found {
		t.Fatalf("cookies = %+v", response.Result().Cookies())
	}

	bad := httptest.NewRequest(http.MethodGet, "http://"+host+"/auth?token=wrong", nil)
	bad.Host = host
	badResponse := httptest.NewRecorder()
	handler.ServeHTTP(badResponse, bad)
	if badResponse.Code != http.StatusUnauthorized {
		t.Fatalf("bad auth = %d", badResponse.Code)
	}
}

func TestSameOriginBrowserNeedsNoToken(t *testing.T) {
	t.Setenv(consoleTokenEnv, "secret")
	t.Setenv(browserTokenEnv, "")
	handler, host := tokenTestHandler(t)
	path := "/api/v1/herdr/jobs/ledger"

	for name, headers := range map[string]map[string]string{
		"sec-fetch-site": {"Sec-Fetch-Site": "same-origin"},
		"origin":         {"Origin": "http://" + host},
		"both":           {"Sec-Fetch-Site": "same-origin", "Origin": "http://" + host},
	} {
		if response := tokenRequest(t, handler, host, http.MethodGet, path, headers); response.Code != http.StatusOK {
			t.Fatalf("%s = %d: %s", name, response.Code, response.Body.String())
		}
	}
	if response := tokenRequest(t, handler, host, http.MethodGet, path, map[string]string{"Sec-Fetch-Site": "cross-site"}); response.Code != http.StatusUnauthorized {
		t.Fatalf("cross-site = %d", response.Code)
	}
	if response := tokenRequest(t, handler, host, http.MethodGet, path, map[string]string{"Sec-Fetch-Site": "same-site"}); response.Code != http.StatusUnauthorized {
		t.Fatalf("same-site = %d", response.Code)
	}
	if response := tokenRequest(t, handler, host, http.MethodGet, path, nil); response.Code != http.StatusUnauthorized {
		t.Fatalf("script = %d", response.Code)
	}
}

func TestSameOriginBrowserCanBeRequired(t *testing.T) {
	t.Setenv(consoleTokenEnv, "secret")
	t.Setenv(browserTokenEnv, "require")
	handler, host := tokenTestHandler(t)
	path := "/api/v1/herdr/jobs/ledger"

	if response := tokenRequest(t, handler, host, http.MethodGet, path, map[string]string{"Sec-Fetch-Site": "same-origin"}); response.Code != http.StatusUnauthorized {
		t.Fatalf("strict browser = %d", response.Code)
	}
	if response := tokenRequest(t, handler, host, http.MethodGet, path, map[string]string{"Sec-Fetch-Site": "same-origin", "Authorization": "Bearer secret"}); response.Code != http.StatusOK {
		t.Fatalf("strict bearer = %d", response.Code)
	}
}

func TestTrustedNetworkNeedsNoToken(t *testing.T) {
	t.Setenv(consoleTokenEnv, "secret")
	t.Setenv(trustedNetsEnv, "100.89.0.0/16")
	handler, host := tokenTestHandler(t)
	path := "/api/v1/herdr/jobs/ledger"

	trusted := httptest.NewRequest(http.MethodGet, "http://"+host+path, nil)
	trusted.Host = host
	trusted.RemoteAddr = "100.89.0.42:51234"
	trustedResponse := httptest.NewRecorder()
	handler.ServeHTTP(trustedResponse, trusted)
	if trustedResponse.Code != http.StatusOK {
		t.Fatalf("trusted = %d: %s", trustedResponse.Code, trustedResponse.Body.String())
	}

	outside := httptest.NewRequest(http.MethodGet, "http://"+host+path, nil)
	outside.Host = host
	outside.RemoteAddr = "100.90.0.42:51234"
	outsideResponse := httptest.NewRecorder()
	handler.ServeHTTP(outsideResponse, outside)
	if outsideResponse.Code != http.StatusUnauthorized {
		t.Fatalf("outside = %d", outsideResponse.Code)
	}
}

func TestTrustedNetworkRequiresConfiguration(t *testing.T) {
	t.Setenv(consoleTokenEnv, "secret")
	t.Setenv(trustedNetsEnv, "")
	handler, host := tokenTestHandler(t)
	request := httptest.NewRequest(http.MethodGet, "http://"+host+"/api/v1/herdr/jobs/ledger", nil)
	request.Host = host
	request.RemoteAddr = "100.89.0.42:51234"
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unconfigured trusted net = %d", response.Code)
	}
}
