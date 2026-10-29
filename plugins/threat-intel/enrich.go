package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"

	landflow "github.com/landflow/landflow/sdks/go"
)

// serviceResult is one service's normalised answer about one IOC.
//
//	malicious  true / false when the service has a verdict, null when it has none (never seen, no data, failed)
//	score      0-100 (higher is worse), null when the service gives no score
//	summary    one line in words; link: the service's own page for the IOC
//	error      only when the lookup failed; the item still succeeds
//	cached     true when the answer came from the in-process cache
type serviceResult struct {
	Service   string `json:"service"`
	Malicious *bool  `json:"malicious"`
	Score     *int   `json:"score"`
	Summary   string `json:"summary"`
	Link      string `json:"link"`
	Error     string `json:"error,omitempty"`
	Cached    bool   `json:"cached,omitempty"`
}

func (r serviceResult) fail(err error) serviceResult {
	r.Malicious, r.Score = nil, nil
	r.Error = err.Error()
	r.Summary = "lookup failed"
	return r
}

// enricher is one service's adapter for IOC Enrich.
type enricher struct {
	id         string
	cred       string
	supports   []iocType
	configured func(d landflow.CredentialData) bool // whether the credential is enough to call the service
	client     func(d landflow.CredentialData) *apiClient
	lookup     func(ctx context.Context, c *apiClient, o ioc) serviceResult
}

func hasKey(d landflow.CredentialData) bool { return strings.TrimSpace(d.String("apiKey")) != "" }

// enrichers lists the services in the order their results are reported.
var enrichers = []enricher{
	{"virustotal", credVirusTotal, []iocType{iocIP, iocDomain, iocURL, iocHash}, hasKey,
		func(d landflow.CredentialData) *apiClient { return newClient(svcVirusTotal, d, "x-apikey") }, enrichVirusTotal},
	{"abuseipdb", credAbuseIPDB, []iocType{iocIP}, hasKey,
		func(d landflow.CredentialData) *apiClient { return newClient(svcAbuseIPDB, d, "Key") }, enrichAbuseIPDB},
	// GreyNoise's Community API works without a key: attaching the credential is what enables it.
	{"greynoise", credGreyNoise, []iocType{iocIP}, func(landflow.CredentialData) bool { return true },
		func(d landflow.CredentialData) *apiClient { return newClient(svcGreyNoise, d, "key") }, enrichGreyNoise},
	{"urlscan", credURLScan, []iocType{iocIP, iocDomain, iocURL}, hasKey,
		func(d landflow.CredentialData) *apiClient { return newClient(svcURLScan, d, "API-Key") }, enrichURLScan},
	{"shodan", credShodan, []iocType{iocIP}, hasKey,
		func(d landflow.CredentialData) *apiClient { return newClient(svcShodan, d, "") }, enrichShodan},
	{"otx", credOTX, []iocType{iocIP, iocDomain, iocURL, iocHash}, hasKey,
		func(d landflow.CredentialData) *apiClient { return newClient(svcOTX, d, "X-OTX-API-KEY") }, enrichOTX},
	{"misp", credMISP, []iocType{iocIP, iocDomain, iocURL, iocHash},
		func(d landflow.CredentialData) bool { return hasKey(d) && normalizeBaseURL(d.String("baseUrl")) != "" },
		newMISPClient, enrichMISP},
}

func (e enricher) supported(t iocType) bool { return slices.Contains(e.supports, t) }

// cacheKey identifies an answer: service, IOC and a fingerprint of the credential (so one tenant's key never serves
// another's cached answer).
func cacheKey(e enricher, d landflow.CredentialData, o ioc) string {
	sum := sha256.Sum256([]byte(d.String("apiKey") + "\x00" + d.String("baseUrl")))
	return strings.Join([]string{e.id, string(o.Type), o.Value, hex.EncodeToString(sum[:6])}, "|")
}

// Overall verdicts.
const (
	verdictMalicious  = "malicious"
	verdictSuspicious = "suspicious"
	verdictClean      = "clean"
	verdictUnknown    = "unknown"
)

// Default overall thresholds (the Options override them).
const (
	defaultMaliciousThreshold  = 70
	defaultSuspiciousThreshold = 30
)

