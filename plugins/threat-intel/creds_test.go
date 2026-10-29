package main

import (
	"context"
	"net/http"
	"strings"
	"testing"

	landflow "github.com/landflow/landflow/sdks/go"
)

func testCred(t *testing.T, h *harness, typ string, data map[string]any) *landflow.TestCredentialsResponse {
	t.Helper()
	resp, err := h.plugin.TestCredentials(context.Background(), &landflow.TestCredentialsRequest{CredentialType: typ, Data: data})
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func TestCredentialTests(t *testing.T) {
	h := newHarness(t)
	cases := []struct {
		typ, method, path string
		check             func(t *testing.T, r recorded)
	}{
		{credVirusTotal, "GET", "/api/v3/users/the-key", func(t *testing.T, r recorded) { eq(t, "x-apikey", r.header.Get("x-apikey"), "the-key") }},
		{credAbuseIPDB, "GET", "/api/v2/check", func(t *testing.T, r recorded) {
			eq(t, "Key", r.header.Get("Key"), "the-key")
			eq(t, "ipAddress", r.query(t, "ipAddress"), "127.0.0.1")
		}},
		{credGreyNoise, "GET", "/v3/community/8.8.8.8", func(t *testing.T, r recorded) { eq(t, "key", r.header.Get("key"), "the-key") }},
		{credURLScan, "GET", "/user/quotas/", func(t *testing.T, r recorded) { eq(t, "API-Key", r.header.Get("API-Key"), "the-key") }},
		{credShodan, "GET", "/api-info", func(t *testing.T, r recorded) { eq(t, "key", r.query(t, "key"), "the-key") }},
		{credOTX, "GET", "/api/v1/users/me", func(t *testing.T, r recorded) { eq(t, "X-OTX-API-KEY", r.header.Get("X-OTX-API-KEY"), "the-key") }},
		{credMISP, "GET", "/users/view/me", func(t *testing.T, r recorded) { eq(t, "Authorization", r.header.Get("Authorization"), "the-key") }},
	}
	for _, tc := range cases {
		t.Run(tc.typ, func(t *testing.T) {
			good := newFake(t, map[string]any{tc.method + " " + tc.path: ok200(map[string]any{})})
			resp := testCred(t, h, tc.typ, good.creds("the-key"))
			if !resp.OK {
				t.Fatalf("test failed: %s", resp.Message)
			}
			tc.check(t, good.only())
			eq(t, "method", good.only().method, tc.method)

			bad := newFake(t, map[string]any{"ANY": reply{status: 401, body: map[string]any{"message": "invalid key"}}})
			resp = testCred(t, h, tc.typ, bad.creds("wrong-key"))
			if resp.OK {
				t.Fatal("a rejected key passed the test")
			}
			contains(t, resp.Message, "401")
			contains(t, resp.Message, "invalid key")
			if strings.Contains(resp.Message, "wrong-key") {
				t.Error("the key leaked into the message")
			}
		})
	}
}

func TestCredentialTestNeedsAKey(t *testing.T) {
	h := newHarness(t)
	for _, typ := range []string{credVirusTotal, credAbuseIPDB, credURLScan, credShodan, credOTX, credMISP} {
		resp := testCred(t, h, typ, map[string]any{"baseUrl": "http://127.0.0.1:1"})
		if resp.OK {
			t.Errorf("%s: a credential without a key passed", typ)
		}
	}
}

func TestGreyNoiseCredentialTestWithoutKeyAndNotSeen(t *testing.T) {
	h := newHarness(t)
	f := newFake(t, map[string]any{"GET /v3/community/8.8.8.8": reply{status: http.StatusNotFound, body: map[string]any{"message": "not observed"}}})
	resp := testCred(t, h, credGreyNoise, map[string]any{"baseUrl": f.srv.URL})
	if !resp.OK {
		t.Fatalf("keyless community credential failed: %s", resp.Message)
	}
	contains(t, resp.Message, "no API key")
}

func TestMISPCredentialTestNeedsBaseURL(t *testing.T) {
	h := newHarness(t)
	resp := testCred(t, h, credMISP, map[string]any{"apiKey": "k"})
	if resp.OK {
		t.Error("MISP without a base URL passed")
	}
}
