package main

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const badIP = "45.33.32.156"

// allCreds attaches every service to the fake.
func allCreds(f *fake) map[string]any {
	return map[string]any{
		credVirusTotal: f.creds("vt"), credAbuseIPDB: f.creds("ab"), credGreyNoise: f.creds("gn"), credURLScan: f.creds("us"),
		credShodan: f.creds("sh"), credOTX: f.creds("otx"), credMISP: f.creds("mi"),
	}
}

// badRoutes answer every service as if the IP were hostile.
func badRoutes() map[string]any {
	return map[string]any{
		"GET /api/v3/ip_addresses/" + badIP:                 ok200(vtReport(12, 3, 20, 30)),
		"GET /api/v2/check":                                 ok200(map[string]any{"data": map[string]any{"abuseConfidenceScore": 95, "totalReports": 40, "numDistinctUsers": 20}}),
		"GET /v3/community/" + badIP:                        ok200(map[string]any{"noise": true, "riot": false, "classification": "malicious", "name": "Mirai"}),
		"GET /api/v1/search/":                               ok200(map[string]any{"total": 0, "results": []any{}}),
		"GET /shodan/host/" + badIP:                         ok200(map[string]any{"ports": []any{22, 23}, "vulns": []any{}, "tags": []any{"malware"}}),
		"GET /api/v1/indicators/IPv4/" + badIP + "/general": ok200(map[string]any{"pulse_info": map[string]any{"count": 8, "pulses": []any{map[string]any{"name": "Mirai C2"}}}}),
		"POST /attributes/restSearch":                       ok200(map[string]any{"response": map[string]any{"Attribute": []any{map[string]any{"event_id": "9", "to_ids": true, "Event": map[string]any{"info": "Mirai"}}}}}),
	}
}

func enrichParams(extra map[string]any) map[string]any {
	p := map[string]any{}
	for k, v := range extra {
		p[k] = v
	}
	return p
}

func intel(t *testing.T, item map[string]any) map[string]any {
	t.Helper()
	m, ok := item["threatIntel"].(map[string]any)
	if !ok {
		t.Fatalf("no threatIntel in %v", item)
	}
	return m
}

func serviceByID(t *testing.T, result map[string]any) map[string]map[string]any {
	t.Helper()
	out := map[string]map[string]any{}
	for _, s := range result["services"].([]any) {
		m := s.(map[string]any)
		out[m["service"].(string)] = m
	}
	return out
}

func TestEnrichAggregatesEveryService(t *testing.T) {
	h := newHarness(t)
	f := newFake(t, badRoutes())
	got := h.one("iocEnrich", enrichParams(nil), execOpts{creds: allCreds(f), items: []map[string]any{{"alertId": "A-1", "ioc": map[string]any{"type": "ip", "value": badIP}}}})
	eq(t, "input kept", got["alertId"], "A-1")
	r := intel(t, got)
	eq(t, "verdict", r["verdict"], "malicious")
	eq(t, "score", r["score"], 100.0)
	eq(t, "ioc type", r["ioc"].(map[string]any)["type"], "ip")
	eq(t, "ioc value", r["ioc"].(map[string]any)["value"], badIP)
	var order []string
	for _, s := range r["services"].([]any) {
		order = append(order, s.(map[string]any)["service"].(string))
	}
	eq(t, "service order", strings.Join(order, ","), "virustotal,abuseipdb,greynoise,urlscan,shodan,otx,misp")
	svc := serviceByID(t, r)
	eq(t, "vt malicious", svc["virustotal"]["malicious"], true)
	eq(t, "vt score", svc["virustotal"]["score"], 100.0)
	contains(t, svc["virustotal"]["summary"].(string), "12 malicious")
	eq(t, "vt link", svc["virustotal"]["link"], "https://www.virustotal.com/gui/ip-address/"+badIP)
	eq(t, "abuse score", svc["abuseipdb"]["score"], 95.0)
	eq(t, "greynoise score", svc["greynoise"]["score"], 100.0)
	eq(t, "urlscan no data", svc["urlscan"]["malicious"], nil)
	eq(t, "urlscan no score", svc["urlscan"]["score"], nil)
	eq(t, "shodan malicious", svc["shodan"]["malicious"], true)
	eq(t, "shodan score", svc["shodan"]["score"], 80.0)
	eq(t, "otx score", svc["otx"]["score"], 100.0)
	eq(t, "misp malicious", svc["misp"]["malicious"], true)
	eq(t, "misp link", svc["misp"]["link"], f.srv.URL+"/events/view/9")
	for id, s := range svc {
		if _, hasErr := s["error"]; hasErr {
			t.Errorf("%s has an error: %v", id, s["error"])
		}
	}
	reasons := toStrings(r["reasons"])
	if len(reasons) < 5 {
		t.Errorf("reasons = %v", reasons)
	}
	contains(t, strings.Join(reasons, "\n"), "virustotal: 12 malicious")
	// urlscan had nothing to say, so it is not a reason.
	if strings.Contains(strings.Join(reasons, "\n"), "urlscan") {
		t.Errorf("urlscan should not be a reason: %v", reasons)
	}
}

