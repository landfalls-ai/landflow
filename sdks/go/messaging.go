package landflow

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"

	"github.com/landflow/landflow/sdks/go/transport"
)

// BrokerBinding is the messaging face of a plugin: it serves the plugin over
// one broker connection through the messaging core (sdks/go/transport) and the
// shared Dispatcher (docs/transports.md "SDK side"). Serve builds one from
// WithBroker or from the environment (LANDFLOW_TRANSPORTS=…,kafka +
// LANDFLOW_KAFKA_URL, see brokerBindingsFromEnv).
//
// What it maps: the envelope's deadline onto CallOptions.Deadline, a cancel
// event onto the call's context, the delivery attempt and mode onto
// DeliveryOf(ctx), ErrOverloaded onto the remote code "capacity", unknown nodes
// onto "not_found", bad bodies onto "bad_request", a passed deadline onto
// "expired". It announces itself on the broker's registry channel (with a
// registry proof when LANDFLOW_REGISTRY_SECRET is set), so Start returns no
// endpoint for the HTTP registry. Each call is a consumer span with the OTel
// messaging attributes, continuing the host's trace from traceparent.
type BrokerBinding struct {
	// Driver is the unconnected driver for the broker (kafka.New(…), nats.New(…)).
	Driver transport.Driver
	// Keyring signs and encrypts; default: transport.KeyringFromEnv
	// (LANDFLOW_TRANSPORT_SECRET, _PREVIOUS, fallback LANDFLOW_REGISTRY_SECRET).
	Keyring *transport.Keyring
	// RegistrySecret proves announces (default LANDFLOW_REGISTRY_SECRET).
	RegistrySecret string
	// Observe, when set, sees every delivery before it is dispatched (tests and
	// conformance runners read the delivery mode and attempt from it).
	Observe func(method transport.Method, dc transport.DispatchContext)
	// AnnounceInterval and DrainTimeout tune the server (defaults 10 s, 30 s).
	AnnounceInterval time.Duration
	DrainTimeout     time.Duration

	mu     sync.Mutex
	server *transport.Server
	bc     BindingContext
}

// NewBrokerBinding returns a binding over driver.
func NewBrokerBinding(driver transport.Driver) *BrokerBinding { return &BrokerBinding{Driver: driver} }

// WithBroker serves the plugin over a broker: landflow.WithBroker(kafka.New(kafka.Config{…})).
// LANDFLOW_TRANSPORTS still selects which bindings run.
func WithBroker(driver transport.Driver) ServeOption {
	return serveOptionFunc(func(o *ServeOptions) { o.Bindings = append(o.Bindings, NewBrokerBinding(driver)) })
}

// Kind is the driver's kind ("kafka", "amqp", "nats", "valkey", …).
func (b *BrokerBinding) Kind() string {
	if b.Driver == nil {
		return "broker"
	}
	return b.Driver.Kind()
}

// Server is the messaging server after Start (nil before).
func (b *BrokerBinding) Server() *transport.Server {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.server
}

// Endpoint is the brokered endpoint, <kind>://<connectionId>/<pluginId>.
func (b *BrokerBinding) Endpoint() string {
	if s := b.Server(); s != nil {
		return s.Endpoint
	}
	return ""
}

// Start connects to the broker, consumes the plugin's channels and announces.
func (b *BrokerBinding) Start(ctx context.Context, bc BindingContext) (BindingInfo, error) {
	if b.Driver == nil {
		return BindingInfo{}, errors.New("landflow: BrokerBinding needs a Driver")
	}
	keyring := b.Keyring
	if keyring == nil {
		var err error
		if keyring, err = transport.KeyringFromEnv(nil); err != nil {
			return BindingInfo{}, fmt.Errorf("landflow: %s binding: %w", b.Kind(), err)
		}
	}
	b.mu.Lock()
	b.bc = bc
	b.mu.Unlock()
	maxConcurrency := 0
	if bc.Dispatcher != nil {
		maxConcurrency = bc.Dispatcher.MaxConcurrency()
	}
	if maxConcurrency <= 0 {
		maxConcurrency = transport.DefaultMaxConcurrency
	}
	manifest := bc.Manifest
	server, err := transport.NewServer(transport.ServerOptions{
		Driver: b.Driver, Keyring: keyring, PluginID: manifest.Plugin.ID, Version: manifest.Plugin.Version, Manifest: manifest,
		Dispatch: b.dispatch, MaxConcurrency: maxConcurrency, InstanceID: InstanceID(), Transports: manifest.Transports,
		AnnounceInterval: b.AnnounceInterval, DrainTimeout: b.DrainTimeout, RegistrySecret: b.RegistrySecret, Log: transport.StdLogger(bc.Logger),
	})
	if err != nil {
		return BindingInfo{}, err
	}
	if err := server.Start(ctx); err != nil {
		return BindingInfo{}, err
	}
	b.mu.Lock()
	b.server = server
	b.mu.Unlock()
	if bc.Logger != nil {
		bc.Logger.Printf("%s binding serving %s (instance %s, prefetch %d); announcing on the broker's registry channel", b.Kind(), server.Endpoint, server.InstanceID, maxConcurrency)
	}
	// The endpoint is announced on the broker's registry channel, not to the HTTP registry (docs/protocol.md §14.1).
	return BindingInfo{}, nil
}

