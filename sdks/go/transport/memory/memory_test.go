package memory_test

import (
	"testing"
	"time"

	"github.com/landflow/landflow/sdks/go/transport"
	"github.com/landflow/landflow/sdks/go/transport/conformance"
	"github.com/landflow/landflow/sdks/go/transport/memory"
)

func target(name string, broker *memory.Broker) conformance.Target {
	return conformance.Target{
		Name:   name,
		Config: transport.Config{ConnectionID: "mem-test"},
		Driver: func(cfg transport.Config) transport.Driver { return broker.Driver(cfg) },
		Tap: func(fn func(channel string, event transport.WireEvent) (transport.WireEvent, bool)) func() {
			return broker.Tap(fn)
		},
	}
}

// The memory driver in several guises, so the core is exercised against every
// capability shape a real broker may have.
func TestMemoryConformance(t *testing.T) {
	guises := []struct {
		name string
		opts memory.Options
	}{
		{"memory", memory.Options{}},
		{"memory-no-headers", memory.Options{Configure: func(c *transport.Capabilities) { c.Headers = false }}},
		{"memory-native-replies", memory.Options{Configure: func(c *transport.Capabilities) { c.Replies = transport.RepliesNative }}},
		{"memory-small-limit", memory.Options{Configure: func(c *transport.Capabilities) { c.MaxMessageBytes = 16 * 1024 }}},
		{"memory-unknown-undeliverable", memory.Options{Configure: func(c *transport.Capabilities) { c.Undeliverable = transport.UndeliverableUnknown }}},
		{"memory-latency", memory.Options{Latency: 5 * time.Millisecond}},
	}
	for _, g := range guises {
		g := g
		t.Run(g.name, func(t *testing.T) {
			t.Parallel()
			conformance.Run(t, target(g.name, memory.NewBroker(g.opts)))
		})
	}
}

func TestMemoryRegisteredDriver(t *testing.T) {
	factory, ok := transport.LookupDriver("memory")
	if !ok {
		t.Fatal("memory driver not registered")
	}
	d, err := factory("env-memory", "memory://default", transport.ConnectionOptions{Prefix: "acme"})
	if err != nil || d.Kind() != "memory" || d.Config().ConnectionID != "env-memory" || d.Config().Prefix != "acme" {
		t.Fatalf("%v %+v", err, d)
	}
	if md, ok := d.(*memory.Driver); !ok || md.Broker() != memory.Default() {
		t.Fatal("factory must use the default broker")
	}
}
