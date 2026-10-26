package landflow

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

// Dispatcher is the transport-neutral core of a plugin: every binding (HTTP,
// gRPC, a broker, MCP) converts its wire format into the protocol structs and
// calls the dispatcher, which applies the call's deadline and cancellation,
// the plugin's concurrency limit, and then runs the plugin's handler logic
// (spans, metrics, redaction, credentials, idempotency key) and the node.
//
// The context passed to a call reaches node code as the ExecuteContext: a
// binding cancels it when its caller goes away (an HTTP client disconnects, a
// gRPC deadline passes, a broker delivery expires) and node code sees
// ctx.Done(). CallOptions.Deadline adds a deadline on top of the context's.
//
// A plugin has one dispatcher (Plugin.Dispatcher); Serve configures it with
// WithMaxConcurrency. Bindings of your own get it through BindingContext.
type Dispatcher struct {
	p              *Plugin
	maxConcurrency int
	maxQueue       int

	mu       sync.Mutex
	inFlight int
	waiters  []chan struct{} // calls waiting for a slot, in arrival order
}

// DispatcherOptions configures NewDispatcher.
type DispatcherOptions struct {
	// MaxConcurrency bounds the calls (Execute, LoadOptions, TestCredentials,
	// WebhookMethod, ReceiveWebhook) running at once; 0 = unlimited. A call
	// that arrives at the limit waits for a slot, in arrival order, until its
	// context or deadline ends (then it fails with that context error:
	// HTTP 504 / 499, gRPC DEADLINE_EXCEEDED / CANCELLED). Announced to the
	// host as the manifest's maxConcurrency.
	MaxConcurrency int
	// MaxQueue bounds the calls waiting for a slot. When as many are waiting,
	// further calls are refused at once with ErrOverloaded (HTTP 429 +
	// Retry-After: 1, gRPC RESOURCE_EXHAUSTED) so the host can take them
	// elsewhere knowing they never ran. 0 = MaxConcurrency (the default every
	// SDK shares); NoQueue refuses every call that finds no free slot.
	MaxQueue int
}

// NoQueue, as DispatcherOptions.MaxQueue, makes a call that finds every slot
// taken fail at once instead of waiting.
const NoQueue = -1

// CallOptions are per-call settings a binding passes with each request.
type CallOptions struct {
	// Transport is the binding's kind ("http", "grpc", "kafka"…); it becomes
	// the landflow.transport attribute of the server span and the metrics.
	Transport string
	// Deadline, when set, bounds the call (the x-landflow-deadline header, the
	// broker envelope's lfdeadline, an MCP timeout). The context's own
	// deadline still applies as well.
	Deadline time.Time
	// Attributes are extra span attributes of the call (the MCP face sets
	// mcp.tool.name); they join landflow.transport on the server span.
	Attributes Attrs
	// Wait makes the call wait for a slot however many are waiting, instead
	// of being refused with ErrOverloaded. For faces that already bound how
	// many calls they hand over (a broker face takes at most its prefetch):
	// the rest stays in the broker, which is the buffer the host spilled
	// over to, so refusing would only bounce the call back.
	Wait bool
}

// ErrOverloaded is returned when a call is refused at once because the
// plugin is at its concurrency limit and as many calls as MaxQueue allows are
// already waiting (the "capacity" outcome of docs/transports.md). The call
// never ran, so the host may retry it elsewhere. Transports map it to HTTP
// 429 with Retry-After: 1 and gRPC codes.ResourceExhausted.
//
// A call that did wait for a slot and ran out of time fails with its
// context's error instead (context.DeadlineExceeded or context.Canceled).
var ErrOverloaded = errors.New("plugin is at its concurrency limit")

// NewDispatcher builds a dispatcher for p. Most plugins never call this:
// Plugin.Dispatcher returns one, and Serve configures it from its options.
func NewDispatcher(p *Plugin, opts DispatcherOptions) *Dispatcher {
	d := &Dispatcher{p: p, maxConcurrency: max(opts.MaxConcurrency, 0)}
	switch {
	case opts.MaxQueue < 0:
		d.maxQueue = 0
	case opts.MaxQueue == 0:
		d.maxQueue = d.maxConcurrency
	default:
		d.maxQueue = opts.MaxQueue
	}
	return d
}

// Dispatcher returns the plugin's dispatcher, creating an unlimited one on
// first use. Serve replaces it with one built from the serve options before
// any binding starts, so Handler, RegisterGRPC and custom bindings all share
// the plugin's concurrency limit.
func (p *Plugin) Dispatcher() *Dispatcher {
	if d := p.dispatcher.Load(); d != nil {
		return d
	}
	d := NewDispatcher(p, DispatcherOptions{})
	if p.dispatcher.CompareAndSwap(nil, d) {
		return d
	}
	return p.dispatcher.Load()
}

