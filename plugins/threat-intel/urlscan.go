package main

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	landflow "github.com/landflow/landflow/sdks/go"
)

// The urlscan.io node only reads: there is deliberately no Submit operation, because a submitted scan is public by
// default and leaks the URL (and anything in it) to anyone searching urlscan.io.

func urlscanNode() *serviceNode {
	search, result := show("scan", "search"), show("scan", "getResult")
	return &serviceNode{
		cred: credURLScan,
		desc: serviceDescriptor("urlscan", "urlscan.io",
			"Search urlscan.io's existing scans and read a scan result",
			"Read urlscan.io scans (read only, never submits a scan). resource=scan; operation=search needs query "+
				"(urlscan search syntax, for example domain:example.com or ip:\"1.2.3.4\") and optional size; "+
				"operation=getResult needs uuid and returns the page, verdicts (score, malicious, categories) and a link.",
			"https://urlscan.io/docs/api/", []string{"urlscan", "scan", "url", "domain", "phishing"}, credURLScan,
			[]landflow.PropertyDescriptor{
				resourceProperty("scan", landflow.PropertyOption{Name: "Scan", Value: "scan"}),
				operationProperty("scan", "search",
					readOp("Search", "search", "Search existing scans", "Search scans"),
					readOp("Get Result", "getResult", "Get the result of a scan by its UUID", "Get a scan result")),
				stringProperty("query", "Query", "urlscan.io search query", "domain:example.com", search),
				{Name: "size", DisplayName: "Size", Type: landflow.PropNumber, Default: 20, Description: "Max number of results to return",
					TypeOptions: &landflow.TypeOptions{MinValue: landflow.Ptr(1.0), MaxValue: landflow.Ptr(1000.0), NumberPrecision: landflow.Ptr(0)}, DisplayOptions: search},
				stringProperty("uuid", "Scan UUID", "The scan's UUID", "", result),
				simplifyProperty(show("scan"), "Whether to return a compact summary instead of urlscan.io's full JSON"),
			}),
		newClient: func(_ *landflow.ExecuteContext, d landflow.CredentialData) *apiClient {
			return newClient(svcURLScan, d, "API-Key")
		},
		ops: map[opKey]opFunc{
			{"scan", "search"}: func(r *run, i int) (map[string]any, error) {
				q, err := requireString(r.ctx, "query", "Query", i)
				if err != nil {
					return nil, err
				}
				raw, err := urlscanSearch(r.ctx, r.c, q, r.ctx.ParamInt("size", i, 20))
				if err != nil {
					return nil, err
				}
				if !r.ctx.ParamBool("simple", i, true) {
					return raw, nil
				}
				results := []any{}
				for _, e := range list(raw["results"]) {
					results = append(results, urlscanHit(object(e)))
				}
				return map[string]any{
					"query": q, "total": intOf(raw["total"]), "took": intOf(raw["took"]), "hasMore": boolOf(raw["has_more"]),
					"link": urlscanSearchLink(q), "results": results,
				}, nil
			},
			{"scan", "getResult"}: func(r *run, i int) (map[string]any, error) {
				uuid, err := requireString(r.ctx, "uuid", "Scan UUID", i)
				if err != nil {
					return nil, err
				}
				raw, err := urlscanResult(r.ctx, r.c, uuid)
				if err != nil {
					return nil, err
				}
				if !r.ctx.ParamBool("simple", i, true) {
					return raw, nil
				}
				return urlscanResultSummary(raw, uuid), nil
			},
		},
	}
}

func urlscanSearchLink(q string) string { return "https://urlscan.io/search/#" + url.PathEscape(q) }
func urlscanResultLink(uuid string) string {
	return "https://urlscan.io/result/" + url.PathEscape(uuid) + "/"
}

func urlscanSearch(ctx context.Context, c *apiClient, query string, size int) (map[string]any, error) {
	var raw map[string]any
	q := url.Values{"q": {query}, "size": {strconv.Itoa(min(max(size, 1), 1000))}}
	if err := c.do(ctx, http.MethodGet, "/api/v1/search/", q, nil, &raw); err != nil {
		return nil, err
	}
	if raw == nil {
		raw = map[string]any{}
	}
	return raw, nil
}

