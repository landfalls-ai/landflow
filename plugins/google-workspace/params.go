package main

import (
	"encoding/json"
	"regexp"
	"strings"

	landflow "github.com/landflow/landflow/sdks/go"
)

// Property builders and parameter helpers shared by the nodes.

// authProperty is n8n's authentication switch; it selects the credential.
func authProperty() landflow.PropertyDescriptor {
	return landflow.PropertyDescriptor{
		Name: "authentication", DisplayName: "Authentication", Type: landflow.PropOptions,
		Default: "serviceAccount", NoDataExpression: true,
		Options: []landflow.PropertyOption{
			{Name: "Service Account", Value: "serviceAccount", Description: "A service account key; share files with its email"},
			{Name: "OAuth2 (Refresh Token)", Value: "oAuth2", Description: "A user's OAuth2 client and refresh token"},
		},
	}
}

// credentialRequirements asks for the credential matching authentication.
func credentialRequirements() []landflow.NodeCredentialRequirement {
	return []landflow.NodeCredentialRequirement{
		{Name: credServiceAccount, Required: true, DisplayOptions: &landflow.DisplayOptions{
			Show: map[string][]any{"authentication": {"serviceAccount"}},
		}},
		{Name: credOAuth2, Required: true, DisplayOptions: &landflow.DisplayOptions{
			Show: map[string][]any{"authentication": {"oAuth2"}},
		}},
	}
}

// show is displayOptions.show for a resource and (optionally) operations.
func show(resource string, operations ...string) *landflow.DisplayOptions {
	d := &landflow.DisplayOptions{Show: map[string][]any{"resource": {resource}}}
	if len(operations) > 0 {
		ops := make([]any, len(operations))
		for i, op := range operations {
			ops[i] = op
		}
		d.Show["operation"] = ops
	}
	return d
}

// with returns a copy of d that also requires key to be one of values.
func with(d *landflow.DisplayOptions, key string, values ...any) *landflow.DisplayOptions {
	out := &landflow.DisplayOptions{Show: map[string][]any{}}
	for k, v := range d.Show {
		out.Show[k] = v
	}
	out.Show[key] = values
	return out
}

// resourceProperty is the resource picker.
func resourceProperty(def string, options ...landflow.PropertyOption) landflow.PropertyDescriptor {
	return landflow.PropertyDescriptor{
		Name: "resource", DisplayName: "Resource", Type: landflow.PropOptions, Default: def,
		NoDataExpression: true, Options: options,
	}
}

// operationProperty is the operation picker of one resource.
func operationProperty(resource, def string, options ...landflow.PropertyOption) landflow.PropertyDescriptor {
	return landflow.PropertyDescriptor{
		Name: "operation", DisplayName: "Operation", Type: landflow.PropOptions, Default: def,
		NoDataExpression: true, Options: options, DisplayOptions: show(resource),
	}
}

// returnAllLimit is n8n's Return All toggle plus Limit (shown when off).
func returnAllLimit(d *landflow.DisplayOptions, defLimit, maxLimit int) []landflow.PropertyDescriptor {
	return []landflow.PropertyDescriptor{
		{
			Name: "returnAll", DisplayName: "Return All", Type: landflow.PropBoolean, Default: false,
			Description: "Whether to return all results or only up to a given limit", DisplayOptions: d,
		},
		{
			Name: "limit", DisplayName: "Limit", Type: landflow.PropNumber, Default: defLimit,
			Description: "Max number of results to return", DisplayOptions: with(d, "returnAll", false),
			TypeOptions: &landflow.TypeOptions{MinValue: landflow.Ptr(1.0), MaxValue: landflow.Ptr(float64(maxLimit)), NumberPrecision: landflow.Ptr(0)},
		},
	}
}

// simplifyProperty is n8n's Simplify toggle.
func simplifyProperty(d *landflow.DisplayOptions) landflow.PropertyDescriptor {
	return landflow.PropertyDescriptor{
		Name: "simple", DisplayName: "Simplify", Type: landflow.PropBoolean, Default: true,
		Description: "Whether to return a simplified version of the response instead of the raw data", DisplayOptions: d,
	}
}

// limitFor resolves Return All / Limit for item i: -1 means all.
func limitFor(ctx *landflow.ExecuteContext, i, def int) int {
	if ctx.ParamBool("returnAll", i, false) {
		return -1
	}
	return max(ctx.ParamInt("limit", i, def), 1)
}

// asMap returns a collection parameter as a map (empty when unset). A JSON
// string is accepted too.
func asMap(v any) map[string]any {
	switch t := v.(type) {
	case map[string]any:
		return t
	case string:
		var m map[string]any
		if json.Unmarshal([]byte(t), &m) == nil && m != nil {
			return m
		}
	}
	return map[string]any{}
}

// entries returns the values of one group of a fixedCollection parameter
// ({"group": [{…}, …]} with multipleValues, {"group": {…}} without).
func entries(v any, group string) []map[string]any {
	switch t := asMap(v)[group].(type) {
	case []any:
		out := make([]map[string]any, 0, len(t))
		for _, e := range t {
			if m, ok := e.(map[string]any); ok {
				out = append(out, m)
			}
		}
		return out
	case map[string]any:
		return []map[string]any{t}
	}
	return nil
}

// getString reads a field of a collection as a string.
func getString(m map[string]any, key, def string) string {
	if v, ok := m[key]; ok && v != nil {
		return landflow.Stringify(v)
	}
	return def
}

// getBool reads a field of a collection as a bool.
func getBool(m map[string]any, key string, def bool) bool {
	return landflow.CredentialData(m).Bool(key, def)
}

// stringList accepts an array or a comma-separated string.
func stringList(v any) []string {
	var raw []string
	switch t := v.(type) {
	case nil:
		return nil
	case []string:
		raw = t
	case []any:
		for _, e := range t {
			raw = append(raw, landflow.Stringify(e))
		}
	default:
		raw = strings.Split(landflow.Stringify(t), ",")
	}
	out := make([]string, 0, len(raw))
	for _, s := range raw {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}

var (
	spreadsheetURLPattern = regexp.MustCompile(`/spreadsheets/d/([a-zA-Z0-9_-]+)`)
	documentURLPattern    = regexp.MustCompile(`/document/d/([a-zA-Z0-9_-]+)`)
	driveURLPattern       = regexp.MustCompile(`(?:/d/|/folders/|[?&]id=)([a-zA-Z0-9_-]+)`)
)

// idFrom accepts an ID or a URL containing one.
func idFrom(value string, pattern *regexp.Regexp) string {
	value = strings.TrimSpace(value)
	if m := pattern.FindStringSubmatch(value); m != nil {
		return m[1]
	}
	return value
}

// requireParam reads a required string parameter for item i.
func requireParam(ctx *landflow.ExecuteContext, name, label string, i int) (string, error) {
	v := strings.TrimSpace(ctx.ParamString(name, i, ""))
	if v == "" {
		return "", userError("Set it in the node's parameters (or map it from the input with an expression).", "%s is required", label)
	}
	return v, nil
}

// cloneMap returns a shallow copy.
func cloneMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

// emit appends results paired to item i.
func emit(out []landflow.Item, i int, results ...map[string]any) []landflow.Item {
	for _, r := range results {
		out = append(out, landflow.Item{JSON: r, PairedItem: &landflow.PairedItem{Item: i}})
	}
	return out
}
