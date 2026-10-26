package landflow

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	otelprom "go.opentelemetry.io/otel/exporters/prometheus"
	"go.opentelemetry.io/otel/metric"
	metricnoop "go.opentelemetry.io/otel/metric/noop"
	"go.opentelemetry.io/otel/propagation"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
	tracenoop "go.opentelemetry.io/otel/trace/noop"
	"google.golang.org/grpc/metadata"
)

// Telemetry: OpenTelemetry traces and metrics plus structured logs, as
// specified in docs/observability.md. Serve sets it up from the environment;
// tests and embedders call Plugin.SetupTelemetry with in-memory exporters:
//
//	rec := tracetest.NewSpanRecorder()
//	reader := sdkmetric.NewManualReader()
//	tel, _ := plugin.SetupTelemetry(ctx, landflow.TelemetryOptions{
//		SpanProcessors: []sdktrace.SpanProcessor{rec},
//		MetricReaders:  []sdkmetric.Reader{reader},
//		LogWriter:      &buf,
//	})
//	defer tel.Shutdown(ctx)
//
// Without either, a plugin's telemetry is a no-op: trace context still flows
// through (incoming traceparent → outgoing calls), nothing is recorded.

// InstrumentationName is the tracer and meter scope used by the SDK.
const InstrumentationName = "github.com/landflow/landflow/sdks/go"

// DurationBucketsMs are the histogram buckets for millisecond durations.
var DurationBucketsMs = []float64{1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000}

// TelemetryOptions configures Plugin.SetupTelemetry. Zero values fall back
// to the environment variables of docs/observability.md §1.
type TelemetryOptions struct {
	// ServiceName defaults to "landflow-plugin-<pluginId>". OTEL_SERVICE_NAME
	// (or service.name in OTEL_RESOURCE_ATTRIBUTES) wins over both.
	ServiceName string
	// SpanProcessors are added to the tracer provider, e.g. a
	// tracetest.SpanRecorder in tests.
	SpanProcessors []sdktrace.SpanProcessor
	// MetricReaders are added to the meter provider, e.g.
	// sdkmetric.NewManualReader() in tests.
	MetricReaders []sdkmetric.Reader
	// LogWriter receives the log lines (default os.Stdout).
	LogWriter io.Writer
	// LogLevel (LANDFLOW_LOG_LEVEL): debug | info | warn | error. Default info.
	LogLevel string
	// LogFormat (LANDFLOW_LOG_FORMAT): json | pretty. Default json.
	LogFormat string
	// LogSpans (LANDFLOW_LOG_SPANS) writes a span.end line per finished span. Default true.
	LogSpans *bool
	// Prometheus (LANDFLOW_METRICS_PROMETHEUS) serves GET /metrics on the HTTP
	// port. Default true.
	Prometheus *bool
	// Disabled (OTEL_SDK_DISABLED) turns spans and metrics into no-ops; logs
	// are still written. Default false.
	Disabled *bool
	// NoOTLP never creates OTLP exporters, even when OTEL_EXPORTER_OTLP_* is set.
	NoOTLP bool
	// Global also installs the providers and propagator as the otel globals,
	// so third-party instrumentation joins the same traces. Serve sets it.
	Global bool
}

// Telemetry holds a plugin's tracer and meter providers, propagator, logger
// and Prometheus handler. Get it from Plugin.SetupTelemetry or Plugin.Telemetry.
type Telemetry struct {
	pluginID    string
	serviceName string
	enabled     bool // false: no-op spans and metrics

	tp         trace.TracerProvider
	mp         metric.MeterProvider
	tracer     trace.Tracer
	meter      metric.Meter
	propagator propagation.TextMapPropagator

	logHandler slog.Handler
	logger     *slog.Logger

	metricsHandler http.Handler // nil: no /metrics

	inst   pluginInstruments
	custom *customRegistry
	httpRT http.RoundTripper

	shutdowns []func(context.Context) error
	flushes   []func(context.Context) error
}

