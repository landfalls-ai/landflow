package servicebus

import (
	"context"
	"regexp"
	"testing"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/messaging/azservicebus"

	"github.com/landflow/landflow/sdks/go/transport"
	"github.com/landflow/landflow/sdks/go/transport/conformance"
)

// The emulator cannot create entities at runtime, so the suite's random channel names are mapped onto the fixed
// entities of deploy/infra/servicebus/Config.json (same mapping as the TS suite): `lfconf.<run>.<name>` → `lfconf.<name>`,
// `lfcore<hex>.v1.plugin.<id>` → `lfcore.v1.plugin`; instance, reply and broadcast channels use the default
// landflow.v1.instance / .reply / .broadcast entities.
var (
	conformanceQueues = []string{"declare", "roundtrip", "headers", "share", "nack", "death", "nobody", "buffer", "ttl", "prefetch", "order", "stats", "big"}
	coreQueue         = "lfcore.v1.plugin"
	driverCaseRE      = regexp.MustCompile(`^lfconf\.[0-9a-f]{8}\.([a-z]+)$`)
	coreCaseRE        = regexp.MustCompile(`^lfcore[0-9a-f]{6}\.v1\.plugin\.`)
)

func conformanceQueueFor(channel string) string {
	if m := driverCaseRE.FindStringSubmatch(channel); m != nil {
		return "lfconf." + m[1]
	}
	if coreCaseRE.MatchString(channel) {
		return coreQueue
	}
	return channel
}

// drain empties the mapped queues so a previous run's leftovers (TTL 5 min) cannot leak in.
func drain(t *testing.T, cs string) {
	t.Helper()
	queues := []string{coreQueue}
	for _, q := range conformanceQueues {
		queues = append(queues, "lfconf."+q)
	}
	drainQueues(t, cs, queues...)
}

// drainQueues empties queues with receive-and-delete receivers.
func drainQueues(t *testing.T, cs string, queues ...string) {
	t.Helper()
	client, err := azservicebus.NewClientFromConnectionString(cs, nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	defer client.Close(ctx)
	for _, q := range queues {
		r, err := client.NewReceiverForQueue(q, &azservicebus.ReceiverOptions{ReceiveMode: azservicebus.ReceiveModeReceiveAndDelete})
		if err != nil {
			t.Fatal(err)
		}
		for {
			rctx, rcancel := context.WithTimeout(ctx, 300*time.Millisecond)
			msgs, err := r.ReceiveMessages(rctx, 100, nil)
			rcancel()
			if err != nil || len(msgs) == 0 {
				break
			}
		}
		_ = r.Close(ctx)
	}
}

// TestConformance runs the shared driver + core suite against the local Service Bus emulator.
func TestConformance(t *testing.T) {
	cs := target(t)
	probe := New(Config{ConnectionString: cs, InstanceQueue: "landflow.v1.instance", ReplyQueue: "landflow.v1.reply", BroadcastTopic: "landflow.v1.broadcast"})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	err := probe.Connect(ctx)
	cancel()
	if err != nil {
		t.Skipf("Service Bus emulator not reachable: %v", err)
	}
	_ = probe.Close()
	drain(t, cs)
	factory := func(cfg transport.Config) transport.Driver {
		return New(Config{Config: cfg, ConnectionString: cs, QueueFor: conformanceQueueFor, InstanceQueue: "landflow.v1.instance", ReplyQueue: "landflow.v1.reply", BroadcastTopic: "landflow.v1.broadcast", MaxMessageBytes: 240 * 1024})
	}
	conformance.Run(t, conformance.Target{Name: "servicebus", Driver: factory, Config: transport.Config{ConnectionID: "servicebus-test"}, DeliveryTimeout: 20 * time.Second})
}
