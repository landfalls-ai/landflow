package landflow

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"time"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/baggage"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

// Attrs are span, metric or log attributes. Values may be strings, bools,
// integers, floats, slices of those, fmt.Stringers or anything
// JSON-encodable. Use OTel semantic-convention names or a namespace of your
// own ("telegram.chat_type"). String values of secret-looking keys
// (IsSecretKey) and the current call's credential values are masked.
type Attrs map[string]any

// Span is a span opened by ExecuteContext.Span, DBSpan or StartSpan. It is
// also a context.Context carrying itself: pass it to libraries (database
// drivers, landflow.HTTPClient) so their work becomes a child of this span.
// The zero Span is a valid no-op.
type Span struct {
	ctx context.Context
}

func (s Span) context() context.Context {
	if s.ctx == nil {
		return context.Background()
	}
	return s.ctx
}

// Context returns the context carrying the span.
func (s Span) Context() context.Context { return s.context() }

// Deadline, Done, Err and Value make Span a context.Context.
func (s Span) Deadline() (time.Time, bool) { return s.context().Deadline() }
func (s Span) Done() <-chan struct{}       { return s.context().Done() }
func (s Span) Err() error                  { return s.context().Err() }
func (s Span) Value(key any) any           { return s.context().Value(key) }

// OTel returns the underlying OpenTelemetry span.
func (s Span) OTel() trace.Span { return trace.SpanFromContext(s.context()) }

// TraceID returns the hex trace id ("" when there is no trace).
func (s Span) TraceID() string {
	if sc := s.OTel().SpanContext(); sc.HasTraceID() {
		return sc.TraceID().String()
	}
	return ""
}

// SpanID returns the hex span id ("" when there is no span).
func (s Span) SpanID() string {
	if sc := s.OTel().SpanContext(); sc.HasSpanID() {
		return sc.SpanID().String()
	}
	return ""
}

// SetAttributes adds attributes (redacted, see Attrs).
func (s Span) SetAttributes(attrs Attrs) {
	s.OTel().SetAttributes(scopeFrom(s.ctx).kvs(attrs)...)
}

// SetAttribute adds one attribute.
func (s Span) SetAttribute(key string, value any) { s.SetAttributes(Attrs{key: value}) }

// AddEvent records a point-in-time event on the span.
func (s Span) AddEvent(name string, attrs Attrs) {
	s.OTel().AddEvent(name, trace.WithAttributes(scopeFrom(s.ctx).kvs(attrs)...))
}

// RecordError marks the span failed: error status plus an "exception"
// event, both with credential values masked. A nil err is ignored.
func (s Span) RecordError(err error) {
	if err == nil {
		return
	}
	recordError(s.OTel(), scopeFrom(s.ctx).redact.errString(err), err)
}

// End finishes a span opened with StartSpan. Span and DBSpan end their spans
// themselves.
func (s Span) End() { s.OTel().End() }

// Span runs fn inside a child span of s (see ExecuteContext.Span).
func (s Span) Span(name string, attrs Attrs, fn func(span Span) error) error {
	return runSpan(s.context(), name, trace.SpanKindInternal, attrs, fn)
}

// DBSpan runs fn inside a database client span that is a child of s (see
// ExecuteContext.DBSpan).
func (s Span) DBSpan(info DBSpanInfo, fn func(span Span) error) error {
	return runDBSpan(s.context(), info, fn)
}

// StartSpan opens a child span of s that the caller must End.
func (s Span) StartSpan(name string, attrs Attrs) Span {
	return startSpan(s.context(), name, trace.SpanKindInternal, attrs)
}

func recordError(span trace.Span, msg string, err error) {
	span.SetStatus(codes.Error, msg)
	span.AddEvent("exception", trace.WithAttributes(
		attribute.String("exception.type", fmt.Sprintf("%T", err)),
		attribute.String("exception.message", msg),
	))
}

func startSpan(parent context.Context, name string, kind trace.SpanKind, attrs Attrs) Span {
	if parent == nil {
		parent = context.Background()
	}
	sc := scopeFrom(parent)
	ctx, _ := sc.tel.tracer.Start(parent, name, trace.WithSpanKind(kind), trace.WithAttributes(sc.kvs(attrs)...))
	return Span{ctx: ctx}
}