// Plugin returns the plugin the dispatcher serves.
func (d *Dispatcher) Plugin() *Plugin { return d.p }

// MaxConcurrency returns the concurrency limit (0 = unlimited).
func (d *Dispatcher) MaxConcurrency() int { return d.maxConcurrency }

// MaxQueue returns how many calls may wait for a slot before further ones are
// refused with ErrOverloaded (meaningless when MaxConcurrency is 0).
func (d *Dispatcher) MaxQueue() int { return d.maxQueue }

// InFlight returns the number of calls running right now (not counting calls
// waiting for a slot).
func (d *Dispatcher) InFlight() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.inFlight
}

// Waiting returns the number of calls waiting for a concurrency slot.
func (d *Dispatcher) Waiting() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return len(d.waiters)
}

// Manifest, WellKnown and Health are cheap and never limited.
func (d *Dispatcher) Manifest() PluginManifest     { return d.p.Manifest() }
func (d *Dispatcher) WellKnown() WellKnownDocument { return d.p.WellKnown() }
func (d *Dispatcher) Health() HealthResponse       { return d.p.Health() }

// Execute runs an ExecuteRequest through the plugin (see Plugin.Execute) with
// the call's deadline, cancellation and concurrency slot applied.
func (d *Dispatcher) Execute(ctx context.Context, req *ExecuteRequest, opts CallOptions) (*ExecuteResponse, error) {
	ctx, release, err := d.enter(ctx, opts)
	if err != nil {
		return nil, err
	}
	defer release()
	return d.p.Execute(ctx, req)
}

// LoadOptions resolves a dynamic dropdown (see Plugin.LoadOptions).
func (d *Dispatcher) LoadOptions(ctx context.Context, req *LoadOptionsRequest, opts CallOptions) (*LoadOptionsResponse, error) {
	ctx, release, err := d.enter(ctx, opts)
	if err != nil {
		return nil, err
	}
	defer release()
	return d.p.LoadOptions(ctx, req)
}

// TestCredentials runs a credential test (see Plugin.TestCredentials).
func (d *Dispatcher) TestCredentials(ctx context.Context, req *TestCredentialsRequest, opts CallOptions) (*TestCredentialsResponse, error) {
	ctx, release, err := d.enter(ctx, opts)
	if err != nil {
		return nil, err
	}
	defer release()
	return d.p.TestCredentials(ctx, req)
}

// WebhookMethod runs an app webhook lifecycle call (see Plugin.WebhookMethod).
func (d *Dispatcher) WebhookMethod(ctx context.Context, req *WebhookMethodRequest, opts CallOptions) (*WebhookMethodResponse, error) {
	ctx, release, err := d.enter(ctx, opts)
	if err != nil {
		return nil, err
	}
	defer release()
	return d.p.WebhookMethod(ctx, req)
}

// ReceiveWebhook delivers a webhook call to its trigger (see Plugin.ReceiveWebhook).
func (d *Dispatcher) ReceiveWebhook(ctx context.Context, req *WebhookRequest, opts CallOptions) (*WebhookResponse, error) {
	ctx, release, err := d.enter(ctx, opts)
	if err != nil {
		return nil, err
	}
	defer release()
	return d.p.ReceiveWebhook(ctx, req)
}

// Drain blocks until no call is running or waiting, or until ctx ends. For a
// binding's Stop.
func (d *Dispatcher) Drain(ctx context.Context) error {
	for {
		d.mu.Lock()
		idle := d.inFlight == 0 && len(d.waiters) == 0
		d.mu.Unlock()
		if idle {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(10 * time.Millisecond):
		}
	}
}

