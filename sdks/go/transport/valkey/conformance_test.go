package valkey

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/landflow/landflow/sdks/go/transport"
	"github.com/landflow/landflow/sdks/go/transport/conformance"
)

// recordingDriver remembers every channel it declared so the test can delete
// what the suite created on the shared broker.
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

func (d *declared) list() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := make([]string, 0, len(d.channels))
	for c := range d.channels {
		out = append(out, c)
	}
	return out
}

// TestConformance runs the shared driver + core suite against the local Valkey (shared with the app: unique prefix, keys deleted).
func TestConformance(t *testing.T) {
	url := serverURL(t)
	names := &declared{channels: map[string]bool{}}
	factory := func(cfg transport.Config) transport.Driver {
		return recordingDriver{New(Config{Config: cfg, URL: url, ClaimIdle: 2 * time.Second, Block: 200 * time.Millisecond}), names}
	}
	probe := New(Config{URL: url})
	if err := probe.Connect(context.Background()); err != nil {
		t.Skipf("Valkey not reachable: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_ = probe.DeleteStreams(ctx, names.list()...)
		_ = probe.Close()
	})
	conformance.Run(t, conformance.Target{Name: "valkey", Driver: factory, Config: transport.Config{ConnectionID: "valkey-test"}, DeliveryTimeout: 10 * time.Second})
}
