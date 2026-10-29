package main

import (
	"encoding/base64"
	"net/http"
	"strings"
	"testing"
	"time"
)

// vtReport is a VirusTotal v3 object answer.
func vtReport(mal, susp, harmless, undetected int) map[string]any {
	return map[string]any{"data": map[string]any{"id": "x", "type": "ip_address", "attributes": map[string]any{
		"last_analysis_stats": map[string]any{"malicious": mal, "suspicious": susp, "harmless": harmless, "undetected": undetected},
		"reputation":          -12, "last_analysis_date": 1700000000,
	}}}
}

func TestVirusTotalOperations(t *testing.T) {
	h := newHarness(t)
	longURL := "https://example.com/a path?b=c&d=é"
	urlID := base64.RawURLEncoding.EncodeToString([]byte(longURL))
	if strings.Contains(urlID, "=") {
		t.Fatalf("test URL id has padding: %s", urlID)
	}
	sha := strings.Repeat("ab", 32)
	cases := []struct {
		name, resource, param, value, wantPath, wantLink string
	}{
		{"ip", "ip", "ip", "8.8.8.8", "/api/v3/ip_addresses/8.8.8.8", "https://www.virustotal.com/gui/ip-address/8.8.8.8"},
		{"domain", "domain", "domain", "example.com", "/api/v3/domains/example.com", "https://www.virustotal.com/gui/domain/example.com"},
		{"url", "url", "url", longURL, "/api/v3/urls/" + urlID, "https://www.virustotal.com/gui/url/" + urlID},
		{"file", "file", "hash", sha, "/api/v3/files/" + sha, "https://www.virustotal.com/gui/file/" + sha},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newFake(t, map[string]any{"GET " + tc.wantPath: ok200(vtReport(7, 2, 50, 11))})
			got := h.one("virusTotal", map[string]any{"resource": tc.resource, "operation": "get", tc.param: tc.value},
				execOpts{creds: map[string]any{credVirusTotal: f.creds("vt-key")}})
			req := f.only()
			eq(t, "method", req.method, "GET")
			eq(t, "path", req.path, tc.wantPath)
			eq(t, "x-apikey", req.header.Get("x-apikey"), "vt-key")
			want := map[string]any{
				"indicator": tc.value, "found": true, "malicious": 7.0, "suspicious": 2.0, "harmless": 50.0, "undetected": 11.0,
				"reputation": -12.0, "lastAnalysisDate": "2023-11-14T22:13:20Z", "link": tc.wantLink,
			}
			for k, v := range want {
				if got[k] != v {
					t.Errorf("%s = %v, want %v", k, got[k], v)
				}
			}
		})
	}
}

func TestVirusTotalSimplifyOffReturnsFullReport(t *testing.T) {
	h := newHarness(t)
	f := newFake(t, map[string]any{"GET /api/v3/domains/example.com": ok200(vtReport(0, 0, 70, 5))})
	got := h.one("virusTotal", map[string]any{"resource": "domain", "operation": "get", "domain": "example.com", "simple": false},
		execOpts{creds: map[string]any{credVirusTotal: f.creds("k")}})
	if _, ok := got["data"]; !ok {
		t.Errorf("full report has no data: %v", got)
	}
	if _, ok := got["malicious"]; ok {
		t.Errorf("full report was simplified: %v", got)
	}
}

func TestVirusTotalNotFoundIsAResult(t *testing.T) {
	h := newHarness(t)
	f := newFake(t, map[string]any{"GET /api/v3/files/" + strings.Repeat("0", 64): reply{status: 404, body: map[string]any{"error": map[string]any{"code": "NotFoundError", "message": "not found"}}}})
	got := h.one("virusTotal", map[string]any{"resource": "file", "operation": "get", "hash": strings.Repeat("0", 64)},
		execOpts{creds: map[string]any{credVirusTotal: f.creds("k")}})
	eq(t, "found", got["found"], false)
}

