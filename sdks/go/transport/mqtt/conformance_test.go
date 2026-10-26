package mqtt

import (
	"context"
	"testing"
	"time"

	"github.com/landflow/landflow/sdks/go/transport"
	"github.com/landflow/landflow/sdks/go/transport/conformance"
)

// TestConformance runs the shared driver + core suite against the local Mosquitto (LANDFLOW_TEST_MQTT). Topics and
// clean sessions leave nothing on the broker, so there is nothing to delete; the limit is set explicitly since
// Mosquitto advertises none (message_size_limit 0).
func TestConformance(t *testing.T) {
	url := brokerURL(t)
	probe := New(Config{URL: url})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	err := probe.Connect(ctx)
	cancel()
	_ = probe.Close()
	if err != nil {
		t.Skipf("Mosquitto not reachable: %v", err)
	}
	factory := func(cfg transport.Config) transport.Driver {
		return New(Config{Config: cfg, URL: url, MaxMessageBytes: 1 << 20})
	}
	conformance.Run(t, conformance.Target{Name: "mqtt", Driver: factory, Config: transport.Config{ConnectionID: "mqtt-test"}, DeliveryTimeout: 10 * time.Second})
}
