package landflow

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"sync"
	"time"

	"go.opentelemetry.io/otel/trace"
)

// ExecuteContext is what a node sees during Execute. It is transport-agnostic:
// the HTTP and gRPC servers build it from the same ExecuteRequest.
//
// It is also a context.Context carrying the plugin.execute span: pass ctx
// straight to database drivers and other libraries, and to
// landflow.HTTPClient, so their work joins the workflow's trace.
type ExecuteContext struct {
	callScope
	// Logger collects log lines into ExecuteResponse.logs and writes them to
	// the process log with the trace context.
	Logger *Logger

	req        *ExecuteRequest
	descriptor *NodeDescriptor

	pollMu       sync.Mutex
	pollState    map[string]any
	pollStateSet bool
}

// NewExecuteContext builds a context for req against the node described by
// descriptor. The SDK calls this for you; it is exported for unit tests of
// node implementations (spans and metrics are no-ops, logs are only collected).
func NewExecuteContext(ctx context.Context, req *ExecuteRequest, descriptor *NodeDescriptor) *ExecuteContext {
	if ctx == nil {
		ctx = context.Background()
	}
	if req == nil {
		req = &ExecuteRequest{}
	}
	if descriptor == nil {
		descriptor = &NodeDescriptor{}
	}
	return &ExecuteContext{
		callScope: callScope{ctx: ctx, creds: req.Credentials},
		Logger:    &Logger{}, req: req, descriptor: descriptor,
	}
}

// InputData returns the items on main input index (nil when absent).
func (c *ExecuteContext) InputData(index int) []Item {
	if index < 0 || index >= len(c.req.Inputs) {
		return nil
	}
	return c.req.Inputs[index]
}

// Node returns the workflow node being executed.
func (c *ExecuteContext) Node() NodeRef { return c.req.Node }

// Mode returns why the node runs (manual, trigger, webhook, tool, chat, poll).
func (c *ExecuteContext) Mode() ExecutionMode { return c.req.Mode }

// ExecutionID returns the host's execution id.
func (c *ExecuteContext) ExecutionID() string { return c.req.ExecutionID }

// WorkflowID returns the workflow id (may be empty).
func (c *ExecuteContext) WorkflowID() string { return c.req.WorkflowID }

// ---------------------------------------------------------------------------
// Polling triggers (docs/protocol.md §8)
// ---------------------------------------------------------------------------

// ContinueOnFail reports that the node continues on error (n8n's "Continue On
// Fail"): catch a failing item, append Item{JSON: {"error": err.Error()},
// PairedItem: …} and go on with the next item instead of returning the error.
func (c *ExecuteContext) ContinueOnFail() bool { return c.req.ContinueOnFail }

// ErrorItem is the output item for a failed item i when the node continues on
// fail: {"error": message} plus "description" when err has one, with the
// call's credential values masked, paired with input item i.
//
//	if err != nil {
//		if ctx.ContinueOnFail() {
//			out = append(out, ctx.ErrorItem(i, err))
//			continue
//		}
//		return nil, err
//	}
func (c *ExecuteContext) ErrorItem(i int, err error) Item {
	p := errorPayload(err)
	json := map[string]any{"error": RedactString(c, p.Message)}
	if p.Description != "" {
		json["description"] = RedactString(c, p.Description)
	}
	return Item{JSON: json, PairedItem: &PairedItem{Item: i}}
}

// PollState returns the state the previous poll returned (nil on the first
// poll and outside mode "poll").
func (c *ExecuteContext) PollState() map[string]any { return c.req.PollState }

// IsFirstPoll reports a poll without previous state: establish the baseline
// (e.g. remember the newest id) and return no items, so activating a
// workflow does not replay history.
func (c *ExecuteContext) IsFirstPoll() bool { return c.req.Mode == ModePoll && c.req.PollState == nil }

// SetPollState sets the state passed to the next poll (ExecuteResponse.pollState),
// e.g. {"lastId": 123} or {"since": "2026-10-25T10:00:00Z"}. It is only sent
// in mode "poll"; in manual mode it is dropped, as the protocol requires.
func (c *ExecuteContext) SetPollState(state map[string]any) {
	c.pollMu.Lock()
	defer c.pollMu.Unlock()
	c.pollState, c.pollStateSet = state, true
}

func (c *ExecuteContext) nextPollState() (map[string]any, bool) {
	c.pollMu.Lock()
	defer c.pollMu.Unlock()
	return c.pollState, c.pollStateSet
}