func TestErrorStatuses(t *testing.T) {
	h := newHarness(t)
	noSleep(t)
	cases := []struct {
		status            int
		body              any
		wantMsg, wantHint string
	}{
		{401, map[string]any{"error": map[string]any{"code": "WrongCredentialsError", "message": "Wrong API key"}}, "VirusTotal API error 401: Wrong API key", "Check the API key"},
		{500, "boom", "VirusTotal API error 500: boom", "unavailable"},
		{503, map[string]any{"error": map[string]any{"message": "try later"}}, "VirusTotal API error 503: try later", "unavailable"},
	}
	for _, tc := range cases {
		f := newFake(t, map[string]any{"GET /api/v3/ip_addresses/8.8.8.8": reply{status: tc.status, body: tc.body}})
		err := h.failure("virusTotal", map[string]any{"resource": "ip", "operation": "get", "ip": "8.8.8.8"},
			execOpts{creds: map[string]any{credVirusTotal: f.creds("secret-key-123")}})
		contains(t, err.Message, tc.wantMsg)
		contains(t, err.Description, tc.wantHint)
		if strings.Contains(err.Message+err.Description, "secret-key-123") {
			t.Error("the API key leaked into the error")
		}
		if err.ItemIndex == nil || *err.ItemIndex != 0 {
			t.Errorf("itemIndex = %v", err.ItemIndex)
		}
	}
}

func TestRateLimitIsRetriedOnceAfterRetryAfter(t *testing.T) {
	h := newHarness(t)
	waits := noSleep(t)
	calls := 0
	f := newFake(t, map[string]any{"GET /api/v3/ip_addresses/1.1.1.1": func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			w.Header().Set("Retry-After", "7")
			w.WriteHeader(429)
			_, _ = w.Write([]byte(`{"error":{"message":"Quota exceeded"}}`))
			return
		}
		_ = jsonEncode(w, vtReport(1, 0, 60, 8))
	}})
	got := h.one("virusTotal", map[string]any{"resource": "ip", "operation": "get", "ip": "1.1.1.1"}, execOpts{creds: map[string]any{credVirusTotal: f.creds("k")}})
	eq(t, "malicious", got["malicious"], 1.0)
	eq(t, "requests", f.count(), 2)
	if len(*waits) != 1 || (*waits)[0] != 7*time.Second {
		t.Errorf("waits = %v, want [7s]", *waits)
	}
}

func TestRateLimitTwiceFailsWithHint(t *testing.T) {
	h := newHarness(t)
	waits := noSleep(t)
	f := newFake(t, map[string]any{"GET /api/v3/ip_addresses/1.1.1.1": reply{status: 429, header: map[string]string{"Retry-After": "3"}, body: map[string]any{"error": map[string]any{"message": "Quota exceeded"}}}})
	err := h.failure("virusTotal", map[string]any{"resource": "ip", "operation": "get", "ip": "1.1.1.1"}, execOpts{creds: map[string]any{credVirusTotal: f.creds("k")}})
	contains(t, err.Message, "VirusTotal API error 429: Quota exceeded")
	contains(t, err.Description, "retry after 3s")
	eq(t, "requests (one retry, no more)", f.count(), 2)
	eq(t, "waits", len(*waits), 1)
}

func TestRateLimitWithALongRetryAfterIsNotWaited(t *testing.T) {
	h := newHarness(t)
	waits := noSleep(t)
	f := newFake(t, map[string]any{"GET /api/v3/ip_addresses/1.1.1.1": reply{status: 429, header: map[string]string{"Retry-After": "3600"}}})
	err := h.failure("virusTotal", map[string]any{"resource": "ip", "operation": "get", "ip": "1.1.1.1"}, execOpts{creds: map[string]any{credVirusTotal: f.creds("k")}})
	contains(t, err.Message, "429")
	eq(t, "requests", f.count(), 1)
	eq(t, "waits", len(*waits), 0)
}

