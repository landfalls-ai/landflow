package landflow

import (
	"context"
	"regexp"
	"sync"
	"unicode/utf8"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

// Custom metrics for node authors (docs/observability.md §5):
//
//	ctx.Metrics().Counter("telegram.messages.sent").Add(1, landflow.Attrs{"telegram.chat_type": t})
//	ctx.Metrics().Histogram("postgres.query.duration", landflow.WithUnit("ms")).Record(ms)
//	ctx.Metrics().Gauge("queue.depth").Set(float64(n))
//
// Names must match ^[a-z][a-z0-9_.]{0,100}$ and should start with the
// integration's name; an invalid name yields a no-op instrument and one
// warning in the log. Every value gets landflow.plugin.id, landflow.node.type
// and landflow.workflow.id. Attribute values are truncated to 100 characters
// and each metric keeps at most 1000 attribute sets; further sets are folded
// into one series marked otel.metric.overflow=true.

var metricNamePattern = regexp.MustCompile(`^[a-z][a-z0-9_.]{0,100}$`)

const (
	// MaxMetricAttributeSets bounds the series of one custom metric.
	MaxMetricAttributeSets = 1000
	// MaxMetricAttributeLen truncates custom metric attribute values.
	MaxMetricAttributeLen = 100
)

// ValidMetricName reports whether name is acceptable for a custom metric.
func ValidMetricName(name string) bool { return metricNamePattern.MatchString(name) }

// MetricOption configures a custom instrument the first time it is created.
type MetricOption func(*metricConfig)

type metricConfig struct {
	unit        string
	description string
	buckets     []float64
}

// WithUnit sets the UCUM unit ("ms", "s", "By", "1", "{message}"). Histograms
// in "ms" get the standard duration buckets.
func WithUnit(unit string) MetricOption { return func(c *metricConfig) { c.unit = unit } }

// WithDescription sets the instrument description.
func WithDescription(d string) MetricOption { return func(c *metricConfig) { c.description = d } }

// WithBuckets sets explicit histogram bucket boundaries.
func WithBuckets(bounds ...float64) MetricOption {
	return func(c *metricConfig) { c.buckets = append([]float64(nil), bounds...) }
}

// Metrics creates custom instruments bound to the current call's
// auto-attributes. Get it from ExecuteContext.Metrics or
// LoadOptionsContext.Metrics; the zero value records nothing.
type Metrics struct {
	reg  *customRegistry
	base []attribute.KeyValue
}

func newMetrics(s *scope) *Metrics {
	m := &Metrics{reg: s.tel.custom}
	if id := s.tel.pluginID; id != "" {
		m.base = append(m.base, attribute.String("landflow.plugin.id", id))
	}
	if s.nodeType != "" {
		m.base = append(m.base, attribute.String("landflow.node.type", s.nodeType))
	}
	if s.workflowID != "" {
		m.base = append(m.base, attribute.String("landflow.workflow.id", s.workflowID))
	}
	return m
}

// Counter returns the monotonic counter called name.
func (m *Metrics) Counter(name string, opts ...MetricOption) *Counter {
	return &Counter{m: m, inst: m.instrument(name, kindCounter, opts)}
}

// Histogram returns the histogram called name.
func (m *Metrics) Histogram(name string, opts ...MetricOption) *Histogram {
	return &Histogram{m: m, inst: m.instrument(name, kindHistogram, opts)}
}

// Gauge returns the gauge (last value wins) called name.
func (m *Metrics) Gauge(name string, opts ...MetricOption) *Gauge {
	return &Gauge{m: m, inst: m.instrument(name, kindGauge, opts)}
}

func (m *Metrics) instrument(name string, kind instrumentKind, opts []MetricOption) *customInstrument {
	if m == nil || m.reg == nil {
		return nil
	}
	return m.reg.get(name, kind, opts)
}

// Counter is a monotonic sum. Add ignores negative values.
type Counter struct {
	m    *Metrics
	inst *customInstrument
}

// Add increments the counter by v (>= 0).
func (c *Counter) Add(v float64, attrs ...Attrs) {
	if c == nil || c.inst == nil || v < 0 {
		return
	}
	set := c.inst.attributes(c.m.base, attrs)
	c.inst.counter.Add(context.Background(), v, metric.WithAttributeSet(set))
}

// Histogram records a distribution of values.
type Histogram struct {
	m    *Metrics
	inst *customInstrument
}

// Record adds one value to the histogram.
func (h *Histogram) Record(v float64, attrs ...Attrs) {
	if h == nil || h.inst == nil {
		return
	}
	set := h.inst.attributes(h.m.base, attrs)
	h.inst.histogram.Record(context.Background(), v, metric.WithAttributeSet(set))
}

// Gauge records the current value of something (a queue depth, a balance).
type Gauge struct {
	m    *Metrics
	inst *customInstrument
}

// Set records the gauge's current value.
func (g *Gauge) Set(v float64, attrs ...Attrs) {
	if g == nil || g.inst == nil {
		return
	}
	set := g.inst.attributes(g.m.base, attrs)
	g.inst.gauge.Record(context.Background(), v, metric.WithAttributeSet(set))
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

type instrumentKind int

const (
	kindCounter instrumentKind = iota
	kindHistogram
	kindGauge
)

func (k instrumentKind) String() string {
	return [...]string{"counter", "histogram", "gauge"}[k]
}

// customRegistry caches custom instruments by name for the plugin's lifetime.
type customRegistry struct {
	tel *Telemetry

	mu          sync.Mutex
	instruments map[string]*customInstrument
	warned      map[string]bool
}

type customInstrument struct {
	kind      instrumentKind
	counter   metric.Float64Counter
	histogram metric.Float64Histogram
	gauge     metric.Float64Gauge

	mu   sync.Mutex
	sets map[attribute.Distinct]bool
}

var overflowSet = attribute.NewSet(attribute.Bool("otel.metric.overflow", true))

func newCustomRegistry(t *Telemetry) *customRegistry {
	return &customRegistry{tel: t, instruments: map[string]*customInstrument{}, warned: map[string]bool{}}
}

func (r *customRegistry) get(name string, kind instrumentKind, opts []MetricOption) *customInstrument {
	r.mu.Lock()
	defer r.mu.Unlock()
	if inst, ok := r.instruments[name]; ok {
		if inst.kind != kind {
			r.warnOnce(name, "metric "+name+" is already a "+inst.kind.String()+"; ignoring it as a "+kind.String())
			return nil
		}
		return inst
	}
	if !ValidMetricName(name) {
		r.warnOnce(name, "invalid metric name "+name+": must match ^[a-z][a-z0-9_.]{0,100}$; values are dropped")
		return nil
	}
	var cfg metricConfig
	for _, o := range opts {
		o(&cfg)
	}
	inst := &customInstrument{kind: kind, sets: map[attribute.Distinct]bool{}}
	var err error
	meter := r.tel.meter
	switch kind {
	case kindCounter:
		inst.counter, err = meter.Float64Counter(name, metric.WithUnit(cfg.unit), metric.WithDescription(cfg.description))
	case kindHistogram:
		hopts := []metric.Float64HistogramOption{metric.WithUnit(cfg.unit), metric.WithDescription(cfg.description)}
		switch {
		case len(cfg.buckets) > 0:
			hopts = append(hopts, metric.WithExplicitBucketBoundaries(cfg.buckets...))
		case cfg.unit == "ms":
			hopts = append(hopts, metric.WithExplicitBucketBoundaries(DurationBucketsMs...))
		}
		inst.histogram, err = meter.Float64Histogram(name, hopts...)
	case kindGauge:
		inst.gauge, err = meter.Float64Gauge(name, metric.WithUnit(cfg.unit), metric.WithDescription(cfg.description))
	}
	if err != nil {
		r.warnOnce(name, "metric "+name+": "+err.Error())
		return nil
	}
	r.instruments[name] = inst
	return inst
}

func (r *customRegistry) warnOnce(name, msg string) {
	if r.warned[name] {
		return
	}
	r.warned[name] = true
	r.tel.logger.Warn(msg, "metric", name)
}

// attributes builds the attribute set (base + user attrs, values truncated)
// and applies the cardinality guard.
func (i *customInstrument) attributes(base []attribute.KeyValue, attrs []Attrs) attribute.Set {
	kvs := append([]attribute.KeyValue(nil), base...)
	for _, a := range attrs {
		for _, kv := range (&scope{}).kvs(a) {
			if kv.Value.Type() == attribute.STRING {
				kv = attribute.String(string(kv.Key), truncate(kv.Value.AsString(), MaxMetricAttributeLen))
			}
			kvs = append(kvs, kv)
		}
	}
	set := attribute.NewSet(kvs...)
	key := set.Equivalent()
	i.mu.Lock()
	defer i.mu.Unlock()
	if i.sets[key] {
		return set
	}
	if len(i.sets) >= MaxMetricAttributeSets {
		return overflowSet
	}
	i.sets[key] = true
	return set
}

func truncate(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	count := 0
	for i := range s {
		if count == n {
			return s[:i]
		}
		count++
	}
	return s
}