// Request returns the raw request.
func (c *ExecuteContext) Request() *ExecuteRequest { return c.req }

// Param resolves parameter name for item itemIndex. Lookup order:
// itemParameters[itemIndex][name], parameters[name], then the property's
// `default` from the descriptor. JSON null counts as unset. Returns nil when
// nothing matches.
func (c *ExecuteContext) Param(name string, itemIndex int) any {
	v, _ := c.lookup(name, itemIndex)
	return v
}

// HasParam reports whether name resolves to a non-null value for itemIndex.
func (c *ExecuteContext) HasParam(name string, itemIndex int) bool {
	_, ok := c.lookup(name, itemIndex)
	return ok
}

func (c *ExecuteContext) lookup(name string, itemIndex int) (any, bool) {
	if itemIndex >= 0 && itemIndex < len(c.req.ItemParameters) {
		if v, ok := c.req.ItemParameters[itemIndex][name]; ok && v != nil {
			return v, true
		}
	}
	if v, ok := c.req.Parameters[name]; ok && v != nil {
		return v, true
	}
	if p := c.property(name, itemIndex); p != nil && p.Default != nil {
		return p.Default, true
	}
	return nil, false
}

// property finds the top-level property called name. When several share the
// name (n8n allows that, with different displayOptions) the first one visible
// for the item's parameters wins.
func (c *ExecuteContext) property(name string, itemIndex int) *PropertyDescriptor {
	var first *PropertyDescriptor
	var candidates int
	for i := range c.descriptor.Properties {
		p := &c.descriptor.Properties[i]
		if p.Name != name {
			continue
		}
		candidates++
		if first == nil {
			first = p
		}
	}
	if candidates <= 1 {
		return first
	}
	values := c.paramsFor(itemIndex)
	for i := range c.descriptor.Properties {
		p := &c.descriptor.Properties[i]
		if p.Name == name && isVisible(p.DisplayOptions, values) {
			return p
		}
	}
	return first
}

func (c *ExecuteContext) paramsFor(itemIndex int) map[string]any {
	merged := map[string]any{}
	for i := range c.descriptor.Properties {
		p := c.descriptor.Properties[i]
		if p.Default != nil {
			merged[p.Name] = p.Default
		}
	}
	for k, v := range c.req.Parameters {
		merged[k] = v
	}
	if itemIndex >= 0 && itemIndex < len(c.req.ItemParameters) {
		for k, v := range c.req.ItemParameters[itemIndex] {
			merged[k] = v
		}
	}
	return merged
}

// ParamString resolves name as a string. Numbers and booleans are formatted;
// other values are JSON-encoded. def is returned when the parameter is unset.
func (c *ExecuteContext) ParamString(name string, itemIndex int, def string) string {
	v, ok := c.lookup(name, itemIndex)
	if !ok {
		return def
	}
	return Stringify(v)
}

// ParamInt resolves name as an int (numbers are truncated, numeric strings
// parsed). def is returned when unset or not convertible.
func (c *ExecuteContext) ParamInt(name string, itemIndex int, def int) int {
	f, ok := c.number(name, itemIndex)
	if !ok || math.IsNaN(f) || math.IsInf(f, 0) {
		return def
	}
	return int(f)
}

// ParamFloat resolves name as a float64. def is returned when unset or not
// convertible.
func (c *ExecuteContext) ParamFloat(name string, itemIndex int, def float64) float64 {
	f, ok := c.number(name, itemIndex)
	if !ok {
		return def
	}
	return f
}

// ParamBool resolves name as a bool. Accepts booleans, "true"/"false"/"1"/"0"
// style strings and numbers (non-zero = true). def is returned otherwise.
func (c *ExecuteContext) ParamBool(name string, itemIndex int, def bool) bool {
	v, ok := c.lookup(name, itemIndex)
	if !ok {
		return def
	}
	switch t := v.(type) {
	case bool:
		return t
	case string:
		if b, err := strconv.ParseBool(strings.TrimSpace(t)); err == nil {
			return b
		}
		return def
	default:
		if f, ok := toFloat(v); ok {
			return f != 0
		}
		return def
	}
}

func (c *ExecuteContext) number(name string, itemIndex int) (float64, bool) {
	v, ok := c.lookup(name, itemIndex)
	if !ok {
		return 0, false
	}
	return toFloat(v)
}