func TestRetryAfterHTTPDate(t *testing.T) {
	if d := parseRetryAfter(time.Now().Add(20 * time.Second).UTC().Format(http.TimeFormat)); d < 15*time.Second || d > 21*time.Second {
		t.Errorf("date form = %v", d)
	}
	for _, v := range []string{"", "abc", "-4", "Mon, 02 Jan 2006 15:04:05 GMT"} {
		if d := parseRetryAfter(v); d != 0 {
			t.Errorf("parseRetryAfter(%q) = %v", v, d)
		}
	}
}

func TestContinueOnFailEmitsAnErrorItem(t *testing.T) {
	h := newHarness(t)
	f := newFake(t, map[string]any{
		"GET /api/v3/ip_addresses/9.9.9.9": reply{status: 500, body: "down"},
	})
	one := h.exec("virusTotal", map[string]any{"resource": "ip", "operation": "get", "ip": "9.9.9.9"}, execOpts{
		creds: map[string]any{credVirusTotal: f.creds("k")}, keepGoing: true,
	})
	if one.Error != nil || len(one.Outputs[0]) != 1 {
		t.Fatalf("response = %+v", one)
	}
	contains(t, one.Outputs[0][0].JSON["error"].(string), "VirusTotal API error 500")
}

func TestMissingCredentialIsAnError(t *testing.T) {
	h := newHarness(t)
	err := h.failure("virusTotal", map[string]any{"resource": "ip", "operation": "get", "ip": "8.8.8.8"}, execOpts{})
	contains(t, err.Message, "virusTotalApi")
}

func TestMissingParameterIsAnError(t *testing.T) {
	h := newHarness(t)
	f := newFake(t, nil)
	err := h.failure("virusTotal", map[string]any{"resource": "ip", "operation": "get", "ip": "  "}, execOpts{creds: map[string]any{credVirusTotal: f.creds("k")}})
	contains(t, err.Message, "IP Address is required")
	eq(t, "requests", f.count(), 0)
}

func TestAbuseIPDBCheck(t *testing.T) {
	h := newHarness(t)
	f := newFake(t, map[string]any{"GET /api/v2/check": ok200(map[string]any{"data": map[string]any{
		"ipAddress": "118.25.6.39", "abuseConfidenceScore": 100, "countryCode": "CN", "totalReports": 12, "numDistinctUsers": 8, "isp": "Tencent",
	}})})
	got := h.one("abuseIpDb", map[string]any{"resource": "ip", "operation": "check", "ip": "118.25.6.39", "maxAgeInDays": 90, "verbose": true},
		execOpts{creds: map[string]any{credAbuseIPDB: f.creds("abuse-key")}})
	req := f.only()
	eq(t, "Key header", req.header.Get("Key"), "abuse-key")
	eq(t, "Accept", req.header.Get("Accept"), "application/json")
	eq(t, "ipAddress", req.query(t, "ipAddress"), "118.25.6.39")
	eq(t, "maxAgeInDays", req.query(t, "maxAgeInDays"), "90")
	contains(t, req.rawQuery, "verbose")
	eq(t, "score", got["abuseConfidenceScore"], 100.0)
	eq(t, "link", got["link"], "https://www.abuseipdb.com/check/118.25.6.39")
}

func TestAbuseIPDBDefaultsAndNoVerbose(t *testing.T) {
	h := newHarness(t)
	f := newFake(t, map[string]any{"GET /api/v2/check": ok200(map[string]any{"data": map[string]any{"abuseConfidenceScore": 0}})})
	h.one("abuseIpDb", map[string]any{"resource": "ip", "operation": "check", "ip": "1.1.1.1"}, execOpts{creds: map[string]any{credAbuseIPDB: f.creds("k")}})
	req := f.only()
	eq(t, "maxAgeInDays default", req.query(t, "maxAgeInDays"), "30")
	if strings.Contains(req.rawQuery, "verbose") {
		t.Errorf("verbose sent by default: %s", req.rawQuery)
	}
}