// Stop withdraws, drains calls in flight (bounded by ctx) and disconnects.
func (b *BrokerBinding) Stop(ctx context.Context) error {
	b.mu.Lock()
	server := b.server
	b.server = nil
	b.mu.Unlock()
	if server == nil {
		return nil
	}
	return server.Stop(ctx)
}

// DeliveryInfo is what a brokered call knows about its delivery; nodes read it
// with DeliveryOf(ctx) (for example to make an at-least-once retry idempotent).
type DeliveryInfo struct {
	// Transport is the broker kind.
	Transport string
	// CallID is the request event's id.
	CallID string
	// Attempt is the broker's delivery attempt (1 on the first).
	Attempt int
	// Mode is at-most-once or at-least-once.
	Mode transport.DeliveryMode
	// IdempotencyKey is the request's idempotency key, if any.
	IdempotencyKey string
	// Source is the host that called, landflow://host/<instanceId>.
	Source string
}

type deliveryKey struct{}

// DeliveryOf returns the brokered delivery of the current call; ok is false
// for calls that came over HTTP or gRPC.
func DeliveryOf(ctx context.Context) (DeliveryInfo, bool) {
	if ctx == nil {
		return DeliveryInfo{}, false
	}
	info, ok := ctx.Value(deliveryKey{}).(DeliveryInfo)
	return info, ok
}

// dispatch is the transport.Dispatcher: decode the body, run the call through
// the shared Dispatcher inside a consumer span, map errors onto remote codes.
func (b *BrokerBinding) dispatch(ctx context.Context, method transport.Method, body json.RawMessage, dc transport.DispatchContext) (any, error) {
	b.mu.Lock()
	bc := b.bc
	b.mu.Unlock()
	if b.Observe != nil {
		b.Observe(method, dc)
	}
	kind := b.Kind()
	ctx = context.WithValue(ctx, deliveryKey{}, DeliveryInfo{Transport: kind, CallID: dc.CallID, Attempt: dc.Attempt, Mode: dc.Delivery, IdempotencyKey: dc.IdempotencyKey, Source: dc.Source})
	if bc.Telemetry != nil && dc.TraceParent != "" {
		carrier := propagation.MapCarrier{"traceparent": dc.TraceParent}
		if dc.TraceState != "" {
			carrier["tracestate"] = dc.TraceState
		}
		ctx = bc.Telemetry.Propagator().Extract(ctx, carrier)
	}
	var server *transport.Server
	b.mu.Lock()
	server = b.server
	b.mu.Unlock()
	destination := ""
	if server != nil {
		destination = server.Names.Request(bc.Manifest.Plugin.ID)
	}
	attrs := Attrs{
		"messaging.system": kind, "messaging.operation.type": "process", "messaging.operation.name": "process",
		"messaging.destination.name": destination, "messaging.message.id": dc.CallID, "messaging.consumer.group.name": destination,
		"landflow.transport": kind, "landflow.plugin.id": bc.Manifest.Plugin.ID, "landflow.rpc.method": string(method),
		"landflow.delivery.mode": string(dc.Delivery), "landflow.delivery.attempt": dc.Attempt,
	}
	var result any
	err := runSpan(ctx, "process "+destination, trace.SpanKindConsumer, attrs, func(span Span) error {
		var err error
		result, err = b.run(span.Context(), bc, method, body, dc)
		return err
	})
	return result, err
}

func (b *BrokerBinding) run(ctx context.Context, bc BindingContext, method transport.Method, body json.RawMessage, dc transport.DispatchContext) (any, error) {
	// The messaging server already holds at most its prefetch (MaxConcurrency); the rest waits in the broker.
	return dispatchLocal(ctx, bc.Dispatcher, method, body, CallOptions{Transport: b.Kind(), Deadline: dc.Deadline, Wait: true})
}