// pluginInstruments are the automatic plugin metrics (observability.md §5).
type pluginInstruments struct {
	executions  metric.Int64Counter
	duration    metric.Float64Histogram
	items       metric.Int64Counter
	loadOptions metric.Int64Counter
	inFlight    metric.Int64UpDownCounter
}

var (
	defaultTelOnce sync.Once
	defaultTel     *Telemetry
)

// noopTelemetry is used by plugins that never set telemetry up (unit tests,
// embedders): propagation only, no recording, no logs.
func noopTelemetry() *Telemetry {
	defaultTelOnce.Do(func() {
		defaultTel = &Telemetry{
			tp: tracenoop.NewTracerProvider(), mp: metricnoop.NewMeterProvider(),
			propagator:  newPropagator(),
			logHandler:  discardHandler{},
			serviceName: "landflow-plugin",
		}
		defaultTel.finish()
	})
	return defaultTel
}

func newPropagator() propagation.TextMapPropagator {
	return propagation.NewCompositeTextMapPropagator(propagation.TraceContext{}, propagation.Baggage{})
}

// SetupTelemetry configures the plugin's telemetry and makes it active for
// every transport (Handler, GRPCServer, Execute). Serve calls it with
// ServeOptions.Telemetry unless it was already called. The caller owns the
// returned Telemetry and should Shutdown it to flush exporters.
func (p *Plugin) SetupTelemetry(ctx context.Context, opts TelemetryOptions) (*Telemetry, error) {
	t, err := newTelemetry(ctx, p.info, opts)
	if err != nil {
		return nil, err
	}
	p.telemetry.Store(t)
	return t, nil
}

// Telemetry returns the active telemetry (a no-op one before SetupTelemetry).
func (p *Plugin) Telemetry() *Telemetry { return p.tel() }

func (p *Plugin) tel() *Telemetry {
	if t := p.telemetry.Load(); t != nil {
		return t
	}
	return noopTelemetry()
}