func TestAbuseIPDBErrorEnvelope(t *testing.T) {
	h := newHarness(t)
	f := newFake(t, map[string]any{"GET /api/v2/check": reply{status: 422, body: map[string]any{"errors": []any{map[string]any{"detail": "The ip address must be a valid IPv4 or IPv6 address.", "status": 422}}}}})
	err := h.failure("abuseIpDb", map[string]any{"resource": "ip", "operation": "check", "ip": "nope"}, execOpts{creds: map[string]any{credAbuseIPDB: f.creds("k")}})
	contains(t, err.Message, "AbuseIPDB API error 422: The ip address must be a valid")
}

func TestGreyNoiseCommunity(t *testing.T) {
	h := newHarness(t)
	f := newFake(t, map[string]any{
		"GET /v3/community/71.6.135.131": ok200(map[string]any{"ip": "71.6.135.131", "noise": true, "riot": false, "classification": "malicious", "name": "unknown", "last_seen": "2025-01-02"}),
		"GET /v3/community/192.0.2.99":   reply{status: 404, body: map[string]any{"ip": "192.0.2.99", "noise": false, "riot": false, "message": "IP not observed scanning the internet or contained in RIOT data set."}},
	})
	creds := map[string]any{credGreyNoise: f.creds("gn-key")}
	got := h.one("greyNoise", map[string]any{"resource": "ip", "operation": "get", "ip": "71.6.135.131"}, execOpts{creds: creds})
	eq(t, "classification", got["classification"], "malicious")
	eq(t, "seen", got["seen"], true)
	eq(t, "link", got["link"], "https://viz.greynoise.io/ip/71.6.135.131")
	eq(t, "key header", f.requests()[0].header.Get("key"), "gn-key")

	got = h.one("greyNoise", map[string]any{"resource": "ip", "operation": "get", "ip": "192.0.2.99"}, execOpts{creds: creds})
	eq(t, "404 seen", got["seen"], false)
	eq(t, "404 noise", got["noise"], false)
	contains(t, got["message"].(string), "not observed")
}

func TestGreyNoiseWorksWithoutCredential(t *testing.T) {
	h := newHarness(t)
	f := newFake(t, map[string]any{"GET /v3/community/8.8.8.8": ok200(map[string]any{"ip": "8.8.8.8", "noise": false, "riot": true, "name": "Google Public DNS"})})
	// No credential at all: the node uses GreyNoise's own host, which a test cannot reach, so give it a base URL
	// through an empty-key credential and check that no key header is sent.
	got := h.one("greyNoise", map[string]any{"resource": "ip", "operation": "get", "ip": "8.8.8.8"}, execOpts{creds: map[string]any{credGreyNoise: map[string]any{"baseUrl": f.srv.URL}}})
	eq(t, "seen", got["seen"], true)
	eq(t, "key header", f.only().header.Get("key"), "")
}

func TestGreyNoiseServerErrorIsAnError(t *testing.T) {
	h := newHarness(t)
	f := newFake(t, map[string]any{"GET /v3/community/8.8.8.8": reply{status: 502, body: map[string]any{"message": "bad gateway"}}})
	err := h.failure("greyNoise", map[string]any{"resource": "ip", "operation": "get", "ip": "8.8.8.8"}, execOpts{creds: map[string]any{credGreyNoise: f.creds("")}})
	contains(t, err.Message, "GreyNoise API error 502: bad gateway")
}

