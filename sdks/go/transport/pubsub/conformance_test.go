package pubsub

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/landflow/landflow/sdks/go/transport"
	"github.com/landflow/landflow/sdks/go/transport/conformance"
)

// recordingDriver remembers every channel it declared or consumed so the test can delete what the suite created
// (the emulator never expires anything).
type recordingDriver struct {
	*Driver
	names *declared
}

type declared struct {
	mu       sync.Mutex
	channels map[string]bool
}

func (r recordingDriver) Declare(ctx context.Context, channels []transport.ChannelSpec) error {
	r.names.mu.Lock()
	for _, c := range channels {
		r.names.channels[c.Name] = true
	}
	r.names.mu.Unlock()
	return r.Driver.Declare(ctx, channels)
}

func (r recordingDriver) Consume(ctx context.Context, channel string, opts transport.ConsumeOptions, handler transport.Handler) (transport.Subscription, error) {
	r.names.mu.Lock()
	r.names.channels[channel] = true
	r.names.mu.Unlock()
	return r.Driver.Consume(ctx, channel, opts, handler)
}

func (r recordingDriver) Publish(ctx context.Context, channel string, event transport.WireEvent, opts transport.PublishOptions) (transport.PublishOutcome, error) {
	r.names.mu.Lock()
	r.names.channels[channel] = true
	r.names.mu.Unlock()
	return r.Driver.Publish(ctx, channel, event, opts)
}

func (d *declared) list() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := make([]string, 0, len(d.channels))
	for c := range d.channels {
		out = append(out, c)
	}
	return out
}

// TestConformance runs the shared driver + core suite against the Pub/Sub emulator (LANDFLOW_TEST_PUBSUB=127.0.0.1:58085,
// project landflow-dev): a unique topic prefix per run, every topic and subscription deleted at the end.
func TestConformance(t *testing.T) {
	prefix := randomPrefix()
	base := testConfig(t, prefix)
	names := &declared{channels: map[string]bool{}}
	factory := func(cfg transport.Config) transport.Driver {
		c := base
		c.Config = cfg
		return recordingDriver{New(c), names}
	}
	probe := New(base)
	if err := probe.Connect(context.Background()); err != nil {
		t.Skipf("Pub/Sub emulator not reachable: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		_ = probe.DeleteChannels(ctx, names.list()...)
		_ = probe.Close()
	})
	conformance.Run(t, conformance.Target{Name: "pubsub", Driver: factory, Config: transport.Config{ConnectionID: "pubsub-test"}, DeliveryTimeout: 10 * time.Second, Settle: 500 * time.Millisecond})
}