// judge folds the per-service answers of one IOC into the overall verdict.
//
//	malicious   a service says malicious, or the highest score is >= maliciousAt
//	suspicious  the highest score is >= suspiciousAt
//	clean       at least one service says not malicious and none scores >= suspiciousAt
//	unknown     otherwise: no service answered, or none had a verdict
//
// score is the highest service score (nil when none gave one). reasons explain the verdict, one line per service that
// drove it, plus a line for every service that failed.
func judge(rs []serviceResult, maliciousAt, suspiciousAt int) (verdict string, score *int, reasons []string) {
	anyMalicious, anyClean, answered := false, false, 0
	var failed []string
	for _, r := range rs {
		if r.Error != "" {
			failed = append(failed, fmt.Sprintf("%s failed: %s", r.Service, r.Error))
			continue
		}
		if r.Malicious != nil || r.Score != nil {
			answered++
		}
		if r.Malicious != nil && *r.Malicious {
			anyMalicious = true
		}
		if r.Malicious != nil && !*r.Malicious {
			anyClean = true
		}
		if r.Score != nil && (score == nil || *r.Score > *score) {
			score = ptr(*r.Score)
		}
	}
	high := score != nil && *score >= maliciousAt
	mid := score != nil && *score >= suspiciousAt
	switch {
	case anyMalicious || high:
		verdict = verdictMalicious
	case mid:
		verdict = verdictSuspicious
	case anyClean:
		verdict = verdictClean
	default:
		verdict = verdictUnknown
	}
	switch verdict {
	case verdictMalicious, verdictSuspicious:
		for _, r := range rs {
			flagged := r.Error == "" && ((r.Malicious != nil && *r.Malicious) || (r.Score != nil && *r.Score >= suspiciousAt))
			if flagged {
				reasons = append(reasons, r.Service+": "+r.Summary)
			}
		}
	case verdictClean:
		var names []string
		for _, r := range rs {
			if r.Error == "" && r.Malicious != nil && !*r.Malicious {
				names = append(names, r.Service)
			}
		}
		reasons = append(reasons, "no detections from "+strings.Join(names, ", "))
	default:
		switch {
		case len(rs) == 0:
			reasons = append(reasons, "no enabled service with a credential supports this indicator type")
		case answered == 0 && len(failed) < len(rs):
			reasons = append(reasons, "no service had a verdict for it")
		}
	}
	return verdict, score, append(reasons, failed...)
}

// ---------------------------------------------------------------------------
// The node
// ---------------------------------------------------------------------------

// IOCEnrichNode enriches IOCs with every configured threat-intel service and returns one verdict.
type IOCEnrichNode struct{}

func serviceIDs() []any {
	ids := make([]any, len(enrichers))
	for i, e := range enrichers {
		ids[i] = e.id
	}
	return ids
}