func TestURLScanSearchAndResult(t *testing.T) {
	h := newHarness(t)
	f := newFake(t, map[string]any{
		"GET /api/v1/search/": ok200(map[string]any{"total": 41, "took": 12, "has_more": true, "results": []any{map[string]any{
			"_id": "uuid-1", "task": map[string]any{"time": "2025-03-01T10:00:00.000Z", "url": "https://evil.example/login"},
			"page":       map[string]any{"url": "https://evil.example/login", "domain": "evil.example", "ip": "45.33.32.156", "country": "US"},
			"screenshot": "https://urlscan.io/screenshots/uuid-1.png",
		}}}),
		"GET /api/v1/result/uuid-1/": ok200(map[string]any{
			"task": map[string]any{"time": "2025-03-01T10:00:00.000Z"}, "page": map[string]any{"url": "https://evil.example/login", "domain": "evil.example", "ip": "45.33.32.156", "country": "US", "server": "nginx", "status": "200"},
			"verdicts": map[string]any{"overall": map[string]any{"score": 100, "malicious": true, "hasVerdicts": true, "categories": []any{"phishing"}, "tags": []any{"phishing"}}},
		}),
	})
	creds := map[string]any{credURLScan: f.creds("us-key")}
	got := h.one("urlscan", map[string]any{"resource": "scan", "operation": "search", "query": `domain:"evil.example"`, "size": 5}, execOpts{creds: creds})
	req := f.requests()[0]
	eq(t, "API-Key", req.header.Get("API-Key"), "us-key")
	eq(t, "q", req.query(t, "q"), `domain:"evil.example"`)
	eq(t, "size", req.query(t, "size"), "5")
	eq(t, "total", got["total"], 41.0)
	eq(t, "hasMore", got["hasMore"], true)
	hit := got["results"].([]any)[0].(map[string]any)
	eq(t, "hit uuid", hit["uuid"], "uuid-1")
	eq(t, "hit link", hit["link"], "https://urlscan.io/result/uuid-1/")
	eq(t, "hit domain", hit["domain"], "evil.example")

	got = h.one("urlscan", map[string]any{"resource": "scan", "operation": "getResult", "uuid": "uuid-1"}, execOpts{creds: creds})
	eq(t, "result path", f.requests()[1].path, "/api/v1/result/uuid-1/")
	eq(t, "malicious", got["malicious"], true)
	eq(t, "score", got["score"], 100.0)
	eq(t, "domain", got["domain"], "evil.example")
	eq(t, "categories", got["categories"].([]any)[0], "phishing")

	raw := h.one("urlscan", map[string]any{"resource": "scan", "operation": "getResult", "uuid": "uuid-1", "simple": false}, execOpts{creds: creds})
	if _, ok := raw["verdicts"]; !ok {
		t.Errorf("simplify off should return the raw result: %v", raw)
	}
}

func TestURLScanNeverSubmits(t *testing.T) {
	h := newHarness(t)
	f := newFake(t, map[string]any{
		"GET /api/v1/search/":   ok200(map[string]any{"results": []any{}}),
		"GET /api/v1/result/u/": ok200(map[string]any{}),
		"POST /api/v1/scan/":    ok200(map[string]any{"uuid": "published!"}),
	})
	creds := map[string]any{credURLScan: f.creds("k")}
	h.one("urlscan", map[string]any{"resource": "scan", "operation": "search", "query": "x"}, execOpts{creds: creds})
	h.one("urlscan", map[string]any{"resource": "scan", "operation": "getResult", "uuid": "u"}, execOpts{creds: creds})
	for _, r := range f.requests() {
		eq(t, "method of "+r.path, r.method, "GET")
	}
	// An operation that is not offered is refused instead of improvised.
	err := h.failure("urlscan", map[string]any{"resource": "scan", "operation": "submit", "url": "https://example.com"}, execOpts{creds: creds})
	contains(t, err.Message, "Unsupported operation")
	eq(t, "requests after submit attempt", f.count(), 2)
}

func TestURLScanResultNotFoundIsAnError(t *testing.T) {
	h := newHarness(t)
	f := newFake(t, map[string]any{"GET /api/v1/result/missing/": reply{status: 404, body: map[string]any{"message": "We could not find this page", "status": 404}}})
	err := h.failure("urlscan", map[string]any{"resource": "scan", "operation": "getResult", "uuid": "missing"}, execOpts{creds: map[string]any{credURLScan: f.creds("k")}})
	contains(t, err.Message, "urlscan.io API error 404: We could not find this page")
}