func urlscanResult(ctx context.Context, c *apiClient, uuid string) (map[string]any, error) {
	var raw map[string]any
	if err := c.do(ctx, http.MethodGet, "/api/v1/result/"+url.PathEscape(uuid)+"/", nil, nil, &raw); err != nil {
		return nil, err
	}
	if raw == nil {
		raw = map[string]any{}
	}
	return raw, nil
}

// urlscanHit is one search hit in compact form.
func urlscanHit(e map[string]any) map[string]any {
	id := str(e["_id"])
	if id == "" {
		id = str(dig(e, "task", "uuid"))
	}
	pageURL := str(dig(e, "page", "url"))
	if pageURL == "" {
		pageURL = str(dig(e, "task", "url"))
	}
	return map[string]any{
		"uuid": id, "url": pageURL, "domain": str(dig(e, "page", "domain")), "ip": str(dig(e, "page", "ip")),
		"country": str(dig(e, "page", "country")), "time": str(dig(e, "task", "time")),
		"link": urlscanResultLink(id), "screenshot": str(e["screenshot"]),
	}
}

// urlscanVerdict reads verdicts.overall: the score (-100..100), whether urlscan.io calls it malicious and whether it
// has a verdict at all.
func urlscanVerdict(raw map[string]any) (score int, malicious, has bool) {
	v := object(dig(raw, "verdicts", "overall"))
	return intOf(v["score"]), boolOf(v["malicious"]), boolOf(v["hasVerdicts"]) || boolOf(v["malicious"]) || v["score"] != nil
}

func urlscanResultSummary(raw map[string]any, uuid string) map[string]any {
	score, malicious, _ := urlscanVerdict(raw)
	v := object(dig(raw, "verdicts", "overall"))
	return map[string]any{
		"uuid": uuid, "url": str(dig(raw, "page", "url")), "domain": str(dig(raw, "page", "domain")),
		"ip": str(dig(raw, "page", "ip")), "country": str(dig(raw, "page", "country")), "server": str(dig(raw, "page", "server")),
		"status": str(dig(raw, "page", "status")), "time": str(dig(raw, "task", "time")),
		"score": score, "malicious": malicious, "categories": stringList(v["categories"]), "tags": stringList(v["tags"]),
		"link": urlscanResultLink(uuid), "screenshot": "https://urlscan.io/screenshots/" + url.PathEscape(uuid) + ".png",
	}
}

// urlscanQuery is the search query that finds scans of an IOC; "" when urlscan.io has no field for it.
func urlscanQuery(o ioc) string {
	esc := strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(o.Value)
	switch o.Type {
	case iocIP:
		return `ip:"` + esc + `"`
	case iocDomain:
		return `domain:"` + esc + `"`
	case iocURL:
		return `page.url:"` + esc + `"`
	}
	return ""
}

// enrichURLScan is urlscan.io's side of IOC Enrich: the newest public scan of the IOC (one search, then that scan's
// result). malicious is urlscan.io's own verdict on it, and the score 100 when it is, else 0; scans without a verdict,
// and IOCs never scanned, give no verdict. If the result cannot be read the answer says so and carries no verdict.
func enrichURLScan(ctx context.Context, c *apiClient, o ioc) serviceResult {
	q := urlscanQuery(o)
	res := serviceResult{Link: urlscanSearchLink(q)}
	raw, err := urlscanSearch(ctx, c, q, 5)
	if err != nil {
		return res.fail(err)
	}
	hits := list(raw["results"])
	total := intOf(raw["total"])
	if len(hits) == 0 {
		res.Summary = "no public scans"
		return res
	}
	total = max(total, len(hits))
	latest := urlscanHit(object(hits[0]))
	uuid := str(latest["uuid"])
	res.Link = urlscanResultLink(uuid)
	res.Summary = fmt.Sprintf("%d public scans, latest %s", total, str(latest["time"]))
	full, err := urlscanResult(ctx, c, uuid)
	if err != nil {
		res.Summary += " (its verdict could not be read)"
		return res
	}
	score, malicious, has := urlscanVerdict(full)
	if !has {
		res.Summary += ", no verdict"
		return res
	}
	res.Malicious = ptr(malicious)
	if malicious {
		res.Score = ptr(100)
		res.Summary += fmt.Sprintf(", verdict malicious (score %d)", score)
	} else {
		res.Score = ptr(0)
		res.Summary += fmt.Sprintf(", verdict not malicious (score %d)", score)
	}
	return res
}
