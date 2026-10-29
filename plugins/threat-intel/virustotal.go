package main

import (
	"context"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/url"
	"time"

	landflow "github.com/landflow/landflow/sdks/go"
)

// vtMaliciousEngines is how many engines must flag an indicator for IOC Enrich to call VirusTotal's answer malicious.
const vtMaliciousEngines = 5

func virusTotalNode() *serviceNode {
	get := func(resource string) landflow.PropertyOption {
		return readOp("Get", "get", "Get the reputation of this indicator", "Get "+resource+" report")
	}
	return &serviceNode{
		cred: credVirusTotal,
		desc: serviceDescriptor("virusTotal", "VirusTotal",
			"Look up an IP address, domain, URL or file hash in VirusTotal",
			"Look up an indicator in VirusTotal (read only). resource=ip needs ip, domain needs domain, url needs url "+
				"and file needs hash (MD5, SHA-1 or SHA-256); operation=get. Returns how many engines flag it "+
				"(malicious, suspicious, harmless, undetected), its reputation and a link; simple=false returns the full report.",
			"https://docs.virustotal.com/reference/overview", []string{"virustotal", "vt", "ip", "domain", "url", "hash", "file", "malware"}, credVirusTotal,
			[]landflow.PropertyDescriptor{
				resourceProperty("ip",
					landflow.PropertyOption{Name: "IP Address", Value: "ip"},
					landflow.PropertyOption{Name: "Domain", Value: "domain"},
					landflow.PropertyOption{Name: "URL", Value: "url"},
					landflow.PropertyOption{Name: "File", Value: "file"}),
				operationProperty("ip", "get", get("IP address")),
				operationProperty("domain", "get", get("domain")),
				operationProperty("url", "get", get("URL")),
				operationProperty("file", "get", get("file")),
				stringProperty("ip", "IP Address", "IPv4 or IPv6 address", "8.8.8.8", show("ip", "get")),
				stringProperty("domain", "Domain", "Domain name", "example.com", show("domain", "get")),
				stringProperty("url", "URL", "The full URL; it is encoded as VirusTotal's URL identifier (base64url without padding)", "https://example.com/path", show("url", "get")),
				stringProperty("hash", "File Hash", "MD5, SHA-1 or SHA-256", "", show("file", "get")),
				simplifyProperty(nil, "Whether to return {malicious, suspicious, harmless, undetected, reputation, lastAnalysisDate, link} instead of the full report"),
			}),
		newClient: func(_ *landflow.ExecuteContext, d landflow.CredentialData) *apiClient {
			return newClient(svcVirusTotal, d, "x-apikey")
		},
		ops: map[opKey]opFunc{
			{"ip", "get"}:     vtOp("ip", "ip", "IP Address"),
			{"domain", "get"}: vtOp("domain", "domain", "Domain"),
			{"url", "get"}:    vtOp("url", "url", "URL"),
			{"file", "get"}:   vtOp("hash", "hash", "File Hash"),
		},
	}
}

func vtOp(kind, param, display string) opFunc {
	return func(r *run, i int) (map[string]any, error) {
		value, err := requireString(r.ctx, param, display, i)
		if err != nil {
			return nil, err
		}
		path, link := vtTarget(kind, value)
		raw, found, err := vtGet(r.ctx, r.c, path)
		if err != nil {
			return nil, err
		}
		if !found {
			return map[string]any{"indicator": value, "found": false, "link": link}, nil
		}
		if !r.ctx.ParamBool("simple", i, true) {
			return raw, nil
		}
		return vtSummary(raw, value, link), nil
	}
}

// vtTarget is the API path and the web link of an indicator. kind is ip, domain, url or hash/file.
func vtTarget(kind, value string) (path, link string) {
	const gui = "https://www.virustotal.com/gui/"
	switch kind {
	case "ip":
		return "/api/v3/ip_addresses/" + url.PathEscape(value), gui + "ip-address/" + url.PathEscape(value)
	case "domain":
		return "/api/v3/domains/" + url.PathEscape(value), gui + "domain/" + url.PathEscape(value)
	case "url":
		id := base64.RawURLEncoding.EncodeToString([]byte(value))
		return "/api/v3/urls/" + id, gui + "url/" + id
	default: // hash, file
		return "/api/v3/files/" + url.PathEscape(value), gui + "file/" + url.PathEscape(value)
	}
}

// vtGet fetches a report; found is false on 404 (VirusTotal has never seen the indicator).
func vtGet(ctx context.Context, c *apiClient, path string) (raw map[string]any, found bool, err error) {
	err = c.do(ctx, http.MethodGet, path, nil, nil, &raw)
	if isNotFound(err) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return raw, true, nil
}

type vtStats struct{ malicious, suspicious, harmless, undetected int }

func (s vtStats) total() int { return s.malicious + s.suspicious + s.harmless + s.undetected }

func vtStatsOf(raw map[string]any) vtStats {
	st := object(dig(raw, "data", "attributes", "last_analysis_stats"))
	return vtStats{intOf(st["malicious"]), intOf(st["suspicious"]), intOf(st["harmless"]), intOf(st["undetected"])}
}

// vtSummary is the compact report: the engines' verdict counts, reputation, last analysis time and a link.
func vtSummary(raw map[string]any, indicator, link string) map[string]any {
	attrs := object(dig(raw, "data", "attributes"))
	s := vtStatsOf(raw)
	var last any
	if ts, ok := num(attrs["last_analysis_date"]); ok && ts > 0 {
		last = time.Unix(int64(ts), 0).UTC().Format(time.RFC3339)
	}
	return map[string]any{
		"indicator": indicator, "found": true,
		"malicious": s.malicious, "suspicious": s.suspicious, "harmless": s.harmless, "undetected": s.undetected,
		"reputation": intOf(attrs["reputation"]), "lastAnalysisDate": last, "link": link,
	}
}

// enrichVirusTotal is VirusTotal's side of IOC Enrich. Score: 10 per malicious engine and 5 per suspicious one, at most
// 100; malicious from vtMaliciousEngines engines up. Never analysed (404 or no engine results): unknown.
func enrichVirusTotal(ctx context.Context, c *apiClient, o ioc) serviceResult {
	kind := string(o.Type)
	if o.Type == iocHash {
		kind = "hash"
	}
	path, link := vtTarget(kind, o.Value)
	res := serviceResult{Link: link}
	raw, found, err := vtGet(ctx, c, path)
	switch {
	case err != nil:
		return res.fail(err)
	case !found:
		res.Summary = "not found in VirusTotal (never analysed)"
		return res
	}
	s := vtStatsOf(raw)
	if s.total() == 0 {
		res.Summary = "no engine results yet"
		return res
	}
	res.Malicious = ptr(s.malicious >= vtMaliciousEngines)
	res.Score = ptr(clamp100(float64(10*s.malicious + 5*s.suspicious)))
	res.Summary = fmt.Sprintf("%d malicious, %d suspicious, %d harmless, %d undetected (reputation %d)",
		s.malicious, s.suspicious, s.harmless, s.undetected, intOf(dig(raw, "data", "attributes", "reputation")))
	return res
}
