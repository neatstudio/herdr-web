package server

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGitHubWebhookCreatesTask(t *testing.T) {
	isolateState(t)
	t.Setenv("TEST_WEBHOOK_SECRET", "secret")
	console := NewServer("", nil)
	if _, err := console.repos.Add(Repo{
		Provider: "github", BaseURL: "https://api.github.com", Owner: "acme", Name: "app",
		Checkout: "/repo", TokenEnv: "TEST_GITHUB_TOKEN", WebhookSecretEnv: "TEST_WEBHOOK_SECRET",
	}); err != nil {
		t.Fatal(err)
	}
	body := `{"action":"opened","repository":{"full_name":"acme/app"},"issue":{"number":7,"title":"Fix","body":"Details"}}`
	mac := hmac.New(sha256.New, []byte("secret"))
	_, _ = mac.Write([]byte(body))
	signature := "sha256=" + hex.EncodeToString(mac.Sum(nil))

	post := func(sig string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, "/api/v1/webhooks/github", strings.NewReader(body))
		request.Header.Set("X-GitHub-Event", "issues")
		request.Header.Set("X-Hub-Signature-256", sig)
		recorder := httptest.NewRecorder()
		console.Handler().ServeHTTP(recorder, request)
		return recorder
	}

	if bad := post("sha256=deadbeef"); bad.Code != http.StatusUnauthorized {
		t.Fatalf("bad signature = %d", bad.Code)
	}
	good := post(signature)
	if good.Code != http.StatusCreated {
		t.Fatalf("webhook = %d: %s", good.Code, good.Body.String())
	}
	task, err := console.sharedLedger.Get(t.Context(), "github:acme/app#7")
	if err != nil {
		t.Fatal(err)
	}
	if task.Issue != 7 || task.Repo != "github:acme/app" || task.Branch != "job/issue-7" {
		t.Fatalf("task = %+v", task)
	}
	again := post(signature)
	if again.Code != http.StatusOK {
		t.Fatalf("replay = %d: %s", again.Code, again.Body.String())
	}
}
