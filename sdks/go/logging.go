package landflow

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math"
	"strconv"
	"strings"
	"sync"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

// Logs (docs/observability.md §3): one JSON object per line,
//
//	{"ts":"…","level":"info","service":"landflow-plugin-x","msg":"…","trace_id":"…","span_id":"…", …attributes}
//
// or, with LANDFLOW_LOG_FORMAT=pretty, "HH:MM:SS level service msg (trace=…/span=…) k=v".
// Attribute keys that look secret (IsSecretKey) have their string values
// replaced with [REDACTED].

func parseLevel(s string) slog.Level {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	}
	return slog.LevelInfo
}

func levelName(l slog.Level) string {
	switch {
	case l >= slog.LevelError:
		return "error"
	case l >= slog.LevelWarn:
		return "warn"
	case l >= slog.LevelInfo:
		return "info"
	}
	return "debug"
}

// logHandler is a slog.Handler writing the Landflow log format.
type logHandler struct {
	out     *lockedWriter
	level   slog.Leveler
	pretty  bool
	service string
	attrs   []slog.Attr // from WithAttrs, keys already prefixed
	prefix  string      // from WithGroup: "group."
}

type lockedWriter struct {
	mu sync.Mutex
	w  io.Writer
}

func newLogHandler(w io.Writer, level slog.Leveler, pretty bool, service string) *logHandler {
	return &logHandler{out: &lockedWriter{w: w}, level: level, pretty: pretty, service: service}
}

func (h *logHandler) Enabled(_ context.Context, l slog.Level) bool { return l >= h.level.Level() }

func (h *logHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	c := *h
	c.attrs = append(append([]slog.Attr(nil), h.attrs...), prefixed(h.prefix, attrs)...)
	return &c
}

func (h *logHandler) WithGroup(name string) slog.Handler {
	if name == "" {
		return h
	}
	c := *h
	c.prefix = h.prefix + name + "."
	return &c
}

func prefixed(prefix string, attrs []slog.Attr) []slog.Attr {
	if prefix == "" {
		return attrs
	}
	out := make([]slog.Attr, len(attrs))
	for i, a := range attrs {
		out[i] = slog.Attr{Key: prefix + a.Key, Value: a.Value}
	}
	return out
}

func (h *logHandler) Handle(ctx context.Context, r slog.Record) error {
	attrs := make([]slog.Attr, 0, len(h.attrs)+r.NumAttrs())
	attrs = append(attrs, h.attrs...)
	r.Attrs(func(a slog.Attr) bool {
		attrs = append(attrs, slog.Attr{Key: h.prefix + a.Key, Value: a.Value})
		return true
	})
	var traceID, spanID string
	if sc := trace.SpanContextFromContext(ctx); sc.IsValid() {
		traceID, spanID = sc.TraceID().String(), sc.SpanID().String()
	}
	ts := r.Time
	if ts.IsZero() {
		ts = time.Now()
	}
	var buf bytes.Buffer
	if h.pretty {
		h.writePretty(&buf, ts, r.Level, r.Message, traceID, spanID, attrs)
	} else {
		h.writeJSON(&buf, ts, r.Level, r.Message, traceID, spanID, attrs)
	}
	buf.WriteByte('\n')
	h.out.mu.Lock()
	defer h.out.mu.Unlock()
	_, err := h.out.w.Write(buf.Bytes())
	return err
}

func (h *logHandler) writeJSON(buf *bytes.Buffer, ts time.Time, level slog.Level, msg, traceID, spanID string, attrs []slog.Attr) {
	buf.WriteString(`{"ts":`)
	writeJSONString(buf, ts.UTC().Format("2006-01-02T15:04:05.000Z07:00"))
	buf.WriteString(`,"level":`)
	writeJSONString(buf, levelName(level))
	buf.WriteString(`,"service":`)
	writeJSONString(buf, h.service)
	buf.WriteString(`,"msg":`)
	writeJSONString(buf, msg)
	if traceID != "" {
		buf.WriteString(`,"trace_id":"` + traceID + `","span_id":"` + spanID + `"`)
	}
	for _, a := range attrs {
		if a.Key == "" {
			continue
		}
		buf.WriteByte(',')
		writeJSONString(buf, a.Key)
		buf.WriteByte(':')
		writeJSONValue(buf, a.Key, a.Value)
	}
	buf.WriteByte('}')
}

func (h *logHandler) writePretty(buf *bytes.Buffer, ts time.Time, level slog.Level, msg, traceID, spanID string, attrs []slog.Attr) {
	rest := attrs[:0:0]
	for _, a := range attrs {
		switch a.Key {
		case "trace_id":
			traceID = a.Value.String()
		case "span_id":
			spanID = a.Value.String()
		default:
			rest = append(rest, a)
		}
	}
	fmt.Fprintf(buf, "%s %-5s %s %s", ts.Local().Format("15:04:05"), levelName(level), h.service, msg)
	if traceID != "" {
		fmt.Fprintf(buf, " (trace=%s/span=%s)", traceID, spanID)
	}
	for _, a := range rest {
		if a.Key == "" {
			continue
		}
		buf.WriteByte(' ')
		buf.WriteString(a.Key)
		buf.WriteByte('=')
		v := a.Value.Resolve()
		if v.Kind() == slog.KindString {
			s := redactKeyed(a.Key, v.String())
			if s == "" || strings.ContainsAny(s, " \t\n\"=") {
				s = strconv.Quote(s)
			}
			buf.WriteString(s)
			continue
		}
		writeJSONValue(buf, a.Key, v)
	}
}