func newTelemetry(ctx context.Context, info PluginInfo, opts TelemetryOptions) (*Telemetry, error) {
	t := &Telemetry{pluginID: info.ID, propagator: newPropagator()}
	disabled := boolSetting(opts.Disabled, "OTEL_SDK_DISABLED", false)

	var res *resource.Resource
	if !disabled {
		var err error
		if res, err = buildResource(ctx, info, opts.ServiceName); err != nil && res == nil {
			return nil, err
		}
		if v, ok := res.Set().Value("service.name"); ok {
			t.serviceName = v.AsString()
		}
	}
	if t.serviceName == "" {
		t.serviceName = firstNonEmpty(os.Getenv("OTEL_SERVICE_NAME"), opts.ServiceName, "landflow-plugin-"+info.ID)
	}

	writer := opts.LogWriter
	if writer == nil {
		writer = os.Stdout
	}
	format := strings.ToLower(firstNonEmpty(opts.LogFormat, os.Getenv("LANDFLOW_LOG_FORMAT"), "json"))
	level := parseLevel(firstNonEmpty(opts.LogLevel, os.Getenv("LANDFLOW_LOG_LEVEL"), "info"))
	t.logHandler = newLogHandler(writer, level, format == "pretty", t.serviceName)

	if disabled {
		t.tp, t.mp = tracenoop.NewTracerProvider(), metricnoop.NewMeterProvider()
		t.finish()
		t.install(opts.Global)
		return t, nil
	}
	t.enabled = true

	// Traces.
	tpOpts := []sdktrace.TracerProviderOption{sdktrace.WithResource(res)}
	if boolSetting(opts.LogSpans, "LANDFLOW_LOG_SPANS", true) {
		tpOpts = append(tpOpts, sdktrace.WithSpanProcessor(&spanLogProcessor{handler: t.logHandler}))
	}
	for _, sp := range opts.SpanProcessors {
		tpOpts = append(tpOpts, sdktrace.WithSpanProcessor(sp))
	}
	var otlpTargets []string
	if !opts.NoOTLP && otlpConfigured("TRACES") {
		exp, err := newTraceExporter(ctx)
		if err != nil {
			t.warn("OTLP trace exporter disabled", "error", err.Error())
		} else {
			tpOpts = append(tpOpts, sdktrace.WithBatcher(exp))
			otlpTargets = append(otlpTargets, "traces")
		}
	}
	sdkTP := sdktrace.NewTracerProvider(tpOpts...)
	t.tp = sdkTP
	t.shutdowns = append(t.shutdowns, sdkTP.Shutdown)
	t.flushes = append(t.flushes, sdkTP.ForceFlush)

	// Metrics.
	mpOpts := []sdkmetric.Option{sdkmetric.WithResource(res)}
	for _, r := range opts.MetricReaders {
		mpOpts = append(mpOpts, sdkmetric.WithReader(r))
	}
	if boolSetting(opts.Prometheus, "LANDFLOW_METRICS_PROMETHEUS", true) {
		reg := prometheus.NewRegistry()
		exp, err := otelprom.New(otelprom.WithRegisterer(reg), otelprom.WithoutScopeInfo())
		if err != nil {
			t.warn("Prometheus exporter disabled", "error", err.Error())
		} else {
			mpOpts = append(mpOpts, sdkmetric.WithReader(exp))
			t.metricsHandler = promhttp.HandlerFor(reg, promhttp.HandlerOpts{})
		}
	}
	if !opts.NoOTLP && otlpConfigured("METRICS") {
		exp, err := newMetricExporter(ctx)
		if err != nil {
			t.warn("OTLP metric exporter disabled", "error", err.Error())
		} else {
			var readerOpts []sdkmetric.PeriodicReaderOption
			if os.Getenv("OTEL_METRIC_EXPORT_INTERVAL") == "" {
				readerOpts = append(readerOpts, sdkmetric.WithInterval(15*time.Second))
			}
			mpOpts = append(mpOpts, sdkmetric.WithReader(sdkmetric.NewPeriodicReader(exp, readerOpts...)))
			otlpTargets = append(otlpTargets, "metrics")
		}
	}
	sdkMP := sdkmetric.NewMeterProvider(mpOpts...)
	t.mp = sdkMP
	t.shutdowns = append(t.shutdowns, sdkMP.Shutdown)
	t.flushes = append(t.flushes, sdkMP.ForceFlush)

	t.finish()
	t.install(opts.Global)
	if len(otlpTargets) > 0 {
		t.logger.Debug("exporting OTLP " + strings.Join(otlpTargets, " and "))
	}
	return t, nil
}

// finish derives the tracer, meter, instruments and logger from the providers.
func (t *Telemetry) finish() {
	t.tracer = t.tp.Tracer(InstrumentationName, trace.WithInstrumentationVersion(SDKVersion))
	t.meter = t.mp.Meter(InstrumentationName, metric.WithInstrumentationVersion(SDKVersion))
	t.logger = slog.New(t.logHandler)
	t.custom = newCustomRegistry(t)
	t.inst.executions, _ = t.meter.Int64Counter("landflow.plugin.executions",
		metric.WithDescription("Node executions served by the plugin"))
	t.inst.duration, _ = t.meter.Float64Histogram("landflow.plugin.execute.duration",
		metric.WithUnit("ms"), metric.WithDescription("Node execution time inside the plugin"),
		metric.WithExplicitBucketBoundaries(DurationBucketsMs...))
	t.inst.items, _ = t.meter.Int64Counter("landflow.plugin.items",
		metric.WithDescription("Items received (in) and emitted (out) by nodes"))
	t.inst.loadOptions, _ = t.meter.Int64Counter("landflow.plugin.load_options",
		metric.WithDescription("LoadOptions calls served by the plugin"))
	t.inst.inFlight, _ = t.meter.Int64UpDownCounter("landflow.plugin.inflight",
		metric.WithDescription("Calls running in the plugin right now, by landflow.transport"))
	t.httpRT = otelhttp.NewTransport(sanitizeTransport{next: http.DefaultTransport},
		otelhttp.WithTracerProvider(t.tp), otelhttp.WithMeterProvider(t.mp), otelhttp.WithPropagators(t.propagator),
		otelhttp.WithSpanNameFormatter(func(_ string, r *http.Request) string { return "HTTP " + r.Method }))
}