func TestEnrichSkipsPrivateReservedAndLoopbackIPs(t *testing.T) {
	h := newHarness(t)
	f := newFake(t, badRoutes())
	skipped := []string{"10.1.2.3", "192.168.0.10", "172.16.5.5", "127.0.0.1", "::1", "fd12::1", "169.254.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "192.0.2.10", "255.255.255.255", "fe80::1", "http://10.0.0.1/admin"}
	var items []map[string]any
	for _, v := range skipped {
		items = append(items, map[string]any{"value": v})
	}
	out := h.ok(h.exec("iocEnrich", nil, execOpts{creds: allCreds(f), items: items}))
	eq(t, "items", len(out), len(skipped))
	for i, item := range out {
		r := intel(t, item)
		eq(t, skipped[i]+" verdict", r["verdict"], "unknown")
		eq(t, skipped[i]+" skipped", r["skipped"], true)
		eq(t, skipped[i]+" score", r["score"], nil)
		contains(t, toStrings(r["reasons"])[0], "skipped:")
		eq(t, skipped[i]+" services", len(r["services"].([]any)), 0)
	}
	eq(t, "requests to services", f.count(), 0)
}

func TestEnrichPublicIPsNearReservedRangesAreLookedUp(t *testing.T) {
	for _, v := range []string{"8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "11.0.0.1"} {
		o, err := parseIOC("ip", v)
		if err != nil {
			t.Fatal(err)
		}
		if why := skipReason(o); why != "" {
			t.Errorf("%s skipped: %s", v, why)
		}
	}
}

func TestEnrichCacheHit(t *testing.T) {
	h := newHarness(t)
	f := newFake(t, badRoutes())
	creds := map[string]any{credVirusTotal: f.creds("vt"), credAbuseIPDB: f.creds("ab")}
	item := map[string]any{"value": badIP}
	first := intel(t, h.one("iocEnrich", nil, execOpts{creds: creds, items: []map[string]any{item}}))
	eq(t, "first requests", f.count(), 2)
	for _, s := range serviceByID(t, first) {
		if s["cached"] != nil {
			t.Errorf("first call marked cached: %v", s)
		}
	}
	second := intel(t, h.one("iocEnrich", nil, execOpts{creds: creds, items: []map[string]any{item}}))
	eq(t, "requests after the second call", f.count(), 2)
	for id, s := range serviceByID(t, second) {
		eq(t, id+" cached", s["cached"], true)
	}
	eq(t, "same verdict", second["verdict"], first["verdict"])

	// The same IOC repeated inside one batch is also asked once.
	cache.reset()
	f2 := newFake(t, badRoutes())
	h.ok(h.exec("iocEnrich", nil, execOpts{creds: map[string]any{credVirusTotal: f2.creds("vt")}, items: []map[string]any{item, item, item}}))
	eq(t, "requests for three identical items", f2.count(), 1)
}

func TestEnrichCacheExpiresAndCanBeDisabled(t *testing.T) {
	h := newHarness(t)
	clock := time.Date(2025, 1, 1, 12, 0, 0, 0, time.UTC)
	var mu sync.Mutex
	orig := now
	now = func() time.Time { mu.Lock(); defer mu.Unlock(); return clock }
	t.Cleanup(func() { now = orig })
	advance := func(d time.Duration) { mu.Lock(); clock = clock.Add(d); mu.Unlock() }

	f := newFake(t, badRoutes())
	creds := map[string]any{credVirusTotal: f.creds("vt")}
	run := func(params map[string]any) {
		h.ok(h.exec("iocEnrich", params, execOpts{creds: creds, items: []map[string]any{{"value": badIP}}}))
	}

	run(map[string]any{"cacheTtl": 60})
	advance(59 * time.Second)
	run(map[string]any{"cacheTtl": 60})
	eq(t, "within the TTL", f.count(), 1)
	advance(2 * time.Second)
	run(map[string]any{"cacheTtl": 60})
	eq(t, "after the TTL", f.count(), 2)

	run(map[string]any{"cacheTtl": 0})
	run(map[string]any{"cacheTtl": 0})
	eq(t, "cache off", f.count(), 4)
}

func TestEnrichDefaultCacheTTLIsOneHour(t *testing.T) {
	for _, p := range (IOCEnrichNode{}).Description().Properties {
		if p.Name == "cacheTtl" {
			eq(t, "default", p.Default, 3600)
			return
		}
	}
	t.Fatal("no cacheTtl parameter")
}

func TestEnrichFailuresAreNotCached(t *testing.T) {
	h := newHarness(t)
	noSleep(t)
	calls := 0
	f := newFake(t, map[string]any{"GET /api/v3/ip_addresses/" + badIP: func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			w.WriteHeader(500)
			return
		}
		_ = jsonEncode(w, vtReport(0, 0, 5, 5))
	}})
	creds := map[string]any{credVirusTotal: f.creds("vt")}
	first := intel(t, h.one("iocEnrich", nil, execOpts{creds: creds, items: []map[string]any{{"value": badIP}}}))
	contains(t, serviceByID(t, first)["virustotal"]["error"].(string), "VirusTotal API error 500")
	second := intel(t, h.one("iocEnrich", nil, execOpts{creds: creds, items: []map[string]any{{"value": badIP}}}))
	eq(t, "retried after the failure", second["verdict"], "clean")
	eq(t, "requests", f.count(), 2)
}