// redactKeyed masks a string value whose key looks secret.
func redactKeyed(key, s string) string {
	if s != "" && IsSecretKey(key) {
		return Redacted
	}
	return s
}

func writeJSONString(buf *bytes.Buffer, s string) {
	data, _ := json.Marshal(s)
	buf.Write(data)
}

func writeJSONValue(buf *bytes.Buffer, key string, v slog.Value) {
	v = v.Resolve()
	switch v.Kind() {
	case slog.KindString:
		writeJSONString(buf, redactKeyed(key, v.String()))
	case slog.KindInt64:
		buf.WriteString(strconv.FormatInt(v.Int64(), 10))
	case slog.KindUint64:
		buf.WriteString(strconv.FormatUint(v.Uint64(), 10))
	case slog.KindFloat64:
		writeJSONFloat(buf, v.Float64())
	case slog.KindBool:
		buf.WriteString(strconv.FormatBool(v.Bool()))
	case slog.KindDuration:
		writeJSONFloat(buf, float64(v.Duration())/float64(time.Millisecond))
	case slog.KindTime:
		writeJSONString(buf, v.Time().UTC().Format(time.RFC3339Nano))
	case slog.KindGroup:
		buf.WriteByte('{')
		first := true
		for _, a := range v.Group() {
			if a.Key == "" {
				continue
			}
			if !first {
				buf.WriteByte(',')
			}
			first = false
			writeJSONString(buf, a.Key)
			buf.WriteByte(':')
			writeJSONValue(buf, a.Key, a.Value)
		}
		buf.WriteByte('}')
	default:
		val := v.Any()
		if err, ok := val.(error); ok {
			writeJSONString(buf, redactKeyed(key, err.Error()))
			return
		}
		if IsSecretKey(key) {
			writeJSONString(buf, Redacted)
			return
		}
		data, err := json.Marshal(val)
		if err != nil {
			writeJSONString(buf, fmt.Sprint(val))
			return
		}
		buf.Write(data)
	}
}

func writeJSONFloat(buf *bytes.Buffer, f float64) {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		writeJSONString(buf, strconv.FormatFloat(f, 'g', -1, 64))
		return
	}
	buf.WriteString(strconv.FormatFloat(f, 'f', -1, 64))
}

// discardHandler drops every record (telemetry not set up).
type discardHandler struct{}

func (discardHandler) Enabled(context.Context, slog.Level) bool  { return false }
func (discardHandler) Handle(context.Context, slog.Record) error { return nil }
func (d discardHandler) WithAttrs([]slog.Attr) slog.Handler      { return d }
func (d discardHandler) WithGroup(string) slog.Handler           { return d }

// ---------------------------------------------------------------------------
// span.end lines (LANDFLOW_LOG_SPANS)
// ---------------------------------------------------------------------------

// spanLogProcessor writes one log line per finished span:
//
//	{"ts":…,"level":"info","service":…,"msg":"span.end","span":"plugin.execute go-crypto.hash","kind":"server",
//	 "trace_id":…,"span_id":…,"parent_span_id":…,"duration_ms":1.2,"status":"ok","attributes":{…}}
type spanLogProcessor struct {
	handler slog.Handler
}

func (p *spanLogProcessor) OnStart(context.Context, sdktrace.ReadWriteSpan) {}
func (p *spanLogProcessor) Shutdown(context.Context) error                  { return nil }
func (p *spanLogProcessor) ForceFlush(context.Context) error                { return nil }

func (p *spanLogProcessor) OnEnd(s sdktrace.ReadOnlySpan) {
	level := slog.LevelInfo
	status, errMsg := "ok", ""
	if s.Status().Code == codes.Error {
		level, status, errMsg = slog.LevelError, "error", s.Status().Description
		if errMsg == "" {
			errMsg = exceptionMessage(s)
		}
	}
	if !p.handler.Enabled(context.Background(), level) {
		return
	}
	sc := s.SpanContext()
	attrs := []slog.Attr{
		slog.String("span", s.Name()),
		slog.String("kind", s.SpanKind().String()),
		slog.String("trace_id", sc.TraceID().String()),
		slog.String("span_id", sc.SpanID().String()),
	}
	if parent := s.Parent(); parent.IsValid() {
		attrs = append(attrs, slog.String("parent_span_id", parent.SpanID().String()))
	}
	ms := float64(s.EndTime().Sub(s.StartTime())) / float64(time.Millisecond)
	attrs = append(attrs, slog.Float64("duration_ms", math.Round(ms*1000)/1000), slog.String("status", status))
	if errMsg != "" {
		attrs = append(attrs, slog.String("error", errMsg))
	}
	if kvs := s.Attributes(); len(kvs) > 0 {
		group := make([]slog.Attr, 0, len(kvs))
		for _, kv := range kvs {
			group = append(group, slog.Any(string(kv.Key), attrValue(kv.Value)))
		}
		attrs = append(attrs, slog.Attr{Key: "attributes", Value: slog.GroupValue(group...)})
	}
	r := slog.NewRecord(s.EndTime(), level, "span.end", 0)
	r.AddAttrs(attrs...)
	_ = p.handler.Handle(context.Background(), r)
}

