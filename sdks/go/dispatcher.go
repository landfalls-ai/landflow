package landflow

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
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
	slots          chan struct{} // nil: unlimited
	inFlight       atomic.Int64
	waiting        atomic.Int64
}

// DispatcherOptions configures NewDispatcher.
type DispatcherOptions struct {
	// MaxConcurrency bounds the calls (Execute, LoadOptions, TestCredentials,
	// WebhookMethod, ReceiveWebhook) running at once; 0 = unlimited. A call
	// that arrives at the limit waits for a slot until its context or
	// deadline expires, then fails with ErrOverloaded. Announced to the host
	// as the manifest's maxConcurrency.
	MaxConcurrency int
}

// CallOptions are per-call settings a binding passes with each request.
type CallOptions struct {
	// Transport is the binding's kind ("http", "grpc", "kafka"…); it becomes
	// the landflow.transport attribute of the server span and the metrics.
	Transport string
	// Deadline, when set, bounds the call (the broker envelope's lfdeadline,
	// an MCP timeout). The context's own deadline still applies as well.
	Deadline time.Time
}

// ErrOverloaded is returned (wrapped, together with the context's error) when
// a call could not get a concurrency slot before its context or deadline
// expired. Transports map it to HTTP 503 / codes.ResourceExhausted.
var ErrOverloaded = errors.New("plugin is at its concurrency limit")

// NewDispatcher builds a dispatcher for p. Most plugins never call this:
// Plugin.Dispatcher returns one, and Serve configures it from its options.
func NewDispatcher(p *Plugin, opts DispatcherOptions) *Dispatcher {
	d := &Dispatcher{p: p, maxConcurrency: max(opts.MaxConcurrency, 0)}
	if d.maxConcurrency > 0 {
		d.slots = make(chan struct{}, d.maxConcurrency)
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

// InFlight returns the number of calls running right now (not counting calls
// waiting for a slot).
func (d *Dispatcher) InFlight() int { return int(d.inFlight.Load()) }

// Waiting returns the number of calls waiting for a concurrency slot.
func (d *Dispatcher) Waiting() int { return int(d.waiting.Load()) }

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
	if err := ctx.Err(); err != nil {
		cancel()
		return ctx, nil, fmt.Errorf("call not started: %w", err)
	}
	if d.slots != nil {
		select {
		case d.slots <- struct{}{}:
		default:
			d.waiting.Add(1)
			select {
			case d.slots <- struct{}{}:
				d.waiting.Add(-1)
			case <-ctx.Done():
				d.waiting.Add(-1)
				cancel()
				return ctx, nil, fmt.Errorf("%w (%d in flight, limit %d): %w", ErrOverloaded, d.InFlight(), d.maxConcurrency, ctx.Err())
			}
		}
	}
	d.inFlight.Add(1)
	tel := d.p.tel()
	attrs := metric.WithAttributes(attribute.String("landflow.plugin.id", d.p.info.ID), attribute.String("landflow.transport", opts.Transport))
	tel.inst.inFlight.Add(ctx, 1, attrs)
	released := false
	release := func() {
		if released {
			return
		}
		released = true
		d.inFlight.Add(-1)
		tel.inst.inFlight.Add(context.WithoutCancel(ctx), -1, attrs)
		if d.slots != nil {
			<-d.slots
		}
		cancel()
	}
	return ctx, release, nil
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

// transportAttrs returns the landflow.transport span attribute for ctx, if any.
func transportAttrs(ctx context.Context) []attribute.KeyValue {
	if kind := TransportOf(ctx); kind != "" {
		return []attribute.KeyValue{attribute.String("landflow.transport", kind)}
	}
	return nil
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
