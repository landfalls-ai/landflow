package main

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	landflow "github.com/landflow/landflow/sdks/go"
)

func newMISPClient(d landflow.CredentialData) *apiClient {
	c := &apiClient{svc: svcMISP, base: normalizeBaseURL(d.String("baseUrl")), headers: map[string]string{}}
	if key := strings.TrimSpace(d.String("apiKey")); key != "" {
		c.headers["Authorization"] = key
	}
	c.insecure = d.Bool("allowUnverifiedTls", false)
	return c
}

func mispNode() *serviceNode {
	search := show("attribute", "search")
	filter := func(name, display, description, placeholder string) landflow.PropertyDescriptor {
		return landflow.PropertyDescriptor{Name: name, DisplayName: display, Type: landflow.PropString, Default: "",
			Description: description, Placeholder: placeholder, DisplayOptions: search}
	}
	return &serviceNode{
		cred: credMISP,
		desc: serviceDescriptor("misp", "MISP",
			"Search the attributes of your own MISP instance for an indicator",
			"Search a MISP instance's attributes (read only): resource=attribute, operation=search, with at least one of value "+
				"(an IP, domain, URL or hash; use % as a wildcard), type (for example ip-dst, domain, md5), tags (comma-separated), "+
				"last (age, for example 7d or 12h), and optional limit. Returns the matching attributes with their event and tags.",
			"https://www.misp-project.org/openapi/#tag/Attributes/operation/restSearchAttributes", []string{"misp", "ioc", "attribute", "threat sharing", "event"}, credMISP,
			[]landflow.PropertyDescriptor{
				resourceProperty("attribute", landflow.PropertyOption{Name: "Attribute", Value: "attribute"}),
				operationProperty("attribute", "search", readOp("Search", "search", "Search attributes with restSearch", "Search attributes")),
				filter("value", "Value", "The indicator to find, such as an IP, domain, URL or hash", "198.51.100.7"),
				filter("type", "Type", "An attribute type, or several separated by commas", "ip-dst"),
				filter("tags", "Tags", "Only attributes with these tags, separated by commas", "tlp:white"),
				filter("last", "Last", "Only attributes newer than this age", "7d"),
				{Name: "limit", DisplayName: "Limit", Type: landflow.PropNumber, Default: 50, Description: "Max number of attributes to return",
					TypeOptions: &landflow.TypeOptions{MinValue: landflow.Ptr(1.0), MaxValue: landflow.Ptr(1000.0), NumberPrecision: landflow.Ptr(0)}, DisplayOptions: search},
				simplifyProperty(search, "Whether to return compact attributes ({id, eventId, type, category, value, toIds, timestamp, comment, tags, eventInfo, link}) instead of MISP's full JSON"),
			}),
		newClient: func(_ *landflow.ExecuteContext, d landflow.CredentialData) *apiClient { return newMISPClient(d) },
		ops: map[opKey]opFunc{{"attribute", "search"}: func(r *run, i int) (map[string]any, error) {
			if r.c.base == "" {
				return nil, userError("Set the MISP credential's API Base URL.", "The MISP credential has no base URL")
			}
			f := mispFilter{
				value: strings.TrimSpace(r.ctx.ParamString("value", i, "")), types: splitList(r.ctx.ParamString("type", i, "")),
				tags: splitList(r.ctx.ParamString("tags", i, "")), last: strings.TrimSpace(r.ctx.ParamString("last", i, "")),
				limit: r.ctx.ParamInt("limit", i, 50),
			}
			if f.value == "" && len(f.types) == 0 && len(f.tags) == 0 && f.last == "" {
				return nil, userError("Give a value, type, tags or last, so the search does not return the whole instance.", "No search filter given")
			}
			attrs, err := mispSearch(r.ctx, r.c, f)
			if err != nil {
				return nil, err
			}
			if !r.ctx.ParamBool("simple", i, true) {
				return map[string]any{"count": len(attrs), "response": map[string]any{"Attribute": attrs}}, nil
			}
			out := []any{}
			for _, a := range attrs {
				out = append(out, mispAttribute(r.c.base, object(a)))
			}
			return map[string]any{"count": len(out), "attributes": out}, nil
		}},
	}
}

type mispFilter struct {
	value, last string
	types, tags []string
	limit       int
}

// mispSearch posts to /attributes/restSearch (a POST, but only a read) and returns the Attribute array.
func mispSearch(ctx context.Context, c *apiClient, f mispFilter) ([]any, error) {
	body := map[string]any{"returnFormat": "json", "limit": min(max(f.limit, 1), 1000), "includeEventTags": true}
	if f.value != "" {
		body["value"] = f.value
	}
	if len(f.types) == 1 {
		body["type"] = f.types[0]
	} else if len(f.types) > 1 {
		body["type"] = f.types
	}
	if len(f.tags) > 0 {
		body["tags"] = f.tags
	}
	if f.last != "" {
		body["last"] = f.last
	}
	var resp struct {
		Response struct {
			Attribute []any `json:"Attribute"`
		} `json:"response"`
	}
	if err := c.do(ctx, http.MethodPost, "/attributes/restSearch", nil, body, &resp); err != nil {
		return nil, err
	}
	return resp.Response.Attribute, nil
}

func mispEventLink(base, eventID string) string {
	if eventID == "" {
		return base
	}
	return base + "/events/view/" + url.PathEscape(eventID)
}

func mispAttribute(base string, a map[string]any) map[string]any {
	tags := []any{}
	for _, t := range list(a["Tag"]) {
		if n := str(object(t)["name"]); n != "" {
			tags = append(tags, n)
		}
	}
	eventID := idString(a["event_id"])
	return map[string]any{
		"id": str(a["id"]), "eventId": eventID, "type": str(a["type"]), "category": str(a["category"]), "value": a["value"],
		"toIds": boolOf(a["to_ids"]), "timestamp": str(a["timestamp"]), "comment": str(a["comment"]), "tags": tags,
		"eventInfo": str(dig(a, "Event", "info")), "link": mispEventLink(base, eventID),
	}
}

// enrichMISP is MISP's side of IOC Enrich. Your own MISP is the most trusted source here: a matching attribute flagged
// for detection (to_ids) is malicious, score 90; a match without it is score 50 and no verdict. No match: no data
// (absence from your MISP says nothing about the indicator).
func enrichMISP(ctx context.Context, c *apiClient, o ioc) serviceResult {
	res := serviceResult{Link: c.base}
	attrs, err := mispSearch(ctx, c, mispFilter{value: o.Value, limit: 25})
	if err != nil {
		return res.fail(err)
	}
	if len(attrs) == 0 {
		res.Summary = "no matching attributes"
		return res
	}
	toIDS, info := 0, ""
	for _, a := range attrs {
		m := object(a)
		if boolOf(m["to_ids"]) {
			toIDS++
		}
		if info == "" {
			info = str(dig(m, "Event", "info"))
		}
	}
	res.Link = mispEventLink(c.base, idString(object(attrs[0])["event_id"]))
	res.Summary = fmt.Sprintf("%d matching attributes, %d flagged for detection", len(attrs), toIDS)
	if info != "" {
		res.Summary += ", event: " + info
	}
	if toIDS > 0 {
		res.Malicious, res.Score = ptr(true), ptr(90)
	} else {
		res.Score = ptr(50)
	}
	return res
}