func (IOCEnrichNode) Description() landflow.NodeDescriptor {
	creds := make([]landflow.NodeCredentialRequirement, len(enrichers))
	for i, e := range enrichers {
		creds[i] = landflow.NodeCredentialRequirement{Name: e.cred} // each one optional: only attached ones run
	}
	return landflow.NodeDescriptor{
		Name:        "iocEnrich",
		DisplayName: "IOC Enrich",
		Description: "Enrich IPs, domains, URLs and file hashes with every threat-intel service you attach, and get one verdict",
		Version:     landflow.V(1),
		Kind:        landflow.KindAction,
		Categories:  []string{"Security"},
		Icon:        "file:icons/threat-intel.svg",
		Color:       "#0F766E",
		Subtitle:    "threat intel verdict",
		Inputs:      []landflow.PortDescriptor{landflow.MainPort()},
		Outputs:     []landflow.PortDescriptor{landflow.MainPort()},
		Keywords:    []string{"ioc", "enrich", "threat intel", "triage", "soc", "reputation", "verdict", "virustotal", "abuseipdb"},
		Credentials: creds,
		Idempotent:  true,
		// The name does not start with a read verb, so say it: this node only reads.
		ToolAnnotations: &landflow.McpToolAnnotations{ReadOnlyHint: landflow.Ptr(true), DestructiveHint: landflow.Ptr(false), IdempotentHint: landflow.Ptr(true)},
		UsableAsTool:    true,
		ToolDescription: "Enrich indicators of compromise with threat intelligence (read only). Give value (and type: ip, domain, url or " +
			"hash; detected when omitted) or an iocs array of {type, value}. Asks every configured service that supports the type " +
			"and returns threatIntel: verdict (malicious, suspicious, clean or unknown), score (0-100 or null), reasons and one " +
			"result per service. Private, reserved and loopback IPs are skipped.",
		ToolInputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"value": map[string]any{"type": "string", "description": "The IP address, domain, URL or file hash (defanged forms such as hxxp://evil[.]com are accepted)"},
				"type":  map[string]any{"type": "string", "enum": []any{"ip", "domain", "url", "hash"}, "description": "What value is; detected when omitted"},
				"iocs": map[string]any{"type": "array", "description": "Several indicators at once", "items": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"type":  map[string]any{"type": "string", "enum": []any{"ip", "domain", "url", "hash"}},
						"value": map[string]any{"type": "string"},
					},
					"required": []any{"value"},
				}},
			},
		},
		Properties: []landflow.PropertyDescriptor{
			{Name: "iocPath", DisplayName: "IOC Field", Type: landflow.PropString, Default: "ioc",
				Description: "Dot path to the item's IOC: an object {type, value} or a plain string. Used when the item has no IOCs array.", Placeholder: "alert.ioc"},
			{Name: "typePath", DisplayName: "Type Field", Type: landflow.PropString, Default: "type",
				Description: "Dot path to the IOC type (ip, domain, url or hash; empty or auto detects it). Used when the item has no IOC object."},
			{Name: "valuePath", DisplayName: "Value Field", Type: landflow.PropString, Default: "value",
				Description: "Dot path to the IOC value. Used when the item has no IOC object."},
			{Name: "iocsPath", DisplayName: "IOCs Array Field", Type: landflow.PropString, Default: "iocs",
				Description: "Dot path to an array of IOCs ({type, value} objects or plain strings). When the item has one, it wins over the single IOC fields."},
			{Name: "services", DisplayName: "Services", Type: landflow.PropMultiOptions, Default: serviceIDs(),
				Description: "Which services may be asked. A service also needs its credential attached to this node (GreyNoise's key is optional but the credential is not).",
				Options: []landflow.PropertyOption{
					{Name: "VirusTotal", Value: "virustotal", Description: "IP, domain, URL, hash"},
					{Name: "AbuseIPDB", Value: "abuseipdb", Description: "IP"},
					{Name: "GreyNoise", Value: "greynoise", Description: "IP"},
					{Name: "urlscan.io", Value: "urlscan", Description: "IP, domain, URL"},
					{Name: "Shodan", Value: "shodan", Description: "IP"},
					{Name: "AlienVault OTX", Value: "otx", Description: "IP, domain, URL, hash"},
					{Name: "MISP", Value: "misp", Description: "IP, domain, URL, hash"},
				}},
			{Name: "cacheTtl", DisplayName: "Cache TTL (Seconds)", Type: landflow.PropNumber, Default: 3600,
				Description: "How long a service's answer is reused for the same IOC, so a burst of alerts does not spend the API quota. 0 turns the cache off. The cache lives in the plugin process; failed lookups are never cached.",
				TypeOptions: &landflow.TypeOptions{MinValue: landflow.Ptr(0.0), NumberPrecision: landflow.Ptr(0)}},
			{Name: "options", DisplayName: "Options", Type: landflow.PropCollection, Default: map[string]any{}, Placeholder: "Add Option",
				Values: []landflow.PropertyDescriptor{
					{Name: "enrichAll", DisplayName: "Enrich Every Array Element", Type: landflow.PropBoolean, Default: true,
						Description: "When the item has an IOCs array, enrich every element (off: only the first)"},
					{Name: "concurrency", DisplayName: "Concurrency", Type: landflow.PropNumber, Default: defaultConcurrency,
						Description: "How many service calls run at once (1-10)",
						TypeOptions: &landflow.TypeOptions{MinValue: landflow.Ptr(1.0), MaxValue: landflow.Ptr(float64(maxConcurrency)), NumberPrecision: landflow.Ptr(0)}},
					{Name: "maliciousThreshold", DisplayName: "Malicious From Score", Type: landflow.PropNumber, Default: defaultMaliciousThreshold,
						Description: "The overall verdict is malicious when the highest service score reaches this (or a service says malicious)",
						TypeOptions: &landflow.TypeOptions{MinValue: landflow.Ptr(1.0), MaxValue: landflow.Ptr(100.0), NumberPrecision: landflow.Ptr(0)}},
					{Name: "suspiciousThreshold", DisplayName: "Suspicious From Score", Type: landflow.PropNumber, Default: defaultSuspiciousThreshold,
						Description: "The overall verdict is suspicious when the highest service score reaches this",
						TypeOptions: &landflow.TypeOptions{MinValue: landflow.Ptr(1.0), MaxValue: landflow.Ptr(100.0), NumberPrecision: landflow.Ptr(0)}},
					{Name: "outputField", DisplayName: "Output Field", Type: landflow.PropString, Default: "threatIntel",
						Description: "The item field that receives the result"},
					{Name: "keepInput", DisplayName: "Keep Input Fields", Type: landflow.PropBoolean, Default: true,
						Description: "Whether the output item keeps the input item's fields next to the result"},
				}},
		},
	}
}