func exceptionMessage(s sdktrace.ReadOnlySpan) string {
	for _, e := range s.Events() {
		if e.Name != "exception" {
			continue
		}
		for _, kv := range e.Attributes {
			if kv.Key == "exception.message" {
				return kv.Value.AsString()
			}
		}
	}
	return ""
}

func attrValue(v attribute.Value) any {
	switch v.Type() {
	case attribute.BOOL:
		return v.AsBool()
	case attribute.INT64:
		return v.AsInt64()
	case attribute.FLOAT64:
		return v.AsFloat64()
	case attribute.STRING:
		return v.AsString()
	}
	return v.AsInterface()
}

// ---------------------------------------------------------------------------
// Node logger
// ---------------------------------------------------------------------------

// Logger collects a node's log lines into ExecuteResponse.logs (returned to
// the host) and, when the plugin's telemetry is set up, also writes them to
// the process log with trace_id/span_id, landflow.node.type and
// landflow.execution.id. It is safe for concurrent use. Messages are
// fmt.Sprintf-formatted when args are given; structured attributes come
// from With. Credential values of the current call are masked.
//
//	ctx.Logger.Info("sent %d message(s)", n)
//	ctx.Logger.With("telegram.chat_type", t, "count", n).Info("sent")
type Logger struct {
	mu      sync.Mutex
	entries []LogEntry

	root  *Logger // set on loggers made by With; they share root's entries
	attrs []slog.Attr
	sink  *logSink
}

// logSink forwards node log lines to the process log.
type logSink struct {
	ctx     context.Context // carries the span for trace_id/span_id
	handler slog.Handler
	attrs   []slog.Attr // landflow.node.type, landflow.execution.id, …
	redact  *redactor
}

func newSinkLogger(s *logSink) *Logger { return &Logger{sink: s} }

func (l *Logger) Debug(msg string, args ...any) { l.add(LevelDebug, msg, args) }
func (l *Logger) Info(msg string, args ...any)  { l.add(LevelInfo, msg, args) }
func (l *Logger) Warn(msg string, args ...any)  { l.add(LevelWarn, msg, args) }
func (l *Logger) Error(msg string, args ...any) { l.add(LevelError, msg, args) }

// With returns a logger that adds attributes to every line: slog-style
// alternating keys and values, or slog.Attr values. In the lines returned to
// the host they are appended as " key=value".
func (l *Logger) With(args ...any) *Logger {
	r := slog.NewRecord(time.Time{}, 0, "", 0)
	r.Add(args...)
	attrs := append([]slog.Attr(nil), l.attrs...)
	r.Attrs(func(a slog.Attr) bool { attrs = append(attrs, a); return true })
	return &Logger{root: l.target(), attrs: attrs, sink: l.target().sink}
}

// Entries returns a copy of the collected lines.
func (l *Logger) Entries() []LogEntry {
	t := l.target()
	t.mu.Lock()
	defer t.mu.Unlock()
	return append([]LogEntry(nil), t.entries...)
}

func (l *Logger) target() *Logger {
	if l.root != nil {
		return l.root
	}
	return l
}

func (l *Logger) add(level LogLevel, msg string, args []any) {
	t := l.target()
	var red *redactor
	if t.sink != nil {
		red = t.sink.redact
	}
	text := red.str(sprintf(msg, args...))
	full := text
	if len(l.attrs) > 0 {
		var b strings.Builder
		b.WriteString(text)
		for _, a := range l.attrs {
			b.WriteByte(' ')
			b.WriteString(a.Key)
			b.WriteByte('=')
			b.WriteString(red.str(redactKeyed(a.Key, fmt.Sprint(a.Value.Resolve().Any()))))
		}
		full = b.String()
	}
	t.mu.Lock()
	t.entries = append(t.entries, LogEntry{Level: level, Message: full})
	t.mu.Unlock()

	if s := t.sink; s != nil {
		lvl := parseLevel(string(level))
		if !s.handler.Enabled(s.ctx, lvl) {
			return
		}
		r := slog.NewRecord(time.Now(), lvl, text, 0)
		r.AddAttrs(s.attrs...)
		for _, a := range l.attrs {
			if v := a.Value.Resolve(); v.Kind() == slog.KindString {
				a = slog.String(a.Key, red.str(v.String()))
			}
			r.AddAttrs(a)
		}
		_ = s.handler.Handle(s.ctx, r)
	}
}
