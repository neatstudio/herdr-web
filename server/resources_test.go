package server

import (
	"encoding/json"
	"net/http"
	"testing"
)

func TestWeightAdmission(t *testing.T) {
	for _, testCase := range []struct {
		name string
		res  hostResources
		want map[string]bool
	}{
		{
			name: "one core, one gig",
			res:  hostResources{CPUs: 1, MemTotalMB: 1024, MemAvailableMB: 512},
			want: map[string]bool{"light": true, "standard": true, "heavy": false},
		},
		{
			name: "two cores, two gig",
			res:  hostResources{CPUs: 2, MemTotalMB: 2048, MemAvailableMB: 800},
			want: map[string]bool{"light": true, "standard": true, "heavy": true},
		},
		{
			name: "busy",
			res:  hostResources{CPUs: 4, MemTotalMB: 8192, MemAvailableMB: 100},
			want: map[string]bool{"light": false, "standard": false, "heavy": false},
		},
		{
			name: "unknown memory is not zero",
			res:  hostResources{CPUs: 4},
			want: map[string]bool{"light": true, "standard": true, "heavy": true},
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			for weight, want := range testCase.want {
				got, _ := weightAdmission(weight, testCase.res)
				if got != want {
					t.Errorf("%s: got %v, want %v", weight, got, want)
				}
			}
		})
	}
}

func TestJobOfferDeclinesHeavyOnASmallHost(t *testing.T) {
	previous := readHostResources
	readHostResources = func() hostResources {
		return hostResources{CPUs: 1, MemTotalMB: 1024, MemAvailableMB: 512}
	}
	t.Cleanup(func() { readHostResources = previous })
	installClaude(t)
	console := newTestHandler(t, "")
	for _, testCase := range []struct {
		weight string
		accept bool
	}{
		{"light", true},
		{"standard", true},
		{"heavy", false},
	} {
		recorder := do(t, console, http.MethodPost, "/api/v1/herdr/job/offer",
			`{"taskId":"task-`+testCase.weight+`","prompt":"p","kind":"claude","weight":"`+testCase.weight+`"}`)
		var answer struct {
			Accept bool   `json:"accept"`
			Reason string `json:"reason"`
		}
		if err := json.Unmarshal(recorder.Body.Bytes(), &answer); err != nil {
			t.Fatal(err)
		}
		if answer.Accept != testCase.accept {
			t.Errorf("%s: accept=%v reason=%q", testCase.weight, answer.Accept, answer.Reason)
		}
	}
}
