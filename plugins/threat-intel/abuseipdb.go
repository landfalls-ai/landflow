package main

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strconv"

	landflow "github.com/landflow/landflow/sdks/go"
)

// abuseMaliciousScore is the abuse confidence score from which IOC Enrich calls AbuseIPDB's answer malicious.
const abuseMaliciousScore = 75

func abuseIpDbNode() *serviceNode {
	check := show("ip", "check")
	return &serviceNode{
		cred: credAbuseIPDB,
		desc: serviceDescriptor("abuseIpDb", "AbuseIPDB",
			"Check an IP address against AbuseIPDB's abuse reports",
			"Check an IP address in AbuseIPDB (read only): resource=ip, operation=check, ip, optional maxAgeInDays (1-365, "+
				"default 30) and verbose (adds the report list). Returns abuseConfidenceScore (0-100), totalReports, country, ISP and usage type.",
			"https://docs.abuseipdb.com/#check-endpoint", []string{"abuseipdb", "abuse", "ip", "blacklist"}, credAbuseIPDB,
			[]landflow.PropertyDescriptor{
				resourceProperty("ip", landflow.PropertyOption{Name: "IP Address", Value: "ip"}),
				operationProperty("ip", "check", readOp("Check", "check", "Check the abuse reports of an IP address", "Check an IP address")),
				stringProperty("ip", "IP Address", "IPv4 or IPv6 address", "8.8.8.8", check),
				{Name: "maxAgeInDays", DisplayName: "Max Age in Days", Type: landflow.PropNumber, Default: 30,
					Description:    "Only reports newer than this count (1-365)",
					TypeOptions:    &landflow.TypeOptions{MinValue: landflow.Ptr(1.0), MaxValue: landflow.Ptr(365.0), NumberPrecision: landflow.Ptr(0)},
					DisplayOptions: check},
				{Name: "verbose", DisplayName: "Verbose", Type: landflow.PropBoolean, Default: false,
					Description: "Whether to include the individual reports (reportedAt, comment, categories…)", DisplayOptions: check},
			}),
		newClient: func(_ *landflow.ExecuteContext, d landflow.CredentialData) *apiClient {
			return newClient(svcAbuseIPDB, d, "Key")
		},
		ops: map[opKey]opFunc{{"ip", "check"}: func(r *run, i int) (map[string]any, error) {
			ip, err := requireString(r.ctx, "ip", "IP Address", i)
			if err != nil {
				return nil, err
			}
			data, err := abuseCheck(r.ctx, r.c, ip, r.ctx.ParamInt("maxAgeInDays", i, 30), r.ctx.ParamBool("verbose", i, false))
			if err != nil {
				return nil, err
			}
			data["link"] = abuseLink(ip)
			return data, nil
		}},
	}
}

func abuseLink(ip string) string { return "https://www.abuseipdb.com/check/" + url.PathEscape(ip) }

// abuseCheck returns the `data` object of the check answer.
func abuseCheck(ctx context.Context, c *apiClient, ip string, maxAge int, verbose bool) (map[string]any, error) {
	q := url.Values{"ipAddress": {ip}, "maxAgeInDays": {strconv.Itoa(min(max(maxAge, 1), 365))}}
	if verbose {
		q.Set("verbose", "")
	}
	var resp struct {
		Data map[string]any `json:"data"`
	}
	if err := c.do(ctx, http.MethodGet, "/api/v2/check", q, nil, &resp); err != nil {
		return nil, err
	}
	if resp.Data == nil {
		resp.Data = map[string]any{}
	}
	return resp.Data, nil
}

// enrichAbuseIPDB is AbuseIPDB's side of IOC Enrich: the score is the abuse confidence score, malicious from
// abuseMaliciousScore up.
func enrichAbuseIPDB(ctx context.Context, c *apiClient, o ioc) serviceResult {
	res := serviceResult{Link: abuseLink(o.Value)}
	data, err := abuseCheck(ctx, c, o.Value, 90, false)
	if err != nil {
		return res.fail(err)
	}
	score, ok := num(data["abuseConfidenceScore"])
	if !ok {
		res.Summary = "no abuse confidence score in the answer"
		return res
	}
	res.Score = ptr(clamp100(score))
	res.Malicious = ptr(*res.Score >= abuseMaliciousScore)
	res.Summary = fmt.Sprintf("abuse confidence %d%%, %d reports from %d users in 90 days", *res.Score, intOf(data["totalReports"]), intOf(data["numDistinctUsers"]))
	return res
}