func TestEnrichPartialFailureStillSucceeds(t *testing.T) {
	h := newHarness(t)
	noSleep(t)
	routes := badRoutes()
	routes["GET /api/v3/ip_addresses/"+badIP] = reply{status: 503, body: "down"}
	routes["GET /api/v2/check"] = ok200(map[string]any{"data": map[string]any{"abuseConfidenceScore": 4, "totalReports": 1, "numDistinctUsers": 1}})
	f := newFake(t, routes)
	creds := map[string]any{credVirusTotal: f.creds("vt"), credAbuseIPDB: f.creds("ab")}
	resp := h.exec("iocEnrich", nil, execOpts{creds: creds, items: []map[string]any{{"value": badIP}}})
	if resp.Error != nil {
		t.Fatalf("the item failed: %+v", resp.Error)
	}
	r := intel(t, h.ok(resp)[0])
	eq(t, "verdict from the service that answered", r["verdict"], "clean")
	eq(t, "score", r["score"], 4.0)
	svc := serviceByID(t, r)
	contains(t, svc["virustotal"]["error"].(string), "503")
	eq(t, "failed service malicious", svc["virustotal"]["malicious"], nil)
	eq(t, "failed service score", svc["virustotal"]["score"], nil)
	if _, hasErr := svc["abuseipdb"]["error"]; hasErr {
		t.Error("abuseipdb should not have an error")
	}
	contains(t, strings.Join(toStrings(r["reasons"]), "\n"), "virustotal failed")
}

