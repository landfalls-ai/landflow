package kafka

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

// TestConformance runs the shared driver + core suite against the local Kafka, in both modes.
func TestConformance(t *testing.T) {
	addr := broker(t)
	for _, mode := range []Mode{ModeShare, ModeGroup} {
		t.Run(string(mode), func(t *testing.T) {
			names := &declared{channels: map[string]bool{}}
			factory := func(cfg transport.Config) transport.Driver {
				return recordingDriver{New(Config{Config: cfg, Brokers: []string{addr}, Mode: mode, Partitions: 2}), names}
			}
			probe := New(Config{Brokers: []string{addr}})
			if err := probe.Connect(context.Background()); err != nil {
				t.Skipf("Kafka at %s not reachable: %v", addr, err)
			}
			t.Cleanup(func() {
				ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
				defer cancel()
				channels := names.list()
				_ = probe.DeleteGroups(ctx, channels...)
				_ = probe.DeleteTopics(ctx, channels...)
				_ = probe.Close()
			})
			conformance.Run(t, conformance.Target{Name: "kafka-" + string(mode), Driver: factory, Config: transport.Config{ConnectionID: "kafka-test"}, DeliveryTimeout: 20 * time.Second})
		})
	}
}