func toFloat(v any) (float64, bool) {
	switch t := v.(type) {
	case float64:
		return t, true
	case float32:
		return float64(t), true
	case int:
		return float64(t), true
	case int8:
		return float64(t), true
	case int16:
		return float64(t), true
	case int32:
		return float64(t), true
	case int64:
		return float64(t), true
	case uint:
		return float64(t), true
	case uint8:
		return float64(t), true
	case uint16:
		return float64(t), true
	case uint32:
		return float64(t), true
	case uint64:
		return float64(t), true
	case json.Number:
		f, err := t.Float64()
		return f, err == nil
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(t), 64)
		return f, err == nil
	case bool:
		if t {
			return 1, true
		}
		return 0, true
	}
	return 0, false
}

// Stringify renders a JSON value as text: strings as-is, numbers without
// exponent noise, booleans as true/false, nil as "", everything else as JSON.
func Stringify(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case bool:
		return strconv.FormatBool(t)
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case float32:
		return strconv.FormatFloat(float64(t), 'f', -1, 32)
	case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64:
		return fmt.Sprint(t)
	case json.Number:
		return t.String()
	default:
		b, err := json.Marshal(t)
		if err != nil {
			return fmt.Sprint(t)
		}
		return string(b)
	}
}

// isVisible evaluates n8n-style displayOptions against parameter values.
func isVisible(d *DisplayOptions, values map[string]any) bool {
	if d == nil {
		return true
	}
	for key, allowed := range d.Show {
		if !containsLoose(allowed, values[key]) {
			return false
		}
	}
	for key, blocked := range d.Hide {
		if containsLoose(blocked, values[key]) {
			return false
		}
	}
	return true
}

func containsLoose(list []any, v any) bool {
	for _, candidate := range list {
		if looseEqual(candidate, v) {
			return true
		}
	}
	return false
}

func looseEqual(a, b any) bool {
	if fa, ok := numberOnly(a); ok {
		fb, ok := numberOnly(b)
		return ok && fa == fb
	}
	return a == b
}

func numberOnly(v any) (float64, bool) {
	switch v.(type) {
	case string, bool, nil:
		return 0, false
	}
	return toFloat(v)
}

// ---------------------------------------------------------------------------
// callScope: what ExecuteContext and LoadOptionsContext share
// ---------------------------------------------------------------------------

// callScope implements context.Context, credentials, spans and metrics for
// one call. Its methods are promoted to ExecuteContext and LoadOptionsContext.
type callScope struct {
	ctx     context.Context // carries the server span and the scope
	creds   map[string]any
	metrics *Metrics
	once    sync.Once
}

// Context returns the request context carrying the server span; it is
// cancelled when the caller goes away.
func (c *callScope) Context() context.Context { return c.ctx }

// Deadline, Done, Err and Value make the call context a context.Context.
func (c *callScope) Deadline() (time.Time, bool) { return c.ctx.Deadline() }
func (c *callScope) Done() <-chan struct{}       { return c.ctx.Done() }
func (c *callScope) Err() error                  { return c.ctx.Err() }
func (c *callScope) Value(key any) any           { return c.ctx.Value(key) }

// Credentials returns the decrypted data of credential type name (nil when
// the host sent none). Called without a name it returns every credential
// keyed by type name, as before credential types existed.
//
//	token := ctx.Credentials("telegramApi").String("accessToken")
func (c *callScope) Credentials(name ...string) CredentialData {
	return credentialsFrom(c.creds, name)
}

// HasCredentials reports whether the host sent credentials of type name.
func (c *callScope) HasCredentials(name string) bool {
	return asCredentialData(c.creds[name]) != nil
}

// RequireCredentials returns credential type name's data, or a NodeError
// telling the user to select a credential.
func (c *callScope) RequireCredentials(name string) (CredentialData, error) {
	if d := asCredentialData(c.creds[name]); d != nil {
		return d, nil
	}
	return nil, missingCredentials(name)
}

// CredentialString returns field of credential type name as a string ("" when unset).
func (c *callScope) CredentialString(name, field string) string {
	return c.Credentials(name).String(field)
}

// CredentialInt returns field of credential type name as an int, or def.
func (c *callScope) CredentialInt(name, field string, def int) int {
	return c.Credentials(name).Int(field, def)
}

// CredentialBool returns field of credential type name as a bool, or def.
func (c *callScope) CredentialBool(name, field string, def bool) bool {
	return c.Credentials(name).Bool(field, def)
}

