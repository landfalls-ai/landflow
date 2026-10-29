package main

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"sort"
	"strings"

	landflow "github.com/landflow/landflow/sdks/go"
)

func shodanNode() *serviceNode {
	host, dns := show("host", "get"), show("dns", "lookup")
	return &serviceNode{
		cred: credShodan,
		desc: serviceDescriptor("shodan", "Shodan",
			"Look up what Shodan knows about an IP address, or resolve hostnames",
			"Query Shodan (read only). resource=host, operation=get, ip: open ports, services, vulnerabilities, hostnames, "+
				"organisation and tags for the IP (found=false when Shodan has no data). resource=dns, operation=lookup, "+
				"hostnames (comma-separated): the IP address of each hostname.",
			"https://developer.shodan.io/api", []string{"shodan", "ports", "exposure", "dns", "host", "ip"}, credShodan,
			[]landflow.PropertyDescriptor{
				resourceProperty("host",
					landflow.PropertyOption{Name: "Host", Value: "host"},
					landflow.PropertyOption{Name: "DNS", Value: "dns"}),
				operationProperty("host", "get", readOp("Get", "get", "Get the information Shodan has about an IP address", "Get a host")),
				operationProperty("dns", "lookup", readOp("Resolve", "lookup", "Resolve hostnames to IP addresses", "Resolve hostnames")),
				stringProperty("ip", "IP Address", "IPv4 or IPv6 address", "8.8.8.8", host),
				simplifyProperty(host, "Whether to return {ip, found, hostnames, domains, org, isp, country, os, ports, vulns, tags, lastUpdate, link} instead of Shodan's full banner data"),
				stringProperty("hostnames", "Hostnames", "Comma-separated hostnames", "example.com,www.example.com", dns),
			}),
		newClient: func(_ *landflow.ExecuteContext, d landflow.CredentialData) *apiClient {
			return newClient(svcShodan, d, "") // the key goes in the `key` query parameter
		},
		ops: map[opKey]opFunc{
			{"host", "get"}: func(r *run, i int) (map[string]any, error) {
				ip, err := requireString(r.ctx, "ip", "IP Address", i)
				if err != nil {
					return nil, err
				}
				raw, found, err := shodanHost(r.ctx, r.c, ip)
				if err != nil {
					return nil, err
				}
				if !found {
					return map[string]any{"ip": ip, "found": false, "link": shodanLink(ip)}, nil
				}
				if !r.ctx.ParamBool("simple", i, true) {
					return raw, nil
				}
				return shodanSummary(raw, ip), nil
			},
			{"dns", "lookup"}: func(r *run, i int) (map[string]any, error) {
				names := splitList(r.ctx.ParamString("hostnames", i, ""))
				if len(names) == 0 {
					return nil, userError("Fill in Hostnames.", "Hostnames is required")
				}
				var resolved map[string]any
				q := url.Values{"hostnames": {strings.Join(names, ",")}}
				if err := r.c.do(r.ctx, http.MethodGet, "/dns/resolve", q, nil, &resolved); err != nil {
					return nil, err
				}
				results := []any{}
				for _, name := range names {
					var ip any
					if s := str(resolved[name]); s != "" {
						ip = s
					}
					results = append(results, map[string]any{"hostname": name, "ip": ip})
				}
				return map[string]any{"results": results}, nil
			},
		},
	}
}

// splitList splits a comma or newline separated parameter, dropping blanks and repeats.
func splitList(s string) []string {
	var out []string
	for _, p := range strings.FieldsFunc(s, func(r rune) bool { return r == ',' || r == '\n' }) {
		if p = strings.TrimSpace(p); p != "" && !slices.Contains(out, p) {
			out = append(out, p)
		}
	}
	return out
}

func shodanLink(ip string) string { return "https://www.shodan.io/host/" + url.PathEscape(ip) }

// shodanHost fetches the host record; found is false on 404 ("No information available for that IP").
func shodanHost(ctx context.Context, c *apiClient, ip string) (raw map[string]any, found bool, err error) {
	err = c.do(ctx, http.MethodGet, "/shodan/host/"+url.PathEscape(ip), nil, nil, &raw)
	if isNotFound(err) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return raw, true, nil
}

func shodanPorts(raw map[string]any) []int {
	var ports []int
	for _, p := range list(raw["ports"]) {
		ports = append(ports, intOf(p))
	}
	sort.Ints(ports)
	return ports
}

func shodanSummary(raw map[string]any, ip string) map[string]any {
	ports := []any{}
	for _, p := range shodanPorts(raw) {
		ports = append(ports, p)
	}
	return map[string]any{
		"ip": ip, "found": true, "hostnames": stringList(raw["hostnames"]), "domains": stringList(raw["domains"]),
		"org": str(raw["org"]), "isp": str(raw["isp"]), "country": str(raw["country_name"]), "os": str(raw["os"]),
		"ports": ports, "vulns": stringList(raw["vulns"]), "tags": stringList(raw["tags"]),
		"lastUpdate": str(raw["last_update"]), "link": shodanLink(ip),
	}
}

// enrichShodan is Shodan's side of IOC Enrich. Shodan maps exposure, not reputation, so it only gives a verdict when
// it tags the host "compromised" or "malware" (malicious, score 80). Otherwise the answer is the summary: ports and
// CVEs. No record for the IP: no data.
func enrichShodan(ctx context.Context, c *apiClient, o ioc) serviceResult {
	res := serviceResult{Link: shodanLink(o.Value)}
	raw, found, err := shodanHost(ctx, c, o.Value)
	switch {
	case err != nil:
		return res.fail(err)
	case !found:
		res.Summary = "no information available for this IP"
		return res
	}
	tags := stringList(raw["tags"])
	res.Summary = fmt.Sprintf("%d open ports, %d known vulnerabilities", len(list(raw["ports"])), len(list(raw["vulns"])))
	if len(tags) > 0 {
		res.Summary += ", tags: " + strings.Join(tags, ", ")
	}
	for _, t := range tags {
		if t == "compromised" || t == "malware" {
			res.Malicious, res.Score = ptr(true), ptr(80)
			res.Summary += " (tagged " + t + ")"
			break
		}
	}
	return res
}