func TestEnrichEveryServiceFailingIsStillAnItem(t *testing.T) {
	h := newHarness(t)
	noSleep(t)
	f := newFake(t, map[string]any{"GET /api/v3/ip_addresses/" + badIP: reply{status: 500}})
	r := intel(t, h.one("iocEnrich", nil, execOpts{creds: map[string]any{credVirusTotal: f.creds("vt")}, items: []map[string]any{{"value": badIP}}}))
	eq(t, "verdict", r["verdict"], "unknown")
	eq(t, "score", r["score"], nil)
}

func TestEnrichHonoursRetryAfterOnce(t *testing.T) {
	h := newHarness(t)
	waits := noSleep(t)
	calls := 0
	f := newFake(t, map[string]any{"GET /api/v2/check": func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			w.Header().Set("Retry-After", "2")
			w.WriteHeader(429)
			return
		}
		_ = jsonEncode(w, map[string]any{"data": map[string]any{"abuseConfidenceScore": 80}})
	}})
	r := intel(t, h.one("iocEnrich", nil, execOpts{creds: map[string]any{credAbuseIPDB: f.creds("ab")}, items: []map[string]any{{"value": badIP}}}))
	eq(t, "verdict", r["verdict"], "malicious")
	eq(t, "requests", f.count(), 2)
	if len(*waits) != 1 || (*waits)[0] != 2*time.Second {
		t.Errorf("waits = %v", *waits)
	}
}

func TestEnrichRateLimitedTwiceFillsTheServiceError(t *testing.T) {
	h := newHarness(t)
	noSleep(t)
	f := newFake(t, map[string]any{"GET /api/v2/check": reply{status: 429, header: map[string]string{"Retry-After": "1"}}})
	r := intel(t, h.one("iocEnrich", nil, execOpts{creds: map[string]any{credAbuseIPDB: f.creds("ab")}, items: []map[string]any{{"value": badIP}}}))
	contains(t, serviceByID(t, r)["abuseipdb"]["error"].(string), "429")
	eq(t, "requests", f.count(), 2)
}

func TestEnrichVerdictThresholds(t *testing.T) {
	s := func(service string, malicious *bool, score *int) serviceResult {
		return serviceResult{Service: service, Malicious: malicious, Score: score, Summary: "s"}
	}
	yes, no := ptr(true), ptr(false)
	cases := []struct {
		name        string
		results     []serviceResult
		mal, sus    int
		wantVerdict string
		wantScore   any
	}{
		{"nothing", nil, 70, 30, "unknown", nil},
		{"no verdicts", []serviceResult{s("a", nil, nil), s("b", nil, nil)}, 70, 30, "unknown", nil},
		{"noise only", []serviceResult{s("greynoise", nil, ptr(25))}, 70, 30, "unknown", 25},
		{"clean", []serviceResult{s("a", no, ptr(0)), s("b", nil, nil)}, 70, 30, "clean", 0},
		{"just below suspicious", []serviceResult{s("a", no, ptr(29))}, 70, 30, "clean", 29},
		{"suspicious at 30", []serviceResult{s("a", no, ptr(30))}, 70, 30, "suspicious", 30},
		{"suspicious at 69", []serviceResult{s("a", no, ptr(69))}, 70, 30, "suspicious", 69},
		{"malicious at 70", []serviceResult{s("a", no, ptr(70))}, 70, 30, "malicious", 70},
		{"a service says malicious", []serviceResult{s("a", yes, ptr(50)), s("b", no, ptr(0))}, 70, 30, "malicious", 50},
		{"malicious flag without a score", []serviceResult{s("a", yes, nil)}, 70, 30, "malicious", nil},
		{"highest score wins", []serviceResult{s("a", no, ptr(10)), s("b", no, ptr(45))}, 70, 30, "suspicious", 45},
		{"custom thresholds", []serviceResult{s("a", no, ptr(45))}, 40, 20, "malicious", 45},
		{"custom suspicious", []serviceResult{s("a", no, ptr(45))}, 90, 50, "clean", 45},
		{"failed services do not count", []serviceResult{{Service: "a", Error: "boom"}, s("b", no, ptr(0))}, 70, 30, "clean", 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			verdict, score, reasons := judge(tc.results, tc.mal, tc.sus)
			eq(t, "verdict", verdict, tc.wantVerdict)
			if tc.wantScore == nil {
				if score != nil {
					t.Errorf("score = %d, want nil", *score)
				}
			} else if score == nil || *score != tc.wantScore {
				t.Errorf("score = %v, want %v", score, tc.wantScore)
			}
			if verdict != "unknown" && len(reasons) == 0 {
				t.Error("no reasons")
			}
		})
	}
}