// runSpan opens a span, runs fn and ends the span, recording fn's error (or
// panic, which is re-raised) on it.
func runSpan(parent context.Context, name string, kind trace.SpanKind, attrs Attrs, fn func(Span) error) (err error) {
	span := startSpan(parent, name, kind, attrs)
	defer func() {
		if r := recover(); r != nil {
			span.RecordError(fmt.Errorf("panic: %v", r))
			span.End()
			panic(r)
		}
		span.RecordError(err)
		span.End()
	}()
	if fn == nil {
		return nil
	}
	return fn(span)
}

// kvs converts Attrs to OTel attributes (sorted by key), masking secrets.
func (s *scope) kvs(attrs Attrs) []attribute.KeyValue {
	if len(attrs) == 0 {
		return nil
	}
	keys := make([]string, 0, len(attrs))
	for k := range attrs {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]attribute.KeyValue, 0, len(keys))
	for _, k := range keys {
		if kv, ok := toKeyValue(k, attrs[k], s.redact); ok {
			out = append(out, kv)
		}
	}
	return out
}

func toKeyValue(key string, v any, red *redactor) (attribute.KeyValue, bool) {
	str := func(s string) attribute.KeyValue {
		return attribute.String(key, red.str(redactKeyed(key, s)))
	}
	switch t := v.(type) {
	case nil:
		return attribute.KeyValue{}, false
	case string:
		return str(t), true
	case bool:
		return attribute.Bool(key, t), true
	case int:
		return attribute.Int(key, t), true
	case int8:
		return attribute.Int64(key, int64(t)), true
	case int16:
		return attribute.Int64(key, int64(t)), true
	case int32:
		return attribute.Int64(key, int64(t)), true
	case int64:
		return attribute.Int64(key, t), true
	case uint:
		return attribute.Int64(key, int64(t)), true
	case uint8:
		return attribute.Int64(key, int64(t)), true
	case uint16:
		return attribute.Int64(key, int64(t)), true
	case uint32:
		return attribute.Int64(key, int64(t)), true
	case uint64:
		return attribute.Int64(key, int64(t)), true
	case float32:
		return attribute.Float64(key, float64(t)), true
	case float64:
		return attribute.Float64(key, t), true
	case json.Number:
		if i, err := t.Int64(); err == nil {
			return attribute.Int64(key, i), true
		}
		if f, err := t.Float64(); err == nil {
			return attribute.Float64(key, f), true
		}
		return str(t.String()), true
	case []string:
		masked := make([]string, len(t))
		for i, s := range t {
			masked[i] = red.str(redactKeyed(key, s))
		}
		return attribute.StringSlice(key, masked), true
	case []bool:
		return attribute.BoolSlice(key, t), true
	case []int:
		return attribute.IntSlice(key, t), true
	case []int64:
		return attribute.Int64Slice(key, t), true
	case []float64:
		return attribute.Float64Slice(key, t), true
	case time.Duration:
		return attribute.Float64(key, float64(t)/float64(time.Millisecond)), true
	case error:
		return str(t.Error()), true
	case fmt.Stringer:
		return str(t.String()), true
	}
	data, err := json.Marshal(v)
	if err != nil {
		return str(fmt.Sprint(v)), true
	}
	return str(string(data)), true
}

// ---------------------------------------------------------------------------
// Database client spans
// ---------------------------------------------------------------------------

// DBSpanInfo describes one database operation for DBSpan (OTel database
// semantic conventions, docs/observability.md §4).
type DBSpanInfo struct {
	// System is db.system: postgresql | mysql | redis | sqlite | mongodb | …
	System string
	// Operation is db.operation.name: SELECT, INSERT, GET, HSET, …
	Operation string
	// Collection is db.collection.name: the table, collection or key prefix.
	Collection string
	// Namespace is db.namespace: the database (Redis: the db index).
	Namespace string
	// Statement is db.query.text. Only ever pass a parameterised statement
	// ("SELECT * FROM users WHERE id = $1"), never one with literal values.
	Statement string
	// ServerAddress / ServerPort are server.address / server.port.
	ServerAddress string
	ServerPort    int
	// Attrs are extra attributes (e.g. "db.response.returned_rows").
	Attrs Attrs
}

