package main

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"

	landflow "github.com/landflow/landflow/sdks/go"
)

func greyNoiseNode() *serviceNode {
	n := &serviceNode{
		cred:     credGreyNoise,
		optional: true,
		desc: serviceDescriptor("greyNoise", "GreyNoise",
			"Look up an IP address in GreyNoise's Community API: is it internet background noise or a known benign service?",
			"Look up an IP address in GreyNoise Community (read only): resource=ip, operation=get, ip. Returns noise (it scans the "+
				"internet), riot (a known benign service), classification (benign, malicious or unknown), name and last_seen. "+
				"seen=false means GreyNoise has never observed the IP, which is a normal answer.",
			"https://docs.greynoise.io/reference/get_v3-community-ip", []string{"greynoise", "noise", "riot", "scanner", "ip"}, credGreyNoise,
			[]landflow.PropertyDescriptor{
				resourceProperty("ip", landflow.PropertyOption{Name: "IP Address", Value: "ip"}),
				operationProperty("ip", "get", readOp("Get", "get", "Look up an IP address in the Community API", "Look up an IP address")),
				stringProperty("ip", "IP Address", "IPv4 address", "8.8.8.8", show("ip", "get")),
			}),
		newClient: func(_ *landflow.ExecuteContext, d landflow.CredentialData) *apiClient {
			return newClient(svcGreyNoise, d, "key")
		},
	}
	// The key is optional: the Community API answers without one, so the credential is not required.
	n.desc.Credentials = []landflow.NodeCredentialRequirement{{Name: credGreyNoise}}
	n.ops = map[opKey]opFunc{{"ip", "get"}: func(r *run, i int) (map[string]any, error) {
		ip, err := requireString(r.ctx, "ip", "IP Address", i)
		if err != nil {
			return nil, err
		}
		return greyNoiseLookup(r.ctx, r.c, ip)
	}}
	return n
}

func greyNoiseLink(ip string) string { return "https://viz.greynoise.io/ip/" + url.PathEscape(ip) }

// greyNoiseLookup returns the community answer plus `seen` (noise or riot). A 404 is GreyNoise saying it has not
// observed the IP: noise=false, riot=false, seen=false and the message.
func greyNoiseLookup(ctx context.Context, c *apiClient, ip string) (map[string]any, error) {
	var out map[string]any
	err := c.do(ctx, http.MethodGet, "/v3/community/"+url.PathEscape(ip), nil, nil, &out)
	if isNotFound(err) {
		var ae *apiError
		errors.As(err, &ae)
		msg := ae.message
		if msg == "" || msg == http.StatusText(http.StatusNotFound) {
			msg = "IP not observed scanning the internet or contained in the RIOT data set"
		}
		out, err = map[string]any{"ip": ip, "noise": false, "riot": false, "message": msg}, nil
	}
	if err != nil {
		return nil, err
	}
	if out == nil {
		out = map[string]any{}
	}
	if _, ok := out["ip"]; !ok {
		out["ip"] = ip
	}
	out["seen"] = boolOf(out["noise"]) || boolOf(out["riot"])
	if str(out["link"]) == "" {
		out["link"] = greyNoiseLink(ip)
	}
	return out, nil
}

// enrichGreyNoise is GreyNoise's side of IOC Enrich. classification malicious: malicious, score 100. benign or riot:
// not malicious, score 0. Noise with an unknown classification: score 25 and no verdict (mass scanning is common and
// not an attack on you). Not observed: no data.
func enrichGreyNoise(ctx context.Context, c *apiClient, o ioc) serviceResult {
	res := serviceResult{Link: greyNoiseLink(o.Value)}
	g, err := greyNoiseLookup(ctx, c, o.Value)
	if err != nil {
		return res.fail(err)
	}
	if l := str(g["link"]); l != "" {
		res.Link = l
	}
	class := strings.ToLower(str(g["classification"]))
	name := str(g["name"])
	switch {
	case class == "malicious":
		res.Malicious, res.Score = ptr(true), ptr(100)
		res.Summary = "classified malicious" + named(name) + ", seen scanning the internet"
	case class == "benign" || boolOf(g["riot"]):
		res.Malicious, res.Score = ptr(false), ptr(0)
		res.Summary = "known benign service" + named(name)
		if boolOf(g["riot"]) {
			res.Summary += " (RIOT)"
		}
	case boolOf(g["noise"]):
		res.Score = ptr(25)
		res.Summary = "internet background noise, classification " + orDefault(class, "unknown") + named(name)
	default:
		res.Summary = "not observed by GreyNoise"
	}
	return res
}

func named(name string) string {
	if name == "" {
		return ""
	}
	return " (" + name + ")"
}

func orDefault(s, def string) string {
	if s == "" {
		return def
	}
	return s
}