func TestEnrichThresholdOptions(t *testing.T) {
	h := newHarness(t)
	f := newFake(t, map[string]any{"GET /api/v2/check": ok200(map[string]any{"data": map[string]any{"abuseConfidenceScore": 50}})})
	creds := map[string]any{credAbuseIPDB: f.creds("ab")}
	run := func(opts map[string]any) string {
		return intel(t, h.one("iocEnrich", map[string]any{"options": opts, "cacheTtl": 0}, execOpts{creds: creds, items: []map[string]any{{"value": badIP}}}))["verdict"].(string)
	}
	eq(t, "defaults", run(nil), "suspicious")
	eq(t, "lower malicious bar", run(map[string]any{"maliciousThreshold": 50}), "malicious")
	eq(t, "higher suspicious bar", run(map[string]any{"suspiciousThreshold": 60, "maliciousThreshold": 90}), "clean")
}

func TestEnrichOnlyConfiguredAndEnabledServicesRun(t *testing.T) {
	h := newHarness(t)
	f := newFake(t, badRoutes())
	// Credentials for VirusTotal and AbuseIPDB; AbuseIPDB switched off in Services; Shodan has an empty key.
	creds := map[string]any{credVirusTotal: f.creds("vt"), credAbuseIPDB: f.creds("ab"), credShodan: f.creds("")}
	r := intel(t, h.one("iocEnrich", map[string]any{"services": []any{"virustotal", "shodan", "otx"}}, execOpts{creds: creds, items: []map[string]any{{"value": badIP}}}))
	svc := serviceByID(t, r)
	if len(svc) != 1 || svc["virustotal"] == nil {
		t.Errorf("services = %v", svc)
	}
	for _, req := range f.requests() {
		if req.path != "/api/v3/ip_addresses/"+badIP {
			t.Errorf("unexpected request %s", req.path)
		}
	}
}

func TestEnrichGreyNoiseRunsWithAnEmptyKeyCredential(t *testing.T) {
	h := newHarness(t)
	f := newFake(t, badRoutes())
	r := intel(t, h.one("iocEnrich", nil, execOpts{creds: map[string]any{credGreyNoise: map[string]any{"baseUrl": f.srv.URL}}, items: []map[string]any{{"value": badIP}}}))
	eq(t, "services", len(serviceByID(t, r)), 1)
	eq(t, "no key header", f.only().header.Get("key"), "")
}

func TestEnrichNoCredentialsIsUnknown(t *testing.T) {
	h := newHarness(t)
	r := intel(t, h.one("iocEnrich", nil, execOpts{items: []map[string]any{{"value": badIP}}}))
	eq(t, "verdict", r["verdict"], "unknown")
	contains(t, toStrings(r["reasons"])[0], "no enabled service")
}