// enter applies the deadline, records the transport in ctx and takes a
// concurrency slot. release must be called when the call is done.
func (d *Dispatcher) enter(ctx context.Context, opts CallOptions) (context.Context, func(), error) {
	if ctx == nil {
		ctx = context.Background()
	}
	cancel := func() {}
	if !opts.Deadline.IsZero() {
		ctx, cancel = context.WithDeadline(ctx, opts.Deadline)
	}
	if opts.Transport != "" {
		ctx = withTransport(ctx, opts.Transport)
	}
	if len(opts.Attributes) > 0 {
		ctx = context.WithValue(ctx, callAttrsKey{}, opts.Attributes)
	}
	if err := ctx.Err(); err != nil {
		cancel()
		return ctx, nil, fmt.Errorf("call not started: %w", err)
	}
	if err := d.acquire(ctx, opts.Wait); err != nil {
		cancel()
		return ctx, nil, err
	}
	tel := d.p.tel()
	attrs := metric.WithAttributes(attribute.String("landflow.plugin.id", d.p.info.ID), attribute.String("landflow.transport", opts.Transport))
	tel.inst.inFlight.Add(ctx, 1, attrs)
	released := false
	release := func() {
		if released {
			return
		}
		released = true
		tel.inst.inFlight.Add(context.WithoutCancel(ctx), -1, attrs)
		d.release()
		cancel()
	}
	return ctx, release, nil
}

// acquire takes a slot: at once when one is free, after waiting in arrival
// order when the queue has room (or wait is set), never otherwise
// (ErrOverloaded). A waiter whose ctx ends leaves the queue with the
// context's error.
func (d *Dispatcher) acquire(ctx context.Context, wait bool) error {
	d.mu.Lock()
	if d.maxConcurrency <= 0 || d.inFlight < d.maxConcurrency {
		d.inFlight++
		d.mu.Unlock()
		return nil
	}
	if !wait && len(d.waiters) >= d.maxQueue {
		err := fmt.Errorf("%w (%d in flight, %d waiting, limit %d)", ErrOverloaded, d.inFlight, len(d.waiters), d.maxConcurrency)
		d.mu.Unlock()
		return err
	}
	slot := make(chan struct{})
	d.waiters = append(d.waiters, slot)
	d.mu.Unlock()

	select {
	case <-slot:
		// release handed us its slot (inFlight already counts us).
		return nil
	case <-ctx.Done():
		d.mu.Lock()
		defer d.mu.Unlock()
		for i, w := range d.waiters {
			if w == slot {
				d.waiters = append(d.waiters[:i], d.waiters[i+1:]...)
				return fmt.Errorf("gave up waiting for a concurrency slot (%d in flight, limit %d): %w", d.inFlight, d.maxConcurrency, ctx.Err())
			}
		}
		// The slot was handed over while ctx ended; pass it on.
		d.releaseLocked()
		return fmt.Errorf("call not started: %w", ctx.Err())
	}
}

// release frees a slot, handing it to the longest-waiting call if any.
func (d *Dispatcher) release() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.releaseLocked()
}

func (d *Dispatcher) releaseLocked() {
	if len(d.waiters) > 0 {
		next := d.waiters[0]
		d.waiters = d.waiters[1:]
		close(next) // the slot moves to the waiter; inFlight is unchanged
		return
	}
	d.inFlight--
}

// transportKey carries the binding kind of the current call in the context.
type transportKey struct{}

func withTransport(ctx context.Context, kind string) context.Context {
	return context.WithValue(ctx, transportKey{}, kind)
}

// TransportOf returns the kind of the binding that delivered the current call
// ("http", "grpc", a broker kind…), or "" when the call did not come through a
// binding (unit tests calling Plugin.Execute directly).
func TransportOf(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	kind, _ := ctx.Value(transportKey{}).(string)
	return kind
}

// callAttrsKey carries CallOptions.Attributes in the context.
type callAttrsKey struct{}

// callAttrs returns the landflow.transport span attribute for ctx plus the
// call's extra attributes (CallOptions.Attributes), if any.
func callAttrs(ctx context.Context) []attribute.KeyValue {
	var out []attribute.KeyValue
	if kind := TransportOf(ctx); kind != "" {
		out = append(out, attribute.String("landflow.transport", kind))
	}
	if extra, _ := ctx.Value(callAttrsKey{}).(Attrs); len(extra) > 0 {
		for _, key := range sortedAttrKeys(extra) {
			if kv, ok := toKeyValue(key, extra[key], nil); ok {
				out = append(out, kv)
			}
		}
	}
	return out
}

func sortedAttrKeys(a Attrs) []string {
	keys := make([]string, 0, len(a))
	for k := range a {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// maxConcurrencyFromEnv reads LANDFLOW_MAX_CONCURRENCY (empty or 0 = fallback).
func maxConcurrencyFromEnv(fallback int) (int, error) {
	raw := strings.TrimSpace(os.Getenv("LANDFLOW_MAX_CONCURRENCY"))
	if raw == "" {
		return fallback, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 0 {
		return 0, fmt.Errorf("landflow: LANDFLOW_MAX_CONCURRENCY=%q is not a non-negative integer", raw)
	}
	return n, nil
}