// dispatchLocal runs one JSON-bodied call (the transport.Dispatcher contract) through the in-process dispatcher:
// what a broker binding and the MCP face both do once the wire is unwrapped. Dispatcher errors become
// transport.DispatchError codes the caller can act on.
func dispatchLocal(ctx context.Context, d *Dispatcher, method transport.Method, body json.RawMessage, opts CallOptions) (any, error) {
	decode := func(dst any) error {
		if len(body) == 0 {
			return &transport.DispatchError{Code: transport.CodeBadRequest, Message: "request body is empty"}
		}
		if err := json.Unmarshal(body, dst); err != nil {
			return &transport.DispatchError{Code: transport.CodeBadRequest, Message: "malformed JSON body: " + err.Error()}
		}
		return nil
	}
	if d == nil {
		return nil, &transport.DispatchError{Code: transport.CodeUnavailable, Message: "binding has no dispatcher"}
	}
	var (
		result any
		err    error
	)
	switch method {
	case transport.MethodGetManifest:
		return d.Manifest(), nil
	case transport.MethodHealth:
		return d.Health(), nil
	case transport.MethodExecute:
		var req ExecuteRequest
		if err := decode(&req); err != nil {
			return nil, err
		}
		result, err = d.Execute(ctx, &req, opts)
	case transport.MethodLoadOptions:
		var req LoadOptionsRequest
		if err := decode(&req); err != nil {
			return nil, err
		}
		result, err = d.LoadOptions(ctx, &req, opts)
	case transport.MethodTestCredentials:
		var req TestCredentialsRequest
		if err := decode(&req); err != nil {
			return nil, err
		}
		result, err = d.TestCredentials(ctx, &req, opts)
	case transport.MethodWebhookMethod:
		var req WebhookMethodRequest
		if err := decode(&req); err != nil {
			return nil, err
		}
		result, err = d.WebhookMethod(ctx, &req, opts)
	case transport.MethodReceiveWebhook:
		var req WebhookRequest
		if err := decode(&req); err != nil {
			return nil, err
		}
		result, err = d.ReceiveWebhook(ctx, &req, opts)
	default:
		return nil, &transport.DispatchError{Code: transport.CodeNotFound, Message: fmt.Sprintf("unknown method %q", method)}
	}
	if err != nil {
		return nil, remoteError(err)
	}
	return result, nil
}

// remoteError maps a dispatcher error onto the remote code the host acts on,
// the same way statusFor maps it onto an HTTP status.
func remoteError(err error) error {
	code := transport.CodeInternal
	switch {
	case errors.Is(err, ErrOverloaded):
		code = transport.CodeCapacity
	case errors.Is(err, ErrUnknownNode), errors.Is(err, ErrNoOptionsLoader), errors.Is(err, ErrUnknownCredentialType):
		code = transport.CodeNotFound
	case errors.Is(err, ErrBadRequest):
		code = transport.CodeBadRequest
	case errors.Is(err, context.DeadlineExceeded):
		code = transport.CodeExpired
	case errors.Is(err, context.Canceled):
		code = transport.CodeCancelled
	}
	return &transport.DispatchError{Code: code, Message: err.Error()}
}

// brokerBindingsFromEnv builds a BrokerBinding for every kind LANDFLOW_TRANSPORTS
// names that has no configured binding, from LANDFLOW_<KIND>_URL and the
// registered driver factory (transport.LookupDriver; a driver package registers
// in init(), so a plugin enables one with a blank import). Connection fields:
// LANDFLOW_<KIND>_USERNAME, _PASSWORD, _TLS (true/1), _PREFIX (else
// LANDFLOW_TRANSPORT_PREFIX) and any other LANDFLOW_<KIND>_<FIELD> as a
// driver-specific field. The connection id is env-<kind>, the id the host gives
// the connection it reads from LANDFLOW_TRANSPORT_<KIND>_URL. A kind with a URL
// but no registered driver is an error; a kind without a URL is left to the
// caller's "no such binding" log line.
func brokerBindingsFromEnv(selected map[string]bool, have map[string]bool) ([]Binding, error) {
	var out []Binding
	for kind := range selected {
		if have[kind] || kind == "http" || kind == "grpc" || kind == "mcp" {
			continue
		}
		envKind := strings.ToUpper(strings.ReplaceAll(kind, "-", "_"))
		url := strings.TrimSpace(os.Getenv("LANDFLOW_" + envKind + "_URL"))
		if url == "" {
			continue
		}
		factory, ok := transport.LookupDriver(kind)
		if !ok {
			return nil, fmt.Errorf("landflow: LANDFLOW_%s_URL is set but no %q driver is registered (import the driver package, e.g. _ \"github.com/landflow/landflow/sdks/go/transport/%s\"); registered: %s", envKind, kind, kind, strings.Join(transport.DriverKinds(), ", "))
		}
		opts := transport.ConnectionOptions{
			Username: os.Getenv("LANDFLOW_" + envKind + "_USERNAME"),
			Password: os.Getenv("LANDFLOW_" + envKind + "_PASSWORD"),
			Prefix:   firstNonEmpty(os.Getenv("LANDFLOW_"+envKind+"_PREFIX"), os.Getenv("LANDFLOW_TRANSPORT_PREFIX")),
			Fields:   map[string]string{},
		}
		if tls := strings.ToLower(strings.TrimSpace(os.Getenv("LANDFLOW_" + envKind + "_TLS"))); tls == "1" || tls == "true" || tls == "yes" {
			opts.TLS = true
		}
		prefix := "LANDFLOW_" + envKind + "_"
		for _, kv := range os.Environ() {
			name, value, found := strings.Cut(kv, "=")
			if !found || !strings.HasPrefix(name, prefix) {
				continue
			}
			field := strings.ToLower(strings.TrimPrefix(name, prefix))
			switch field {
			case "url", "username", "password", "tls", "prefix":
				continue
			}
			opts.Fields[field] = value
		}
		driver, err := factory("env-"+kind, url, opts)
		if err != nil {
			return nil, fmt.Errorf("landflow: LANDFLOW_%s_URL: %w", envKind, err)
		}
		out = append(out, NewBrokerBinding(driver))
	}
	return out, nil
}