func TestShodanHostAndDNS(t *testing.T) {
	h := newHarness(t)
	f := newFake(t, map[string]any{
		"GET /shodan/host/45.33.32.156": ok200(map[string]any{
			"ip_str": "45.33.32.156", "hostnames": []any{"scanme.nmap.org"}, "domains": []any{"nmap.org"}, "org": "Linode", "isp": "Linode", "country_name": "United States",
			"os": nil, "ports": []any{80, 22, 9929}, "vulns": []any{"CVE-2021-1"}, "tags": []any{"cloud"}, "last_update": "2025-02-01T00:00:00",
		}),
		"GET /shodan/host/192.0.2.1": reply{status: 404, body: map[string]any{"error": "No information available for that IP."}},
		"GET /dns/resolve":           ok200(map[string]any{"example.com": "93.184.216.34", "nope.invalid": nil}),
	})
	creds := map[string]any{credShodan: f.creds("sh-key")}
	got := h.one("shodan", map[string]any{"resource": "host", "operation": "get", "ip": "45.33.32.156"}, execOpts{creds: creds})
	req := f.requests()[0]
	eq(t, "key query", req.query(t, "key"), "sh-key")
	eq(t, "no auth header", req.header.Get("Authorization"), "")
	eq(t, "org", got["org"], "Linode")
	eq(t, "country", got["country"], "United States")
	eq(t, "ports sorted", got["ports"].([]any)[0], 22.0)
	eq(t, "link", got["link"], "https://www.shodan.io/host/45.33.32.156")

	got = h.one("shodan", map[string]any{"resource": "host", "operation": "get", "ip": "192.0.2.1"}, execOpts{creds: creds})
	eq(t, "404 found", got["found"], false)

	got = h.one("shodan", map[string]any{"resource": "dns", "operation": "lookup", "hostnames": "example.com, nope.invalid"}, execOpts{creds: creds})
	dns := f.requests()[2]
	eq(t, "dns path", dns.path, "/dns/resolve")
	eq(t, "dns hostnames", dns.query(t, "hostnames"), "example.com,nope.invalid")
	eq(t, "dns key", dns.query(t, "key"), "sh-key")
	results := got["results"].([]any)
	eq(t, "resolved ip", results[0].(map[string]any)["ip"], "93.184.216.34")
	eq(t, "unresolved ip", results[1].(map[string]any)["ip"], nil)

	raw := h.one("shodan", map[string]any{"resource": "host", "operation": "get", "ip": "45.33.32.156", "simple": false}, execOpts{creds: creds})
	eq(t, "raw ip_str", raw["ip_str"], "45.33.32.156")
}

func TestOTXIndicator(t *testing.T) {
	h := newHarness(t)
	f := newFake(t, map[string]any{
		"GET /api/v1/indicators/IPv4/45.33.32.156/general": ok200(map[string]any{
			"indicator": "45.33.32.156", "reputation": 0, "country_name": "United States", "asn": "AS63949 Linode",
			"pulse_info": map[string]any{"count": 2, "pulses": []any{map[string]any{"name": "Botnet C2 IPs"}, map[string]any{"name": "Scanner list"}}},
		}),
		"GET /api/v1/indicators/url/https:%2F%2Fevil.example%2Fa%3Fb=1/general": ok200(map[string]any{"pulse_info": map[string]any{"count": 0}}),
		"GET /api/v1/indicators/file/" + strings.Repeat("a", 64) + "/general":   reply{status: 404, body: map[string]any{"detail": "Not found"}},
	})
	creds := map[string]any{credOTX: f.creds("otx-key")}
	got := h.one("alienVaultOtx", map[string]any{"resource": "indicator", "operation": "get", "indicatorType": "IPv4", "indicator": "45.33.32.156"}, execOpts{creds: creds})
	eq(t, "header", f.requests()[0].header.Get("X-OTX-API-KEY"), "otx-key")
	eq(t, "pulseCount", got["pulseCount"], 2.0)
	eq(t, "first pulse", got["pulses"].([]any)[0], "Botnet C2 IPs")
	eq(t, "link", got["link"], "https://otx.alienvault.com/indicator/ip/45.33.32.156")

	got = h.one("alienVaultOtx", map[string]any{"resource": "indicator", "operation": "get", "indicatorType": "url", "indicator": "https://evil.example/a?b=1"}, execOpts{creds: creds})
	eq(t, "url found", got["found"], true)
	eq(t, "url path", f.requests()[1].path, "/api/v1/indicators/url/https:%2F%2Fevil.example%2Fa%3Fb=1/general")

	got = h.one("alienVaultOtx", map[string]any{"resource": "indicator", "operation": "get", "indicatorType": "file", "indicator": strings.Repeat("a", 64)}, execOpts{creds: creds})
	eq(t, "file 404 found", got["found"], false)
}

