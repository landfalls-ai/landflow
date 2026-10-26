package amqp1

import (
	"context"
	"regexp"
	"testing"
	"time"

	"github.com/landflow/landflow/sdks/go/transport"
	"github.com/landflow/landflow/sdks/go/transport/conformance"
)

// TestConformance runs the shared driver + core suite against the local Artemis (LANDFLOW_TEST_AMQP1), then deletes
// the queues and addresses the runs auto-created (the suite's prefixes are `lfconf.<run>.` and `lfcore<hex>.v1.`)
// through the management address. The limit is set explicitly (Artemis has no fixed message limit).
func TestConformance(t *testing.T) {
	cfg, err := ConfigFromURL("amqp1-test", brokerURL(t), transport.ConnectionOptions{})
	if err != nil {
		t.Fatal(err)
	}
	probe := New(cfg)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	err = probe.Connect(ctx)
	cancel()
	if err != nil {
		t.Skipf("Artemis not reachable: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		pattern := regexp.MustCompile(`^lfconf\.[0-9a-f]{8}\.|^lfcore[0-9a-f]{6}\.v1\.`)
		for _, attribute := range []string{"QueueNames", "AddressNames"} {
			names, _ := probe.Names(ctx, attribute)
			for _, name := range names {
				if pattern.MatchString(name) {
					_ = probe.DeleteChannels(ctx, name)
				}
			}
		}
		_ = probe.Close()
	})
	factory := func(c transport.Config) transport.Driver {
		full := cfg
		full.Config = c
		full.MaxMessageBytes = 1 << 20
		return New(full)
	}
	conformance.Run(t, conformance.Target{Name: "amqp1", Driver: factory, Config: transport.Config{ConnectionID: "amqp1-test"}, DeliveryTimeout: 10 * time.Second})
}