// SpanName is "{operation} {collection}", "{operation}" or "db.query".
func (i DBSpanInfo) SpanName() string {
	switch {
	case i.Operation != "" && i.Collection != "":
		return i.Operation + " " + i.Collection
	case i.Operation != "":
		return i.Operation
	}
	return "db.query"
}

func (i DBSpanInfo) attrs() Attrs {
	a := Attrs{}
	for k, v := range i.Attrs {
		a[k] = v
	}
	set := func(k, v string) {
		if v != "" {
			a[k] = v
		}
	}
	set("db.system", i.System)
	set("db.operation.name", i.Operation)
	set("db.collection.name", i.Collection)
	set("db.namespace", i.Namespace)
	set("db.query.text", i.Statement)
	set("server.address", i.ServerAddress)
	if i.ServerPort > 0 {
		a["server.port"] = i.ServerPort
	}
	return a
}

func runDBSpan(parent context.Context, info DBSpanInfo, fn func(Span) error) error {
	return runSpan(parent, info.SpanName(), trace.SpanKindClient, info.attrs(), fn)
}

// ---------------------------------------------------------------------------
// Traced HTTP client
// ---------------------------------------------------------------------------

// HTTPClient returns an *http.Client whose requests are traced: each one is
// an "HTTP {METHOD}" client span (http.request.method, server.address,
// url.full without query string, http.response.status_code), carries
// traceparent/tracestate/baggage, and feeds http.client.request.duration.
//
// ctx is an *ExecuteContext, *LoadOptionsContext, Span, or the context given
// to CredentialType.Test. Requests built with http.NewRequestWithContext keep
// their own context; requests without a span (client.Get(url),
// http.NewRequest) become children of ctx and are cancelled with it.
//
//	resp, err := landflow.HTTPClient(ctx).Get(baseURL + "/getMe")
func HTTPClient(ctx context.Context) *http.Client {
	return &http.Client{Transport: HTTPTransport(ctx, nil)}
}

// HTTPTransport is HTTPClient's RoundTripper, for clients you build yourself
// (e.g. an oauth2.Transport's Base). base nil means http.DefaultTransport.
func HTTPTransport(ctx context.Context, base http.RoundTripper) http.RoundTripper {
	if ctx == nil {
		ctx = context.Background()
	}
	tel := scopeFrom(ctx).tel
	rt := tel.httpRT
	if base != nil {
		rt = otelhttp.NewTransport(sanitizeTransport{next: base},
			otelhttp.WithTracerProvider(tel.tp), otelhttp.WithMeterProvider(tel.mp), otelhttp.WithPropagators(tel.propagator),
			otelhttp.WithSpanNameFormatter(func(_ string, r *http.Request) string { return "HTTP " + r.Method }))
	}
	return parentTransport{parent: ctx, next: rt}
}

// parentTransport gives requests that carry no span the parent context.
type parentTransport struct {
	parent context.Context
	next   http.RoundTripper
}

func (t parentTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	rc := r.Context()
	if !trace.SpanContextFromContext(rc).IsValid() {
		if rc == context.Background() || rc == context.TODO() {
			rc = t.parent
		} else {
			rc = trace.ContextWithSpan(rc, trace.SpanFromContext(t.parent))
			rc = baggage.ContextWithBaggage(rc, baggage.FromContext(t.parent))
		}
		r = r.WithContext(rc)
	}
	if rc.Value(scopeKey{}) == nil {
		if s, ok := t.parent.Value(scopeKey{}).(*scope); ok {
			r = r.WithContext(withScope(rc, s))
		}
	}
	return t.next.RoundTrip(r)
}

// sanitizeTransport runs inside otelhttp's span and rewrites url.full
// without userinfo, query string and fragment, masking credential values
// (e.g. a bot token in the path).
type sanitizeTransport struct {
	next http.RoundTripper
}

func (t sanitizeTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if span := trace.SpanFromContext(r.Context()); span.IsRecording() && r.URL != nil {
		span.SetAttributes(attribute.String("url.full", sanitizeURL(r.URL, scopeFrom(r.Context()).redact)))
	}
	return t.next.RoundTrip(r)
}

func sanitizeURL(u *url.URL, red *redactor) string {
	c := *u
	c.User, c.RawQuery, c.ForceQuery, c.Fragment, c.RawFragment = nil, "", false, "", ""
	return red.str(c.String())
}