func TestMISPAttributeSearch(t *testing.T) {
	h := newHarness(t)
	f := newFake(t, map[string]any{"POST /attributes/restSearch": ok200(map[string]any{"response": map[string]any{"Attribute": []any{map[string]any{
		"id": "11", "event_id": "5", "category": "Network activity", "type": "ip-dst", "value": "45.33.32.156", "to_ids": true, "timestamp": "1700000000", "comment": "C2",
		"Event": map[string]any{"id": "5", "info": "Operation X"}, "Tag": []any{map[string]any{"name": "tlp:amber"}},
	}}}})})
	got := h.one("misp", map[string]any{"resource": "attribute", "operation": "search", "value": "45.33.32.156", "type": "ip-dst, ip-src", "tags": "tlp:amber", "last": "7d", "limit": 10},
		execOpts{creds: map[string]any{credMISP: f.creds("misp-key")}})
	req := f.only()
	eq(t, "method", req.method, "POST")
	eq(t, "Authorization", req.header.Get("Authorization"), "misp-key")
	eq(t, "Content-Type", req.header.Get("Content-Type"), "application/json")
	body := map[string]any{}
	mustJSON(t, req.body, &body)
	eq(t, "body.value", body["value"], "45.33.32.156")
	eq(t, "body.last", body["last"], "7d")
	eq(t, "body.limit", body["limit"], 10.0)
	eq(t, "body.returnFormat", body["returnFormat"], "json")
	eq(t, "body.type", strings.Join(toStrings(body["type"]), "|"), "ip-dst|ip-src")
	eq(t, "body.tags", strings.Join(toStrings(body["tags"]), "|"), "tlp:amber")
	eq(t, "count", got["count"], 1.0)
	attr := got["attributes"].([]any)[0].(map[string]any)
	eq(t, "toIds", attr["toIds"], true)
	eq(t, "eventInfo", attr["eventInfo"], "Operation X")
	eq(t, "link", attr["link"], f.srv.URL+"/events/view/5")
	eq(t, "tag", attr["tags"].([]any)[0], "tlp:amber")
}

func TestMISPRequiresAFilter(t *testing.T) {
	h := newHarness(t)
	f := newFake(t, nil)
	err := h.failure("misp", map[string]any{"resource": "attribute", "operation": "search"}, execOpts{creds: map[string]any{credMISP: f.creds("k")}})
	contains(t, err.Message, "No search filter")
	eq(t, "requests", f.count(), 0)
}

func TestMISPUnverifiedTLS(t *testing.T) {
	h := newHarness(t)
	route := ok200(map[string]any{"response": map[string]any{"Attribute": []any{}}})
	f := newFake(t, nil)
	f.srv.Close()
	f.srv = newTLSServer(f, map[string]any{"POST /attributes/restSearch": route})
	params := map[string]any{"resource": "attribute", "operation": "search", "value": "x"}

	strict := h.failure("misp", params, execOpts{creds: map[string]any{credMISP: map[string]any{"apiKey": "k", "baseUrl": f.srv.URL}}})
	contains(t, strict.Message, "MISP request failed")
	eq(t, "strict requests", f.count(), 0)

	got := h.one("misp", params, execOpts{creds: map[string]any{credMISP: map[string]any{"apiKey": "k", "baseUrl": f.srv.URL, "allowUnverifiedTls": true}}})
	eq(t, "lab count", got["count"], 0.0)
	eq(t, "lab requests", f.count(), 1)
}