const (
	defaultConcurrency = 4
	maxConcurrency     = 10
)

// plan is one IOC of one item, and the lookups it needs.
type plan struct {
	rawType, rawValue string
	ioc               ioc
	invalid           string // why the IOC could not be parsed
	skip              string // why it is not looked up
	results           []serviceResult
	jobs              []*job
}

type job struct {
	e    enricher
	d    landflow.CredentialData
	p    *plan
	slot int
	ttl  time.Duration
}

// itemPlan is one input item.
type itemPlan struct {
	array              bool
	plans              []*plan
	maliciousAt, susAt int
}

func (IOCEnrichNode) Execute(ctx *landflow.ExecuteContext) ([][]landflow.Item, error) {
	items := ctx.InputData(0)
	if len(items) == 0 {
		return nil, nil
	}
	creds := map[string]landflow.CredentialData{}
	for _, e := range enrichers {
		if ctx.HasCredentials(e.cred) {
			if d := ctx.Credentials(e.cred); e.configured(d) {
				creds[e.id] = d
			}
		}
	}

	plans := make([]*itemPlan, len(items))
	failed := make([]error, len(items))
	var jobs []*job
	for i, item := range items {
		ip, err := planItem(ctx, i, item.JSON, creds)
		if err != nil {
			failed[i] = err
			continue
		}
		plans[i] = ip
		for _, p := range ip.plans {
			jobs = append(jobs, p.jobs...)
		}
	}
	runJobs(ctx, jobs, optInt(ctx, 0, "concurrency", defaultConcurrency, 1, maxConcurrency))

	out := make([]landflow.Item, 0, len(items))
	for i, item := range items {
		if failed[i] != nil {
			if ctx.ContinueOnFail() {
				out = append(out, ctx.ErrorItem(i, itemError(i, failed[i])))
				continue
			}
			return nil, itemError(i, failed[i])
		}
		result := plans[i].render()
		json := map[string]any{}
		if optBool(ctx, i, "keepInput", true) {
			for k, v := range item.JSON {
				json[k] = v
			}
		}
		json[optString(ctx, i, "outputField", "threatIntel")] = toMap(result)
		out = append(out, landflow.Item{JSON: json, PairedItem: &landflow.PairedItem{Item: i}})
	}
	return [][]landflow.Item{out}, nil
}

// planItem finds the item's IOCs and the lookups each needs.
func planItem(ctx *landflow.ExecuteContext, i int, data map[string]any, creds map[string]landflow.CredentialData) (*itemPlan, error) {
	raws, array, err := extractIOCs(ctx, i, data)
	if err != nil {
		return nil, err
	}
	ip := &itemPlan{
		array:       array,
		maliciousAt: optInt(ctx, i, "maliciousThreshold", defaultMaliciousThreshold, 1, 100),
		susAt:       optInt(ctx, i, "suspiciousThreshold", defaultSuspiciousThreshold, 1, 100),
	}
	enabled := enabledServices(ctx, i)
	ttl := time.Duration(max(ctx.ParamInt("cacheTtl", i, 3600), 0)) * time.Second
	for _, r := range raws {
		p := &plan{rawType: r.typ, rawValue: r.value}
		o, perr := parseIOC(r.typ, r.value)
		if perr != nil {
			if !array {
				return nil, userError("Check the item's IOC type and value fields.", "Invalid indicator: %v", perr)
			}
			p.invalid = perr.Error()
		} else {
			p.ioc = o
			p.skip = skipReason(o)
		}
		if p.invalid == "" && p.skip == "" {
			for _, e := range enrichers {
				d, ok := creds[e.id]
				if ok && enabled[e.id] && e.supported(p.ioc.Type) {
					p.jobs = append(p.jobs, &job{e: e, d: d, p: p, slot: len(p.jobs), ttl: ttl})
				}
			}
			p.results = make([]serviceResult, len(p.jobs))
		}
		ip.plans = append(ip.plans, p)
	}
	return ip, nil
}