// Span runs fn inside a child span (kind internal) of the call's server span
// and ends it when fn returns. A returned error (or panic) marks the span
// failed and is passed through. Use a low-cardinality name
// ("telegram.send"); details go into attrs. The Span is a context.Context:
// pass it to libraries so their spans nest under it.
//
//	err := ctx.Span("telegram.send", landflow.Attrs{"telegram.chat_type": t}, func(span landflow.Span) error {
//		resp, err := landflow.HTTPClient(span).Post(…)
//		…
//	})
func (c *callScope) Span(name string, attrs Attrs, fn func(span Span) error) error {
	return runSpan(c.ctx, name, trace.SpanKindInternal, attrs, fn)
}

// StartSpan opens a child span that the caller must End (for code that
// cannot be wrapped in a callback, e.g. driver hooks).
func (c *callScope) StartSpan(name string, attrs Attrs) Span {
	return startSpan(c.ctx, name, trace.SpanKindInternal, attrs)
}

// DBSpan runs fn inside a database client span named "{operation}
// {collection}" with db.system, db.operation.name, db.collection.name,
// db.namespace and db.query.text set from info.
//
//	err := ctx.DBSpan(landflow.DBSpanInfo{System: "postgresql", Operation: "SELECT", Collection: "users",
//		Namespace: "app", Statement: "SELECT id, email FROM users WHERE id = $1"}, func(span landflow.Span) error {
//		rows, err = pool.Query(span, sql, id)
//		return err
//	})
func (c *callScope) DBSpan(info DBSpanInfo, fn func(span Span) error) error {
	return runDBSpan(c.ctx, info, fn)
}

// Metrics returns the custom metrics API bound to this call
// (landflow.plugin.id, landflow.node.type and landflow.workflow.id are added).
func (c *callScope) Metrics() *Metrics {
	c.once.Do(func() { c.metrics = newMetrics(scopeFrom(c.ctx)) })
	return c.metrics
}

// TraceID returns the hex trace id of the call ("" when untraced).
func (c *callScope) TraceID() string { return Span{ctx: c.ctx}.TraceID() }

// MetricsFrom returns the custom metrics API for code that only has a
// context.Context, such as the context given to CredentialType.Test (where
// landflow.plugin.id is added). From an ExecuteContext use ctx.Metrics().
func MetricsFrom(ctx context.Context) *Metrics { return newMetrics(scopeFrom(ctx)) }

// DBSpanFrom runs fn inside a database client span (see DBSpan) under ctx,
// for code that only has a context.Context, such as CredentialType.Test.
func DBSpanFrom(ctx context.Context, info DBSpanInfo, fn func(span Span) error) error {
	if ctx == nil {
		ctx = context.Background()
	}
	return runDBSpan(ctx, info, fn)
}

// ---------------------------------------------------------------------------
// LoadOptionsContext
// ---------------------------------------------------------------------------

// OptionsLoaderWithContext is the context-aware form of OptionsLoader: the
// context carries the credentials the host sent, the parameters and the
// plugin.load_options span (so landflow.HTTPClient(ctx) is traced). A node
// implements either interface; this one wins when both are present.
type OptionsLoaderWithContext interface {
	LoadOptionsWithContext(ctx *LoadOptionsContext) ([]PropertyOption, error)
}

// LoadOptionsContext is what a node sees during LoadOptionsWithContext. Like
// ExecuteContext it is a context.Context and offers Credentials, Span,
// DBSpan and Metrics.
type LoadOptionsContext struct {
	callScope
	// Logger writes to the process log (LoadOptions responses carry no logs).
	Logger *Logger

	req        *LoadOptionsRequest
	descriptor *NodeDescriptor
}

// Method returns the requested loadOptionsMethod.
func (c *LoadOptionsContext) Method() string { return c.req.Method }

// NodeType returns the local node name.
func (c *LoadOptionsContext) NodeType() string { return c.descriptor.Name }

// Parameters returns the node's current (unresolved) parameter values.
func (c *LoadOptionsContext) Parameters() map[string]any { return c.req.Parameters }

// Param returns parameter name, falling back to the property's default.
func (c *LoadOptionsContext) Param(name string) any {
	if v, ok := c.req.Parameters[name]; ok && v != nil {
		return v
	}
	for _, p := range c.descriptor.Properties {
		if p.Name == name && p.Default != nil {
			return p.Default
		}
	}
	return nil
}

// ParamString returns Param(name) as a string, or def when unset.
func (c *LoadOptionsContext) ParamString(name, def string) string {
	if v := c.Param(name); v != nil {
		return Stringify(v)
	}
	return def
}

// The call contexts and Span are context.Contexts.
var (
	_ context.Context = (*ExecuteContext)(nil)
	_ context.Context = (*LoadOptionsContext)(nil)
	_ context.Context = Span{}
)