func (t *Telemetry) install(global bool) {
	if !global {
		return
	}
	otel.SetTracerProvider(t.tp)
	otel.SetMeterProvider(t.mp)
	otel.SetTextMapPropagator(t.propagator)
	otel.SetErrorHandler(&otelErrorLogger{logger: t.logger})
}

// otelErrorLogger reports OTel SDK errors (an unreachable collector, …)
// without repeating the same message more than once a minute.
type otelErrorLogger struct {
	logger *slog.Logger
	mu     sync.Mutex
	last   string
	at     time.Time
}

func (h *otelErrorLogger) Handle(err error) {
	h.mu.Lock()
	msg := err.Error()
	repeat := msg == h.last && time.Since(h.at) < time.Minute
	if !repeat {
		h.last, h.at = msg, time.Now()
	}
	h.mu.Unlock()
	if !repeat {
		h.logger.Warn("opentelemetry: "+msg, "component", "otel")
	}
}

// ServiceName returns the service.name of the resource (also the log "service").
func (t *Telemetry) ServiceName() string { return t.serviceName }

// Enabled reports whether spans and metrics are recorded.
func (t *Telemetry) Enabled() bool { return t.enabled }

// TracerProvider returns the provider the SDK records spans with.
func (t *Telemetry) TracerProvider() trace.TracerProvider { return t.tp }

// MeterProvider returns the provider the SDK records metrics with.
func (t *Telemetry) MeterProvider() metric.MeterProvider { return t.mp }

// Propagator returns the W3C trace-context + baggage propagator.
func (t *Telemetry) Propagator() propagation.TextMapPropagator { return t.propagator }

// Logger returns the structured process logger (JSON or pretty, with
// trace_id/span_id taken from the context passed to the *Context methods).
func (t *Telemetry) Logger() *slog.Logger { return t.logger }

// MetricsHandler serves Prometheus text, or is nil when disabled.
func (t *Telemetry) MetricsHandler() http.Handler { return t.metricsHandler }

// ForceFlush exports everything recorded so far.
func (t *Telemetry) ForceFlush(ctx context.Context) error {
	var errs []error
	for _, f := range t.flushes {
		errs = append(errs, f(ctx))
	}
	return errors.Join(errs...)
}

// Shutdown flushes and stops the providers. Spans and metrics recorded
// afterwards are dropped.
func (t *Telemetry) Shutdown(ctx context.Context) error {
	var errs []error
	for _, f := range t.shutdowns {
		errs = append(errs, f(ctx))
	}
	t.shutdowns, t.flushes = nil, nil
	return errors.Join(errs...)
}

func (t *Telemetry) warn(msg string, args ...any) {
	slog.New(t.logHandler).Warn(msg, args...)
}

// buildResource: SDK defaults < Landflow attributes < OTEL_SERVICE_NAME /
// OTEL_RESOURCE_ATTRIBUTES.
func buildResource(ctx context.Context, info PluginInfo, serviceName string) (*resource.Resource, error) {
	return resource.New(ctx,
		resource.WithTelemetrySDK(),
		resource.WithAttributes(
			attribute.String("service.name", firstNonEmpty(serviceName, "landflow-plugin-"+info.ID)),
			attribute.String("service.version", info.Version),
			attribute.String("service.namespace", "landflow"),
			attribute.String("landflow.plugin.id", info.ID),
			attribute.String("landflow.plugin.language", "go"),
		),
		resource.WithFromEnv(),
	)
}