func TestEnrichSelectsServicesByIOCType(t *testing.T) {
	h := newHarness(t)
	sha := strings.Repeat("c", 64)
	f := newFake(t, map[string]any{
		"GET /api/v3/files/" + sha:                        ok200(vtReport(0, 0, 60, 0)),
		"GET /api/v1/indicators/file/" + sha + "/general": ok200(map[string]any{"pulse_info": map[string]any{"count": 0}}),
		"POST /attributes/restSearch":                     ok200(map[string]any{"response": map[string]any{"Attribute": []any{}}}),
	})
	r := intel(t, h.one("iocEnrich", nil, execOpts{creds: allCreds(f), items: []map[string]any{{"ioc": map[string]any{"type": "sha256", "value": strings.ToUpper(sha)}}}}))
	eq(t, "hash services", strings.Join(sortedKeys(serviceByID(t, r)), ","), "misp,otx,virustotal")
	eq(t, "normalised hash", r["ioc"].(map[string]any)["value"], sha)
	eq(t, "verdict", r["verdict"], "clean")

	f2 := newFake(t, map[string]any{
		"GET /api/v3/domains/evil.example":                   ok200(vtReport(0, 0, 60, 0)),
		"GET /api/v1/search/":                                ok200(map[string]any{"results": []any{}}),
		"GET /api/v1/indicators/domain/evil.example/general": ok200(map[string]any{"pulse_info": map[string]any{"count": 0}}),
		"POST /attributes/restSearch":                        ok200(map[string]any{"response": map[string]any{"Attribute": []any{}}}),
	})
	r = intel(t, h.one("iocEnrich", nil, execOpts{creds: allCreds(f2), items: []map[string]any{{"type": "domain", "value": "EVIL.example."}}}))
	eq(t, "domain services", strings.Join(sortedKeys(serviceByID(t, r)), ","), "misp,otx,urlscan,virustotal")
	q := ""
	for _, req := range f2.requests() {
		if req.path == "/api/v1/search/" {
			q = req.query(t, "q")
		}
	}
	eq(t, "urlscan query", q, `domain:"evil.example"`)
}

func TestEnrichURLScanVerdictFeedsTheResult(t *testing.T) {
	h := newHarness(t)
	f := newFake(t, map[string]any{
		"GET /api/v1/search/":    ok200(map[string]any{"total": 3, "results": []any{map[string]any{"_id": "u1", "task": map[string]any{"time": "2025-01-01T00:00:00Z"}}}}),
		"GET /api/v1/result/u1/": ok200(map[string]any{"verdicts": map[string]any{"overall": map[string]any{"score": 100, "malicious": true, "hasVerdicts": true}}}),
	})
	r := intel(t, h.one("iocEnrich", nil, execOpts{creds: map[string]any{credURLScan: f.creds("us")}, items: []map[string]any{{"value": "https://evil.example/x"}}}))
	eq(t, "verdict", r["verdict"], "malicious")
	svc := serviceByID(t, r)["urlscan"]
	eq(t, "link", svc["link"], "https://urlscan.io/result/u1/")
	contains(t, svc["summary"].(string), "3 public scans")
}

