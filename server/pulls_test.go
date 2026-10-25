package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRepoPullAndMergeAPI(t *testing.T) {
	isolateState(t)
	var created, merged bool
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/repos/acme/app/pulls":
			created = true
			var body map[string]string
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("decode pull: %v", err)
			}
			if body["head"] != "job/issue-7" || body["base"] != "main" {
				t.Errorf("pull body = %+v", body)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"number": 9, "html_url": "https://example/pr/9", "state": "open",
			})
		case r.Method == http.MethodPut && r.URL.Path == "/repos/acme/app/pulls/9/merge":
			merged = true
			_ = json.NewEncoder(w).Encode(map[string]any{
				"merged": true, "sha": "abc", "message": "merged",
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer target.Close()
	t.Setenv("TEST_GITHUB_TOKEN", "test-token")

	console := NewServer("", nil)
	repo, err := console.repos.Add(Repo{
		Provider: "github", BaseURL: target.URL, Owner: "acme", Name: "app",
		DefaultBranch: "main", Checkout: "/repo", TokenEnv: "TEST_GITHUB_TOKEN",
	})
	if err != nil {
		t.Fatal(err)
	}
	handler := console.Handler()

	create := do(t, handler, http.MethodPost, "/api/v1/repos/"+repo.ID+"/pull",
		`{"head":"job/issue-7","title":"Fix"}`)
	if create.Code != http.StatusCreated {
		t.Fatalf("pull = %d: %s", create.Code, create.Body.String())
	}
	var pullAnswer struct {
		Pull providerPull `json:"pull"`
	}
	if err := json.Unmarshal(create.Body.Bytes(), &pullAnswer); err != nil {
		t.Fatal(err)
	}
	if pullAnswer.Pull.Number != 9 {
		t.Fatalf("pull = %+v", pullAnswer.Pull)
	}

	merge := do(t, handler, http.MethodPost, "/api/v1/repos/"+repo.ID+"/merge",
		`{"number":9}`)
	if merge.Code != http.StatusOK {
		t.Fatalf("merge = %d: %s", merge.Code, merge.Body.String())
	}
	var mergeAnswer struct {
		Pull providerPull `json:"pull"`
	}
	if err := json.Unmarshal(merge.Body.Bytes(), &mergeAnswer); err != nil {
		t.Fatal(err)
	}
	if !mergeAnswer.Pull.Merged || mergeAnswer.Pull.SHA != "abc" {
		t.Fatalf("merge = %+v", mergeAnswer.Pull)
	}
	if !created || !merged {
		t.Fatalf("created=%v merged=%v", created, merged)
	}
}