// otlpConfigured reports whether an OTLP endpoint is set for signal
// (TRACES or METRICS) and OTEL_<signal>_EXPORTER is not "none".
func otlpConfigured(signal string) bool {
	if strings.EqualFold(strings.TrimSpace(os.Getenv("OTEL_"+signal+"_EXPORTER")), "none") {
		return false
	}
	return os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT") != "" || os.Getenv("OTEL_EXPORTER_OTLP_"+signal+"_ENDPOINT") != ""
}

func otlpProtocol(signal string) string {
	return strings.ToLower(firstNonEmpty(os.Getenv("OTEL_EXPORTER_OTLP_"+signal+"_PROTOCOL"), os.Getenv("OTEL_EXPORTER_OTLP_PROTOCOL"), "http/protobuf"))
}

// The exporters read endpoint, headers, timeout and TLS settings from the
// standard OTEL_EXPORTER_OTLP_* variables themselves.
func newTraceExporter(ctx context.Context) (sdktrace.SpanExporter, error) {
	if otlpProtocol("TRACES") == "grpc" {
		return otlptracegrpc.New(ctx)
	}
	return otlptracehttp.New(ctx)
}

func newMetricExporter(ctx context.Context) (sdkmetric.Exporter, error) {
	if otlpProtocol("METRICS") == "grpc" {
		return otlpmetricgrpc.New(ctx)
	}
	return otlpmetrichttp.New(ctx)
}

// boolSetting: an explicit option wins, then the env var, then def.
func boolSetting(opt *bool, env string, def bool) bool {
	if opt != nil {
		return *opt
	}
	if b, err := strconv.ParseBool(strings.TrimSpace(os.Getenv(env))); err == nil {
		return b
	}
	return def
}

// ---------------------------------------------------------------------------
// Propagation
// ---------------------------------------------------------------------------

// extractHTTP continues the caller's trace from traceparent/tracestate/baggage headers.
func (t *Telemetry) extractHTTP(r *http.Request) context.Context {
	return t.propagator.Extract(r.Context(), propagation.HeaderCarrier(r.Header))
}

// extractTraceParent continues a trace from explicit traceparent/tracestate values (an MCP call's _meta).
func (t *Telemetry) extractTraceParent(ctx context.Context, traceParent, traceState string) context.Context {
	carrier := propagation.MapCarrier{"traceparent": traceParent}
	if traceState != "" {
		carrier["tracestate"] = traceState
	}
	return t.propagator.Extract(ctx, carrier)
}

// extractGRPC continues the caller's trace from the incoming gRPC metadata.
func (t *Telemetry) extractGRPC(ctx context.Context) context.Context {
	md, ok := metadata.FromIncomingContext(ctx)
	if !ok {
		return ctx
	}
	return t.propagator.Extract(ctx, metadataCarrier(md))
}

// metadataCarrier adapts gRPC metadata (lower-case keys) to the propagator.
type metadataCarrier metadata.MD

func (m metadataCarrier) Get(key string) string {
	if v := metadata.MD(m).Get(key); len(v) > 0 {
		return v[0]
	}
	return ""
}

func (m metadataCarrier) Set(key, value string) { metadata.MD(m).Set(key, value) }

func (m metadataCarrier) Keys() []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	return keys
}

// ---------------------------------------------------------------------------
// Call scope: what spans, metrics, logs and the HTTP client need to know
// about the current call, carried in the context.
// ---------------------------------------------------------------------------

type scope struct {
	tel    *Telemetry
	redact *redactor
	// metric auto-attributes
	nodeType   string
	workflowID string
}

type scopeKey struct{}

func withScope(ctx context.Context, s *scope) context.Context {
	return context.WithValue(ctx, scopeKey{}, s)
}

func scopeFrom(ctx context.Context) *scope {
	if ctx != nil {
		if s, ok := ctx.Value(scopeKey{}).(*scope); ok && s != nil {
			return s
		}
	}
	return &scope{tel: noopTelemetry()}
}