func TestEnrichInputShapes(t *testing.T) {
	h := newHarness(t)
	f := newFake(t, map[string]any{
		"GET /api/v3/ip_addresses/8.8.8.8": ok200(vtReport(0, 0, 70, 5)),
		"GET /api/v3/ip_addresses/1.1.1.1": ok200(vtReport(0, 0, 70, 5)),
		"GET /api/v3/ip_addresses/9.9.9.9": ok200(vtReport(9, 0, 10, 5)),
		"GET /api/v3/domains/evil.example": ok200(vtReport(0, 0, 70, 5)),
	})
	creds := map[string]any{credVirusTotal: f.creds("vt")}
	seen := func() []string {
		var paths []string
		for _, r := range f.requests() {
			paths = append(paths, r.path)
		}
		return paths
	}
	run := func(params map[string]any, item map[string]any) map[string]any {
		cache.reset()
		return h.one("iocEnrich", params, execOpts{creds: creds, items: []map[string]any{item}})
	}

	// ioc object, at a custom dot path
	r := intel(t, run(map[string]any{"iocPath": "alert.observable"}, map[string]any{"alert": map[string]any{"observable": map[string]any{"type": "ipv4", "value": "8.8.8.8"}}}))
	eq(t, "dot path ioc", r["ioc"].(map[string]any)["value"], "8.8.8.8")
	// a plain string, type detected, defanged
	r = intel(t, run(nil, map[string]any{"ioc": "evil[.]example"}))
	eq(t, "string ioc type", r["ioc"].(map[string]any)["type"], "domain")
	// type + value paths
	r = intel(t, run(map[string]any{"typePath": "obs.kind", "valuePath": "obs.val"}, map[string]any{"obs": map[string]any{"kind": "ip", "val": "1.1.1.1"}}))
	eq(t, "type/value paths", r["ioc"].(map[string]any)["value"], "1.1.1.1")
	// value without a type: detected
	r = intel(t, run(nil, map[string]any{"value": "1.1.1.1"}))
	eq(t, "detected", r["ioc"].(map[string]any)["type"], "ip")

	// iocs array: every element, mixed objects and strings, one invalid
	arr := map[string]any{"iocs": []any{map[string]any{"type": "ip", "value": "8.8.8.8"}, "9.9.9.9", "10.0.0.1", "not an ioc!"}}
	r = intel(t, run(nil, arr))
	iocs := r["iocs"].([]any)
	eq(t, "array length", len(iocs), 4)
	eq(t, "array verdict (worst wins)", r["verdict"], "malicious")
	eq(t, "array score", r["score"], 90.0)
	eq(t, "first", iocs[0].(map[string]any)["verdict"], "clean")
	eq(t, "second", iocs[1].(map[string]any)["verdict"], "malicious")
	eq(t, "third skipped", iocs[2].(map[string]any)["skipped"], true)
	eq(t, "fourth invalid", iocs[3].(map[string]any)["verdict"], "unknown")
	contains(t, iocs[3].(map[string]any)["error"].(string), "cannot tell")
	contains(t, strings.Join(toStrings(r["reasons"]), "\n"), "9.9.9.9: virustotal: 9 malicious")

	// option: only the first element
	before := len(seen())
	r = intel(t, run(map[string]any{"options": map[string]any{"enrichAll": false}}, arr))
	eq(t, "first element only", len(r["iocs"].([]any)), 1)
	eq(t, "requests for the first element only", len(seen())-before, 1)

	// an array of only clean and skipped IOCs is clean; only skipped is unknown
	r = intel(t, run(nil, map[string]any{"iocs": []any{"8.8.8.8", "10.0.0.1"}}))
	eq(t, "clean + skipped", r["verdict"], "clean")
	r = intel(t, run(nil, map[string]any{"iocs": []any{"10.0.0.1", "127.0.0.1"}}))
	eq(t, "all skipped", r["verdict"], "unknown")
}

func TestEnrichOutputOptions(t *testing.T) {
	h := newHarness(t)
	f := newFake(t, map[string]any{"GET /api/v3/ip_addresses/8.8.8.8": ok200(vtReport(0, 0, 70, 5))})
	creds := map[string]any{credVirusTotal: f.creds("vt")}
	got := h.one("iocEnrich", map[string]any{"options": map[string]any{"outputField": "intel", "keepInput": false}}, execOpts{creds: creds, items: []map[string]any{{"value": "8.8.8.8", "keep": "me"}}})
	if _, ok := got["intel"]; !ok || got["keep"] != nil || got["value"] != nil || len(got) != 1 {
		t.Errorf("output = %v", got)
	}
}

func TestEnrichItemWithoutAnIOCIsAnError(t *testing.T) {
	h := newHarness(t)
	err := h.failure("iocEnrich", nil, execOpts{items: []map[string]any{{"foo": "bar"}}})
	contains(t, err.Message, "carries no IOC")
	if err.ItemIndex == nil || *err.ItemIndex != 0 {
		t.Errorf("itemIndex = %v", err.ItemIndex)
	}
	err = h.failure("iocEnrich", nil, execOpts{items: []map[string]any{{"type": "ip", "value": "banana"}}})
	contains(t, err.Message, "Invalid indicator")

	resp := h.exec("iocEnrich", nil, execOpts{keepGoing: true, items: []map[string]any{{"foo": "bar"}}})
	if resp.Error != nil || len(resp.Outputs[0]) != 1 {
		t.Fatalf("response = %+v", resp)
	}
	contains(t, resp.Outputs[0][0].JSON["error"].(string), "carries no IOC")
}

