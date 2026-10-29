package main

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	landflow "github.com/landflow/landflow/sdks/go"
)

// otxMaliciousPulses is how many OTX pulses must mention an indicator for IOC Enrich to call it malicious; the score
// is otxScorePerPulse per pulse, at most 100.
const (
	otxMaliciousPulses = 5
	otxScorePerPulse   = 15
)

func otxNode() *serviceNode {
	get := show("indicator", "get")
	return &serviceNode{
		cred: credOTX,
		desc: serviceDescriptor("alienVaultOtx", "AlienVault OTX",
			"Look up an indicator in AlienVault OTX and see the threat pulses that mention it",
			"Look up an indicator in AlienVault OTX (read only): resource=indicator, operation=get, indicatorType (IPv4, IPv6, "+
				"domain, hostname, url or file) and indicator. Returns the pulse count and names, reputation, country and ASN "+
				"for the general section; found=false when OTX has no record.",
			"https://otx.alienvault.com/api", []string{"otx", "alienvault", "pulse", "ioc", "indicator"}, credOTX,
			[]landflow.PropertyDescriptor{
				resourceProperty("indicator", landflow.PropertyOption{Name: "Indicator", Value: "indicator"}),
				operationProperty("indicator", "get", readOp("Get", "get", "Get the general section of an indicator", "Get an indicator")),
				{Name: "indicatorType", DisplayName: "Indicator Type", Type: landflow.PropOptions, Default: "IPv4", DisplayOptions: get,
					Options: []landflow.PropertyOption{
						{Name: "IPv4", Value: "IPv4"}, {Name: "IPv6", Value: "IPv6"}, {Name: "Domain", Value: "domain"},
						{Name: "Hostname", Value: "hostname"}, {Name: "URL", Value: "url"}, {Name: "File Hash", Value: "file"},
					}},
				stringProperty("indicator", "Indicator", "The IP address, domain, hostname, URL or file hash (MD5, SHA-1 or SHA-256)", "8.8.8.8", get),
				simplifyProperty(get, "Whether to return {indicator, type, found, pulseCount, pulses, reputation, country, asn, link} instead of OTX's full general section"),
			}),
		newClient: func(_ *landflow.ExecuteContext, d landflow.CredentialData) *apiClient {
			return newClient(svcOTX, d, "X-OTX-API-KEY")
		},
		ops: map[opKey]opFunc{{"indicator", "get"}: func(r *run, i int) (map[string]any, error) {
			typ := r.ctx.ParamString("indicatorType", i, "IPv4")
			value, err := requireString(r.ctx, "indicator", "Indicator", i)
			if err != nil {
				return nil, err
			}
			raw, found, err := otxGeneral(r.ctx, r.c, typ, value)
			if err != nil {
				return nil, err
			}
			if !found {
				return map[string]any{"indicator": value, "type": typ, "found": false, "link": otxLink(typ, value)}, nil
			}
			if !r.ctx.ParamBool("simple", i, true) {
				return raw, nil
			}
			return otxSummary(raw, typ, value), nil
		}},
	}
}

func otxLink(typ, value string) string {
	return "https://otx.alienvault.com/indicator/" + url.PathEscape(otxLinkType(typ)) + "/" + url.PathEscape(value)
}

// otxLinkType is the type segment of an OTX web link, which differs from the API's for IP addresses.
func otxLinkType(typ string) string {
	switch typ {
	case "IPv4", "IPv6":
		return "ip"
	}
	return typ
}

// otxGeneral fetches the general section; found is false on 404.
func otxGeneral(ctx context.Context, c *apiClient, typ, value string) (raw map[string]any, found bool, err error) {
	path := "/api/v1/indicators/" + url.PathEscape(typ) + "/" + url.PathEscape(value) + "/general"
	err = c.do(ctx, http.MethodGet, path, nil, nil, &raw)
	if isNotFound(err) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return raw, true, nil
}

func otxPulseNames(raw map[string]any, limit int) []any {
	names := []any{}
	for _, p := range list(dig(raw, "pulse_info", "pulses")) {
		if n := str(object(p)["name"]); n != "" && len(names) < limit {
			names = append(names, n)
		}
	}
	return names
}

func otxSummary(raw map[string]any, typ, value string) map[string]any {
	return map[string]any{
		"indicator": value, "type": typ, "found": true, "pulseCount": intOf(dig(raw, "pulse_info", "count")),
		"pulses": otxPulseNames(raw, 10), "reputation": intOf(raw["reputation"]),
		"country": str(raw["country_name"]), "asn": str(raw["asn"]), "link": otxLink(typ, value),
	}
}

// otxType maps an IOC to OTX's indicator type.
func otxType(o ioc) string {
	switch o.Type {
	case iocIP:
		if strings.Contains(o.Value, ":") {
			return "IPv6"
		}
		return "IPv4"
	case iocHash:
		return "file"
	}
	return string(o.Type)
}

// enrichOTX is OTX's side of IOC Enrich. Score: otxScorePerPulse per pulse mentioning the indicator, at most 100;
// malicious from otxMaliciousPulses pulses up. An indicator OTX whitelists (a validation entry) is not malicious, score
// 0, whatever the pulses say: popular domains appear in many pulses. No record (404): no data.
func enrichOTX(ctx context.Context, c *apiClient, o ioc) serviceResult {
	typ := otxType(o)
	res := serviceResult{Link: otxLink(typ, o.Value)}
	raw, found, err := otxGeneral(ctx, c, typ, o.Value)
	switch {
	case err != nil:
		return res.fail(err)
	case !found:
		res.Summary = "no record in OTX"
		return res
	}
	pulses := intOf(dig(raw, "pulse_info", "count"))
	for _, v := range list(raw["validation"]) {
		src := strings.ToLower(str(object(v)["source"]))
		if strings.Contains(src, "whitelist") || strings.Contains(src, "alexa") || strings.Contains(src, "majestic") {
			res.Malicious, res.Score = ptr(false), ptr(0)
			res.Summary = fmt.Sprintf("whitelisted in OTX (%s), %d pulses", src, pulses)
			return res
		}
	}
	res.Score = ptr(clamp100(float64(otxScorePerPulse * pulses)))
	res.Malicious = ptr(pulses >= otxMaliciousPulses)
	res.Summary = fmt.Sprintf("mentioned in %d OTX pulses", pulses)
	if names := otxPulseNames(raw, 3); len(names) > 0 {
		parts := make([]string, len(names))
		for i, n := range names {
			parts[i] = n.(string)
		}
		res.Summary += ": " + strings.Join(parts, "; ")
	}
	return res
}