type rawIOC struct{ typ, value string }

// extractIOCs reads the item's IOCs: the IOCs array (every element, or the first), else the IOC object or string,
// else the type and value fields. array reports which of the two shapes it was.
func extractIOCs(ctx *landflow.ExecuteContext, i int, data map[string]any) (iocs []rawIOC, array bool, err error) {
	path := func(name, def string) string { return strings.TrimSpace(ctx.ParamString(name, i, def)) }
	if arr, ok := getPath(data, path("iocsPath", "iocs")).([]any); ok {
		// An empty array (Extract IOCs found none) is nothing to look up: the verdict is unknown, not an error.
		if len(arr) == 0 {
			return nil, true, nil
		}
		if !optBool(ctx, i, "enrichAll", true) {
			arr = arr[:1]
		}
		for _, e := range arr {
			iocs = append(iocs, toRaw(e))
		}
		return iocs, true, nil
	}
	if v := getPath(data, path("iocPath", "ioc")); v != nil {
		if r := toRaw(v); r.value != "" {
			return []rawIOC{r}, false, nil
		}
	}
	if v := getPath(data, path("valuePath", "value")); v != nil && landflow.Stringify(v) != "" {
		return []rawIOC{{typ: landflow.Stringify(getPath(data, path("typePath", "type"))), value: landflow.Stringify(v)}}, false, nil
	}
	return nil, false, userError(
		fmt.Sprintf("Expected %q ({type, value}), %q and %q, or an array at %q.", path("iocPath", "ioc"), path("typePath", "type"), path("valuePath", "value"), path("iocsPath", "iocs")),
		"The item carries no IOC")
}

// toRaw reads a {type, value} object or a plain string.
func toRaw(v any) rawIOC {
	if m, ok := v.(map[string]any); ok {
		r := rawIOC{value: landflow.Stringify(m["value"])}
		if m["value"] == nil {
			r.value = ""
		}
		if m["type"] != nil {
			r.typ = landflow.Stringify(m["type"])
		}
		return r
	}
	if v == nil {
		return rawIOC{}
	}
	return rawIOC{value: landflow.Stringify(v)}
}

// getPath follows a dot path through objects and arrays (a numeric segment indexes an array). A key that itself
// contains dots is tried first.
func getPath(data map[string]any, path string) any {
	if path == "" {
		return nil
	}
	if v, ok := data[path]; ok {
		return v
	}
	return dig(data, strings.Split(path, ".")...)
}

func enabledServices(ctx *landflow.ExecuteContext, i int) map[string]bool {
	set := map[string]bool{}
	switch v := ctx.Param("services", i).(type) {
	case []any:
		for _, s := range v {
			set[landflow.Stringify(s)] = true
		}
	case []string:
		for _, s := range v {
			set[s] = true
		}
	case string:
		for _, s := range splitList(v) {
			set[s] = true
		}
	default:
		for _, e := range enrichers {
			set[e.id] = true
		}
	}
	return set
}

// Option readers: options is a collection parameter.
func optValue(ctx *landflow.ExecuteContext, i int, name string) (any, bool) {
	m := asMap(ctx.Param("options", i))
	v, ok := m[name]
	return v, ok && v != nil
}

func optInt(ctx *landflow.ExecuteContext, i int, name string, def, lo, hi int) int {
	v, ok := optValue(ctx, i, name)
	if !ok {
		return def
	}
	f, ok := num(v)
	if !ok {
		return def
	}
	return min(max(int(f), lo), hi)
}

func optBool(ctx *landflow.ExecuteContext, i int, name string, def bool) bool {
	v, ok := optValue(ctx, i, name)
	if !ok {
		return def
	}
	switch t := v.(type) {
	case bool:
		return t
	case string:
		return strings.EqualFold(strings.TrimSpace(t), "true")
	}
	return def
}