func TestEnrichEmptyIOCArrayIsUnknown(t *testing.T) {
	h := newHarness(t)
	got := h.one("iocEnrich", nil, execOpts{items: []map[string]any{{"iocs": []any{}, "alert": "kept"}}})
	intel := got["threatIntel"].(map[string]any)
	if intel["verdict"] != "unknown" || intel["score"] != nil || len(intel["iocs"].([]any)) != 0 || got["alert"] != "kept" {
		t.Errorf("output = %v", got)
	}
	contains(t, fmt.Sprint(intel["reasons"]), "no IOCs to look up")
}

func TestEnrichConcurrencyIsBounded(t *testing.T) {
	h := newHarness(t)
	var inflight, peak atomic.Int32
	f := newFake(t, map[string]any{"ANY": func(w http.ResponseWriter, r *http.Request) {
		n := inflight.Add(1)
		for {
			p := peak.Load()
			if n <= p || peak.CompareAndSwap(p, n) {
				break
			}
		}
		time.Sleep(25 * time.Millisecond)
		inflight.Add(-1)
		_ = jsonEncode(w, vtReport(0, 0, 70, 5))
	}})
	var arr []any
	for i := 0; i < 12; i++ {
		arr = append(arr, "8.8."+strconv.Itoa(i)+".8")
	}
	creds := map[string]any{credVirusTotal: f.creds("vt")}
	h.ok(h.exec("iocEnrich", map[string]any{"options": map[string]any{"concurrency": 2}}, execOpts{creds: creds, items: []map[string]any{{"iocs": arr}}}))
	eq(t, "requests", f.count(), 12)
	if p := peak.Load(); p > 2 || p < 1 {
		t.Errorf("peak in flight = %d, want 1..2", p)
	}

	cache.reset()
	peak.Store(0)
	h.ok(h.exec("iocEnrich", map[string]any{"options": map[string]any{"concurrency": 1000}}, execOpts{creds: creds, items: []map[string]any{{"iocs": arr}}}))
	if p := peak.Load(); p > maxConcurrency {
		t.Errorf("peak in flight = %d, above the cap %d", p, maxConcurrency)
	}
}

func sortedKeys[V any](m map[string]V) []string {
	var keys []string
	for k := range m {
		keys = append(keys, k)
	}
	for i := range keys {
		for j := i + 1; j < len(keys); j++ {
			if keys[j] < keys[i] {
				keys[i], keys[j] = keys[j], keys[i]
			}
		}
	}
	return keys
}

func TestCacheSharesConcurrentLookups(t *testing.T) {
	cache.reset()
	var calls atomic.Int32
	gate := make(chan struct{})
	var wg sync.WaitGroup
	results := make([]bool, 5)
	for i := range results {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, cached := cache.do("k", time.Minute, func() serviceResult {
				calls.Add(1)
				<-gate
				return serviceResult{Summary: "x"}
			})
			results[i] = cached
		}()
	}
	time.Sleep(50 * time.Millisecond)
	close(gate)
	wg.Wait()
	eq(t, "fetches", calls.Load(), int32(1))
	n := 0
	for _, c := range results {
		if c {
			n++
		}
	}
	eq(t, "callers served from the shared lookup", n, 4)
}

func TestCacheIsBounded(t *testing.T) {
	cache.reset()
	for i := 0; i < maxCacheEntries+50; i++ {
		cache.do("key-"+strconv.Itoa(i), time.Hour, func() serviceResult { return serviceResult{} })
	}
	if n := cache.size(); n > maxCacheEntries {
		t.Errorf("cache holds %d entries, above %d", n, maxCacheEntries)
	}
}