func optString(ctx *landflow.ExecuteContext, i int, name, def string) string {
	if v, ok := optValue(ctx, i, name); ok {
		if s := strings.TrimSpace(landflow.Stringify(v)); s != "" {
			return s
		}
	}
	return def
}

// runJobs runs the lookups with at most workers in flight.
func runJobs(ctx context.Context, jobs []*job, workers int) {
	if len(jobs) == 0 {
		return
	}
	queue := make(chan *job)
	var wg sync.WaitGroup
	for range min(workers, len(jobs)) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := range queue {
				j.run(ctx)
			}
		}()
	}
	for _, j := range jobs {
		queue <- j
	}
	close(queue)
	wg.Wait()
}

func (j *job) run(ctx context.Context) {
	defer func() {
		if r := recover(); r != nil {
			j.p.results[j.slot] = serviceResult{Service: j.e.id, Summary: "lookup failed", Error: fmt.Sprintf("internal error: %v", r)}
		}
	}()
	c := j.e.client(j.d)
	res, cached := cache.do(cacheKey(j.e, j.d, j.p.ioc), j.ttl, func() serviceResult { return j.e.lookup(ctx, c, j.p.ioc) })
	res.Service, res.Cached = j.e.id, cached
	j.p.results[j.slot] = res
}

// render builds the item's result: one IOC's (ioc, verdict, score, reasons, services), or for an IOCs array the worst
// verdict over all of them and the per-IOC results under iocs.
func (ip *itemPlan) render() map[string]any {
	results := make([]map[string]any, 0, len(ip.plans))
	verdicts := make([]string, 0, len(ip.plans))
	var best *int
	for _, p := range ip.plans {
		r := p.render(ip.maliciousAt, ip.susAt)
		results = append(results, r)
		verdicts = append(verdicts, r["verdict"].(string))
		if s, ok := r["score"].(*int); ok && s != nil && (best == nil || *s > *best) {
			best = s
		}
	}
	if !ip.array {
		return results[0]
	}
	// The worst live verdict wins, so "clean" needs every IOC clean. Skipped IOCs do not count unless nothing else is.
	rank := map[string]int{verdictMalicious: 3, verdictSuspicious: 2, verdictUnknown: 1, verdictClean: 0}
	overall, found := verdictUnknown, false
	for k, v := range verdicts {
		if results[k]["skipped"] == true {
			continue
		}
		if !found || rank[v] > rank[overall] {
			overall, found = v, true
		}
	}
	reasons := []string{}
	for k, p := range ip.plans {
		if verdicts[k] == overall && (results[k]["skipped"] != true || !found) {
			for _, r := range results[k]["reasons"].([]string) {
				reasons = append(reasons, ip.label(p)+": "+r)
			}
		}
	}
	if len(ip.plans) == 0 {
		reasons = append(reasons, "no IOCs to look up")
	}
	return map[string]any{"verdict": overall, "score": best, "reasons": reasons, "iocs": results}
}

func (ip *itemPlan) label(p *plan) string {
	if p.invalid != "" {
		return p.rawValue
	}
	return p.ioc.Value
}

func (p *plan) render(maliciousAt, suspiciousAt int) map[string]any {
	switch {
	case p.invalid != "":
		return map[string]any{
			"ioc": map[string]any{"type": p.rawType, "value": p.rawValue}, "verdict": verdictUnknown, "score": (*int)(nil),
			"reasons": []string{"invalid indicator: " + p.invalid}, "services": []any{}, "error": p.invalid,
		}
	case p.skip != "":
		return map[string]any{
			"ioc": p.ioc, "verdict": verdictUnknown, "score": (*int)(nil), "reasons": []string{"skipped: " + p.skip},
			"services": []any{}, "skipped": true, "skipReason": p.skip,
		}
	}
	verdict, score, reasons := judge(p.results, maliciousAt, suspiciousAt)
	if reasons == nil {
		reasons = []string{}
	}
	services := make([]any, len(p.results))
	for i, r := range p.results {
		services[i] = toMap(r)
	}
	return map[string]any{"ioc": p.ioc, "verdict": verdict, "score": score, "reasons": reasons, "services": services}
}
