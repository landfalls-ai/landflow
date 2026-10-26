// Package conformance is the driver conformance suite (docs/transports.md
// "Brokers": every driver passes the same conformance kit against a local
// container), the Go mirror of @landflow/transports/conformance.
//
// Call Run(t, target) from a driver's test. It runs two groups of subtests:
//   - driver: every transport.Driver member and every Capabilities claim
//     (publish/consume, header round trip, work sharing across two consumers,
//     broadcast, ack/nack/redelivery, a dying consumer, unroutable reporting,
//     buffering, TTL, prefetch, native request/reply, stats, size);
//   - core: transport.Client + transport.Server end to end over the driver
//     (call/reply, deadline, cancel, at most once vs at least once, a replica
//     crash mid-call, discovery with registry proofs, manifest mismatch,
//     tampered and unsigned events, size limits, concurrency, drain, instance
//     channels, stats).
//
// Cases a capability rules out are skipped with the reason. Channel names get a
// random prefix per run, so several runs can share one broker. Tests that need
// a broker gate the whole file on an env var and skip otherwise:
//
//	url := os.Getenv("LANDFLOW_TEST_KAFKA")
//	if url == "" { t.Skip("set LANDFLOW_TEST_KAFKA=127.0.0.1:59092") }
//	conformance.Run(t, conformance.Target{Name: "kafka", Config: transport.Config{ConnectionID: "kafka-test"},
//	    Driver: func(cfg transport.Config) transport.Driver { return kafka.New(kafka.Config{Config: cfg, Brokers: []string{url}}) }})
package conformance

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/landflow/landflow/sdks/go/transport"
)

// Target is what the suite needs from a driver.
type Target struct {
	// Name is shown in test names.
	Name string
	// Driver returns a new, unconnected driver for cfg each time; all of them reach the same broker.
	Driver func(cfg transport.Config) transport.Driver
	// Config is the connection config; the suite changes its Prefix per run.
	Config transport.Config
	// DeliveryTimeout is how long to wait for an asynchronous delivery (default 2 s; raise for slow brokers).
	DeliveryTimeout time.Duration
	// Settle, optional, is how long a new consumer takes before it receives (a streaming pull being opened). The sharing
	// case waits that long after starting both consumers, so the first stream can't take the whole batch on a broker
	// that doesn't enforce flow control on the server (the Pub/Sub emulator).
	Settle time.Duration
	// Tap, optional, alters or drops (ok false) events in flight (the memory broker's Tap). It enables the cases that
	// watch the wire (ciphertext only, tampered replies). Real brokers do not have one; those cases are skipped.
	Tap func(fn func(channel string, event transport.WireEvent) (transport.WireEvent, bool)) func()
}

const (
	secret         = "conformance-transport-secret"
	registrySecret = "conformance-registry-secret"
)

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// WaitFor polls predicate until it is true or timeout passes (then fails the test).
func WaitFor(t testing.TB, timeout time.Duration, what string, predicate func() bool) {
	t.Helper()
	until := time.Now().Add(timeout)
	for !predicate() {
		if time.Now().After(until) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func sampleEvent(body string) transport.WireEvent {
	return transport.WireEvent{
		Headers: map[string]string{"content-type": "application/json", "specversion": "1.0", "id": randomHex(8), "type": "dev.landflow.plugin.v1.health.request", "lfsig": strings.Repeat("a", 64)},
		Body:    []byte(body),
	}
}

// Run runs the driver and core conformance cases.
func Run(t *testing.T, target Target) {
	t.Helper()
	RunDriver(t, target)
	RunCore(t, target)
}

type bodies struct {
	mu   sync.Mutex
	list []string
}

func (b *bodies) add(s string) {
	b.mu.Lock()
	b.list = append(b.list, s)
	b.mu.Unlock()
}

func (b *bodies) len() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.list)
}

func (b *bodies) get() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]string(nil), b.list...)
}

func (b *bodies) count(s string) int {
	n := 0
	for _, x := range b.get() {
		if x == s {
			n++
		}
	}
	return n
}

// RunDriver checks every interface member and capability claim.
func RunDriver(t *testing.T, target Target) {
	wait := target.DeliveryTimeout
	if wait <= 0 {
		wait = 2 * time.Second
	}
	ctx := context.Background()
	t.Run(target.Name+" driver conformance", func(t *testing.T) {
		run := randomHex(4)
		caps := target.Driver(target.Config).Capabilities()
		connected := func(t *testing.T) transport.Driver {
			d := target.Driver(target.Config)
			if err := d.Connect(ctx); err != nil {
				t.Fatalf("connect: %v", err)
			}
			t.Cleanup(func() { _ = d.Close() })
			return d
		}
		channel := func(name string, delivery transport.ChannelDelivery) transport.ChannelSpec {
			return transport.ChannelSpec{Name: "lfconf." + run + "." + name, Role: transport.RoleRequest, Delivery: delivery, Durable: delivery == transport.DeliveryShared}
		}
		shared := func(name string) transport.ChannelSpec { return channel(name, transport.DeliveryShared) }
		manual := func(spec transport.ChannelSpec, prefetch int) transport.ConsumeOptions {
			return transport.ConsumeOptions{Group: spec.Name, Prefetch: prefetch, AckMode: transport.AckManual}
		}
		auto := func(spec transport.ChannelSpec, prefetch int) transport.ConsumeOptions {
			return transport.ConsumeOptions{Group: spec.Name, Prefetch: prefetch, AckMode: transport.AckAuto}
		}

		t.Run("declares its kind and complete capabilities", func(t *testing.T) {
			if caps.Replies != transport.RepliesNative && caps.Replies != transport.RepliesChannel {
				t.Fatalf("replies %q", caps.Replies)
			}
			switch caps.Undeliverable {
			case transport.UndeliverableReported, transport.UndeliverableInferred, transport.UndeliverableUnknown:
			default:
				t.Fatalf("undeliverable %q", caps.Undeliverable)
			}
			if caps.Persistence != transport.PersistenceMemory && caps.Persistence != transport.PersistenceDisk {
				t.Fatalf("persistence %q", caps.Persistence)
			}
			if caps.MaxMessageBytes <= 1024 {
				t.Fatalf("maxMessageBytes %d", caps.MaxMessageBytes)
			}
			switch caps.Latency {
			case transport.LatencyLow, transport.LatencyMedium, transport.LatencyHigh:
			default:
				t.Fatalf("latency %q", caps.Latency)
			}
			d := target.Driver(target.Config)
			kind := d.Kind()
			if kind == "" || strings.ToLower(kind) != kind || strings.ContainsAny(kind, " /:") {
				t.Fatalf("kind %q", kind)
			}
			if caps.Replies == transport.RepliesNative {
				if _, ok := d.(transport.Requester); !ok {
					t.Fatal("native replies claimed but the driver is not a Requester")
				}
			}
			if d.Config().ConnectionID == "" {
				t.Fatal("Config().ConnectionID is empty")
			}
		})

		t.Run("refuses to publish before connecting, with ErrNotConnected", func(t *testing.T) {
			d := target.Driver(target.Config)
			_, err := d.Publish(ctx, shared("nc").Name, sampleEvent("x"), transport.PublishOptions{})
			if !transport.IsNotConnected(err) {
				t.Fatalf("got %v", err)
			}
		})

		t.Run("connects, declares channels (idempotently) and closes twice without error", func(t *testing.T) {
			d := connected(t)
			if err := d.Declare(ctx, []transport.ChannelSpec{shared("declare"), shared("declare")}); err != nil {
				t.Fatal(err)
			}
			if err := d.Declare(ctx, []transport.ChannelSpec{shared("declare")}); err != nil {
				t.Fatal(err)
			}
			if err := d.Close(); err != nil {
				t.Fatal(err)
			}
			if err := d.Close(); err != nil {
				t.Fatal(err)
			}
		})

		t.Run("delivers a published event to a consumer with its body intact", func(t *testing.T) {
			d := connected(t)
			spec := shared("roundtrip")
			if err := d.Declare(ctx, []transport.ChannelSpec{spec}); err != nil {
				t.Fatal(err)
			}
			var got bodies
			if _, err := d.Consume(ctx, spec.Name, manual(spec, 4), func(ctx context.Context, e transport.WireEvent, del transport.Delivery) {
				got.add(string(e.Body))
				_ = del.Ack(ctx)
			}); err != nil {
				t.Fatal(err)
			}
			outcome, err := d.Publish(ctx, spec.Name, sampleEvent("body-1"), transport.PublishOptions{})
			if err != nil || outcome != transport.Accepted {
				t.Fatalf("publish: %v %v", outcome, err)
			}
			WaitFor(t, wait, "delivery", func() bool { return got.len() == 1 })
			if got.get()[0] != "body-1" {
				t.Fatalf("body %q", got.get()[0])
			}
		})

		name := "carries at least the body when it has no headers"
		if caps.Headers {
			name = "carries headers by their bare lower-case names"
		}
		t.Run(name, func(t *testing.T) {
			d := connected(t)
			spec := shared("headers")
			_ = d.Declare(ctx, []transport.ChannelSpec{spec})
			var mu sync.Mutex
			var got []transport.WireEvent
			_, err := d.Consume(ctx, spec.Name, auto(spec, 4), func(_ context.Context, e transport.WireEvent, _ transport.Delivery) {
				mu.Lock()
				got = append(got, e)
				mu.Unlock()
			})
			if err != nil {
				t.Fatal(err)
			}
			sent := sampleEvent("h")
			sent.Headers["lfdeadline"] = "1700000000000"
			sent.Headers["subject"] = "twilio.message"
			if _, err := d.Publish(ctx, spec.Name, sent, transport.PublishOptions{}); err != nil {
				t.Fatal(err)
			}
			WaitFor(t, wait, "delivery", func() bool { mu.Lock(); defer mu.Unlock(); return len(got) == 1 })
			mu.Lock()
			defer mu.Unlock()
			if caps.Headers {
				for k, v := range sent.Headers {
					if k == "content-type" {
						continue
					}
					if got[0].Headers[k] != v {
						t.Errorf("header %s: got %q want %q", k, got[0].Headers[k], v)
					}
				}
				for k := range got[0].Headers {
					if k != strings.ToLower(k) {
						t.Errorf("header %q is not lower-case", k)
					}
				}
			}
			if string(got[0].Body) != "h" {
				t.Fatalf("body %q", got[0].Body)
			}
		})

		t.Run("shares one channel between two consumers in a group, each event delivered once", func(t *testing.T) {
			if !caps.WorkSharing {
				t.Skip("work sharing not supported")
			}
			a, b := connected(t), connected(t)
			spec := shared("share")
			_ = a.Declare(ctx, []transport.ChannelSpec{spec})
			var seenA, seenB bodies
			slow := func(seen *bodies) transport.Handler {
				return func(ctx context.Context, e transport.WireEvent, del transport.Delivery) {
					seen.add(string(e.Body))
					time.Sleep(10 * time.Millisecond)
					_ = del.Ack(ctx)
				}
			}
			if _, err := a.Consume(ctx, spec.Name, manual(spec, 1), slow(&seenA)); err != nil {
				t.Fatal(err)
			}
			if _, err := b.Consume(ctx, spec.Name, manual(spec, 1), slow(&seenB)); err != nil {
				t.Fatal(err)
			}
			time.Sleep(target.Settle)
			var want []string
			for i := 0; i < 20; i++ {
				body := fmt.Sprintf("m%d", i)
				want = append(want, body)
				if _, err := a.Publish(ctx, spec.Name, sampleEvent(body), transport.PublishOptions{}); err != nil {
					t.Fatal(err)
				}
			}
			WaitFor(t, wait*2, "all deliveries", func() bool { return seenA.len()+seenB.len() == 20 })
			all := append(seenA.get(), seenB.get()...)
			if !sameSet(all, want) {
				t.Fatalf("got %v", all)
			}
			if seenA.len() == 0 || seenB.len() == 0 {
				t.Fatalf("not shared: a=%d b=%d", seenA.len(), seenB.len())
			}
		})

		t.Run("delivers every event to every consumer without a group (broadcast)", func(t *testing.T) {
			d := connected(t)
			spec := channel("broadcast", transport.DeliveryBroadcast)
			_ = d.Declare(ctx, []transport.ChannelSpec{spec})
			var a, b bodies
			bc := transport.ConsumeOptions{Prefetch: 8, AckMode: transport.AckAuto}
			if _, err := d.Consume(ctx, spec.Name, bc, func(_ context.Context, e transport.WireEvent, _ transport.Delivery) { a.add(string(e.Body)) }); err != nil {
				t.Fatal(err)
			}
			if _, err := d.Consume(ctx, spec.Name, bc, func(_ context.Context, e transport.WireEvent, _ transport.Delivery) { b.add(string(e.Body)) }); err != nil {
				t.Fatal(err)
			}
			_, _ = d.Publish(ctx, spec.Name, sampleEvent("x"), transport.PublishOptions{})
			_, _ = d.Publish(ctx, spec.Name, sampleEvent("y"), transport.PublishOptions{})
			WaitFor(t, wait, "both consumers", func() bool { return a.len() == 2 && b.len() == 2 })
			if strings.Join(a.get(), ",") != "x,y" || strings.Join(b.get(), ",") != "x,y" {
				t.Fatalf("a=%v b=%v", a.get(), b.get())
			}
		})

		name = "drops on nack (nack not supported)"
		if caps.Nack {
			name = "redelivers after Nack(requeue) and not after Nack(drop)"
		}
		t.Run(name, func(t *testing.T) {
			d := connected(t)
			spec := shared("nack")
			_ = d.Declare(ctx, []transport.ChannelSpec{spec})
			var got bodies
			var attempts []int
			var mu sync.Mutex
			_, err := d.Consume(ctx, spec.Name, manual(spec, 4), func(ctx context.Context, e transport.WireEvent, del transport.Delivery) {
				body := string(e.Body)
				got.add(body)
				mu.Lock()
				attempts = append(attempts, del.Attempt())
				mu.Unlock()
				switch {
				case body == "requeue" && del.Attempt() == 1:
					_ = del.Nack(ctx, true)
				case body == "drop":
					_ = del.Nack(ctx, false)
				default:
					_ = del.Ack(ctx)
				}
			})
			if err != nil {
				t.Fatal(err)
			}
			_, _ = d.Publish(ctx, spec.Name, sampleEvent("requeue"), transport.PublishOptions{})
			_, _ = d.Publish(ctx, spec.Name, sampleEvent("drop"), transport.PublishOptions{})
			if caps.Nack {
				WaitFor(t, wait, "redelivery", func() bool { return got.count("requeue") == 2 })
				if caps.Attempts {
					mu.Lock()
					has2 := false
					for _, a := range attempts {
						if a == 2 {
							has2 = true
						}
					}
					mu.Unlock()
					if !has2 {
						t.Fatalf("attempts %v", attempts)
					}
				}
			} else {
				WaitFor(t, wait, "deliveries", func() bool { return got.len() == 2 })
			}
			time.Sleep(50 * time.Millisecond)
			if got.count("drop") != 1 {
				t.Fatalf("drop delivered %d times", got.count("drop"))
			}
			wantRequeue := 1
			if caps.Nack {
				wantRequeue = 2
			}
			if got.count("requeue") != wantRequeue {
				t.Fatalf("requeue delivered %d times", got.count("requeue"))
			}
		})

		t.Run("hands the unacknowledged deliveries of a closed consumer to another one", func(t *testing.T) {
			if !caps.WorkSharing {
				t.Skip("no work sharing")
			}
			a, b := connected(t), connected(t)
			spec := shared("death")
			_ = a.Declare(ctx, []transport.ChannelSpec{spec})
			var aGot atomic.Bool
			var bGot bodies
			subA, err := a.Consume(ctx, spec.Name, manual(spec, 1), func(context.Context, transport.WireEvent, transport.Delivery) { aGot.Store(true) })
			if err != nil {
				t.Fatal(err)
			}
			_, _ = a.Publish(ctx, spec.Name, sampleEvent("orphan"), transport.PublishOptions{})
			WaitFor(t, wait, "first delivery", aGot.Load)
			if _, err := b.Consume(ctx, spec.Name, manual(spec, 1), func(ctx context.Context, e transport.WireEvent, del transport.Delivery) {
				bGot.add(string(e.Body))
				_ = del.Ack(ctx)
			}); err != nil {
				t.Fatal(err)
			}
			_ = subA.Close(ctx)
			WaitFor(t, wait*2, "redelivery to the survivor", func() bool { return bGot.len() == 1 })
			if bGot.get()[0] != "orphan" {
				t.Fatalf("%v", bGot.get())
			}
		})

		t.Run(fmt.Sprintf("reports an event nobody can take (undeliverable: %s)", caps.Undeliverable), func(t *testing.T) {
			d := connected(t)
			spec := shared("nobody")
			_ = d.Declare(ctx, []transport.ChannelSpec{spec})
			outcome, err := d.Publish(ctx, spec.Name, sampleEvent("x"), transport.PublishOptions{})
			if err != nil {
				t.Fatal(err)
			}
			want := transport.Accepted
			if caps.Undeliverable == transport.UndeliverableReported {
				want = transport.Unroutable
			}
			if outcome != want {
				t.Fatalf("got %s want %s", outcome, want)
			}
		})

		t.Run("holds events published before a consumer arrives", func(t *testing.T) {
			if !caps.Buffering || caps.Undeliverable == transport.UndeliverableReported {
				t.Skip("buffering not claimed, or publishes to nobody are reported")
			}
			d := connected(t)
			spec := shared("buffer")
			_ = d.Declare(ctx, []transport.ChannelSpec{spec})
			_, _ = d.Publish(ctx, spec.Name, sampleEvent("early"), transport.PublishOptions{})
			var got bodies
			if _, err := d.Consume(ctx, spec.Name, auto(spec, 4), func(_ context.Context, e transport.WireEvent, _ transport.Delivery) { got.add(string(e.Body)) }); err != nil {
				t.Fatal(err)
			}
			WaitFor(t, wait, "buffered delivery", func() bool { return got.len() == 1 })
			if got.get()[0] != "early" {
				t.Fatal(got.get())
			}
		})

		t.Run("drops an event whose TTL passed before delivery", func(t *testing.T) {
			if !caps.TTL || !caps.Buffering || caps.Undeliverable == transport.UndeliverableReported {
				t.Skip("TTL not claimed or not observable")
			}
			d := connected(t)
			spec := shared("ttl")
			_ = d.Declare(ctx, []transport.ChannelSpec{spec})
			_, _ = d.Publish(ctx, spec.Name, sampleEvent("stale"), transport.PublishOptions{TTL: 20 * time.Millisecond})
			time.Sleep(120 * time.Millisecond)
			var got bodies
			if _, err := d.Consume(ctx, spec.Name, auto(spec, 4), func(_ context.Context, e transport.WireEvent, _ transport.Delivery) { got.add(string(e.Body)) }); err != nil {
				t.Fatal(err)
			}
			_, _ = d.Publish(ctx, spec.Name, sampleEvent("fresh"), transport.PublishOptions{TTL: time.Minute})
			WaitFor(t, wait, "fresh delivery", func() bool { return got.len() >= 1 })
			time.Sleep(50 * time.Millisecond)
			if strings.Join(got.get(), ",") != "fresh" {
				t.Fatal(got.get())
			}
		})

		t.Run("holds further deliveries while prefetch is exhausted", func(t *testing.T) {
			d := connected(t)
			spec := shared("prefetch")
			_ = d.Declare(ctx, []transport.ChannelSpec{spec})
			var mu sync.Mutex
			var deliveries []transport.Delivery
			count := func() int { mu.Lock(); defer mu.Unlock(); return len(deliveries) }
			if _, err := d.Consume(ctx, spec.Name, manual(spec, 1), func(_ context.Context, _ transport.WireEvent, del transport.Delivery) {
				mu.Lock()
				deliveries = append(deliveries, del)
				mu.Unlock()
			}); err != nil {
				t.Fatal(err)
			}
			_, _ = d.Publish(ctx, spec.Name, sampleEvent("1"), transport.PublishOptions{})
			_, _ = d.Publish(ctx, spec.Name, sampleEvent("2"), transport.PublishOptions{})
			WaitFor(t, wait, "first delivery", func() bool { return count() == 1 })
			time.Sleep(100 * time.Millisecond)
			if count() != 1 {
				t.Fatalf("%d deliveries with prefetch 1", count())
			}
			mu.Lock()
			first := deliveries[0]
			mu.Unlock()
			_ = first.Ack(ctx)
			WaitFor(t, wait, "second delivery after ack", func() bool { return count() == 2 })
			mu.Lock()
			second := deliveries[1]
			mu.Unlock()
			_ = second.Ack(ctx)
		})

		t.Run("keeps events with one ordering key in order", func(t *testing.T) {
			if !caps.OrderingKeys {
				t.Skip("ordering keys not claimed")
			}
			d := connected(t)
			spec := shared("order")
			_ = d.Declare(ctx, []transport.ChannelSpec{spec})
			var got bodies
			if _, err := d.Consume(ctx, spec.Name, manual(spec, 1), func(ctx context.Context, e transport.WireEvent, del transport.Delivery) {
				got.add(string(e.Body))
				_ = del.Ack(ctx)
			}); err != nil {
				t.Fatal(err)
			}
			var want []string
			for i := 0; i < 10; i++ {
				body := fmt.Sprintf("o%d", i)
				want = append(want, body)
				_, _ = d.Publish(ctx, spec.Name, sampleEvent(body), transport.PublishOptions{OrderingKey: "exec-1"})
			}
			WaitFor(t, wait, "all deliveries", func() bool { return got.len() == 10 })
			if strings.Join(got.get(), ",") != strings.Join(want, ",") {
				t.Fatal(got.get())
			}
		})

		t.Run("answers a native request through Reply, and reports timeout / unroutable", func(t *testing.T) {
			if caps.Replies != transport.RepliesNative {
				t.Skip("reply-channel broker")
			}
			d := connected(t)
			requester := d.(transport.Requester)
			spec := shared("native")
			_ = d.Declare(ctx, []transport.ChannelSpec{spec})
			if caps.Undeliverable == transport.UndeliverableReported {
				res, err := requester.Request(ctx, spec.Name, sampleEvent("q"), transport.RequestOptions{Timeout: 500 * time.Millisecond})
				if err != nil || res.Outcome != transport.RequestUnroutable {
					t.Fatalf("%v %v", res.Outcome, err)
				}
			}
			var answer atomic.Bool
			answer.Store(true)
			if _, err := d.Consume(ctx, spec.Name, manual(spec, 4), func(ctx context.Context, e transport.WireEvent, del transport.Delivery) {
				_ = del.Ack(ctx)
				if !answer.Load() {
					return
				}
				replier, ok := del.(transport.Replier)
				if !ok {
					t.Error("delivery is not a Replier")
					return
				}
				headers := map[string]string{}
				for k, v := range e.Headers {
					headers[k] = v
				}
				headers["type"] = "dev.landflow.plugin.v1.health.response"
				_ = replier.Reply(ctx, transport.WireEvent{Headers: headers, Body: []byte("a:" + string(e.Body))})
			}); err != nil {
				t.Fatal(err)
			}
			res, err := requester.Request(ctx, spec.Name, sampleEvent("q"), transport.RequestOptions{Timeout: wait})
			if err != nil || res.Outcome != transport.RequestReplied {
				t.Fatalf("%v %v", res.Outcome, err)
			}
			if string(res.Event.Body) != "a:q" {
				t.Fatalf("body %q", res.Event.Body)
			}
			if caps.Headers && res.Event.Headers["type"] != "dev.landflow.plugin.v1.health.response" {
				t.Fatalf("headers %v", res.Event.Headers)
			}
			answer.Store(false)
			res, err = requester.Request(ctx, spec.Name, sampleEvent("q"), transport.RequestOptions{Timeout: 100 * time.Millisecond})
			if err != nil || res.Outcome != transport.RequestTimeout {
				t.Fatalf("%v %v", res.Outcome, err)
			}
		})

		t.Run("reports consumers (and depth where it can) in stats", func(t *testing.T) {
			d := connected(t)
			reporter, ok := d.(transport.StatsReporter)
			if !ok {
				t.Skip("no stats (optional)")
			}
			spec := shared("stats")
			_ = d.Declare(ctx, []transport.ChannelSpec{spec})
			before, err := reporter.Stats(ctx, spec.Name)
			if err != nil {
				t.Fatal(err)
			}
			if before.Consumers != nil && *before.Consumers != 0 {
				t.Fatalf("consumers before: %d", *before.Consumers)
			}
			var mu sync.Mutex
			var deliveries []transport.Delivery
			if _, err := d.Consume(ctx, spec.Name, manual(spec, 1), func(_ context.Context, _ transport.WireEvent, del transport.Delivery) {
				mu.Lock()
				deliveries = append(deliveries, del)
				mu.Unlock()
			}); err != nil {
				t.Fatal(err)
			}
			during, _ := reporter.Stats(ctx, spec.Name)
			for i := 0; i < 50 && during.Consumers != nil && *during.Consumers < 1; i++ {
				time.Sleep(wait / 50)
				during, _ = reporter.Stats(ctx, spec.Name)
			}
			if during.Consumers != nil && *during.Consumers < 1 {
				t.Fatalf("consumers during: %d", *during.Consumers)
			}
			if caps.Buffering {
				_, _ = d.Publish(ctx, spec.Name, sampleEvent("1"), transport.PublishOptions{})
				_, _ = d.Publish(ctx, spec.Name, sampleEvent("2"), transport.PublishOptions{})
				WaitFor(t, wait, "first delivery", func() bool { mu.Lock(); defer mu.Unlock(); return len(deliveries) == 1 })
				queued, _ := reporter.Stats(ctx, spec.Name)
				if queued.Depth != nil {
					lag := 0
					if queued.Lag != nil {
						lag = *queued.Lag
					}
					if *queued.Depth+lag < 1 {
						t.Fatalf("depth %d lag %d", *queued.Depth, lag)
					}
				}
				mu.Lock()
				for _, del := range deliveries {
					_ = del.Ack(ctx)
				}
				mu.Unlock()
			}
		})

		t.Run("carries an event of half MaxMessageBytes", func(t *testing.T) {
			d := connected(t)
			spec := shared("big")
			_ = d.Declare(ctx, []transport.ChannelSpec{spec})
			var mu sync.Mutex
			var got []int
			if _, err := d.Consume(ctx, spec.Name, auto(spec, 1), func(_ context.Context, e transport.WireEvent, _ transport.Delivery) {
				mu.Lock()
				got = append(got, len(e.Body))
				mu.Unlock()
			}); err != nil {
				t.Fatal(err)
			}
			size := caps.MaxMessageBytes / 2
			if size > 4*1024*1024 {
				size = 4 * 1024 * 1024
			}
			big := sampleEvent(strings.Repeat("x", size))
			if _, err := d.Publish(ctx, spec.Name, big, transport.PublishOptions{}); err != nil {
				t.Fatal(err)
			}
			WaitFor(t, wait*3, "big delivery", func() bool { mu.Lock(); defer mu.Unlock(); return len(got) == 1 })
			if got[0] != size {
				t.Fatalf("size %d want %d", got[0], size)
			}
		})
	})
}

func sameSet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	count := map[string]int{}
	for _, x := range a {
		count[x]++
	}
	for _, x := range b {
		count[x]--
	}
	for _, n := range count {
		if n != 0 {
			return false
		}
	}
	return true
}

// seen is one dispatched call as the test dispatcher recorded it.
type seen struct {
	method  transport.Method
	context transport.DispatchContext
	body    json.RawMessage
	ctx     context.Context
}

type seenList struct {
	mu   sync.Mutex
	list []seen
}

func (s *seenList) add(x seen) {
	s.mu.Lock()
	s.list = append(s.list, x)
	s.mu.Unlock()
}

func (s *seenList) len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.list)
}

func (s *seenList) at(i int) seen {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.list[i]
}

type hook func(ctx context.Context, dc transport.DispatchContext, body json.RawMessage) (any, bool, error)

func echoDispatcher(record *seenList, h hook) transport.Dispatcher {
	return func(ctx context.Context, method transport.Method, body json.RawMessage, dc transport.DispatchContext) (any, error) {
		if record != nil {
			record.add(seen{method: method, context: dc, body: body, ctx: ctx})
		}
		if h != nil {
			if out, handled, err := h(ctx, dc, body); handled {
				return out, err
			}
		}
		switch method {
		case transport.MethodExecute:
			var req struct {
				Inputs []json.RawMessage `json:"inputs"`
			}
			_ = json.Unmarshal(body, &req)
			return map[string]any{"outputs": req.Inputs}, nil
		case transport.MethodHealth:
			return map[string]any{"status": "ok", "uptimeMs": 1, "pluginId": "x", "version": "1"}, nil
		case transport.MethodLoadOptions:
			return map[string]any{"options": []map[string]any{{"name": "A", "value": "a"}}}, nil
		}
		return map[string]any{}, nil
	}
}

func blockUntilCancelled(ctx context.Context, _ transport.DispatchContext, _ json.RawMessage) (any, bool, error) {
	<-ctx.Done()
	return nil, true, context.Cause(ctx)
}

func testManifest(pluginID string) map[string]any {
	node := func(name string, idempotent bool) map[string]any {
		n := map[string]any{"name": name, "displayName": strings.ToUpper(name[:1]) + name[1:], "description": "", "version": 1, "kind": "action",
			"inputs": []map[string]any{{"type": "main"}}, "outputs": []map[string]any{{"type": "main"}}, "properties": []any{}}
		if idempotent {
			n["idempotent"] = true
		}
		return n
	}
	return map[string]any{
		"protocol":       "landflow.plugin/v1",
		"plugin":         map[string]any{"id": pluginID, "name": "Conformance", "version": "1.0.0", "language": "go"},
		"nodes":          []map[string]any{node("echo", false), node("lookup", true)},
		"maxConcurrency": 2,
	}
}

func executeBody(pluginID, node string, extra map[string]any) map[string]any {
	body := map[string]any{
		"protocol": "landflow.plugin/v1", "executionId": "exec-1", "mode": "manual",
		"node":           map[string]any{"id": "n1", "name": node, "type": pluginID + "." + node, "typeVersion": 1},
		"parameters":     map[string]any{},
		"itemParameters": []map[string]any{{}},
		"inputs":         []any{[]map[string]any{{"json": map[string]any{"hello": "world"}}}},
		"credentials":    map[string]any{"api": map[string]any{"token": "top-secret-token"}},
	}
	for k, v := range extra {
		body[k] = v
	}
	return body
}

func outputsOf(t testing.TB, raw json.RawMessage) []json.RawMessage {
	t.Helper()
	var resp struct {
		Outputs []json.RawMessage `json:"outputs"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		t.Fatalf("response %s: %v", raw, err)
	}
	return resp.Outputs
}

// RunCore checks the core end to end over the driver.
func RunCore(t *testing.T, target Target) {
	wait := target.DeliveryTimeout
	if wait <= 0 {
		wait = 2 * time.Second
	}
	ctx := context.Background()
	t.Run(target.Name+" core conformance", func(t *testing.T) {
		caps := target.Driver(target.Config).Capabilities()
		keyring := transport.MustKeyring(secret)
		prefix := "lfcore" + randomHex(3)
		config := target.Config
		config.Prefix = prefix
		names := transport.NewNames(prefix)
		type serverOverride func(*transport.ServerOptions)
		startServer := func(t *testing.T, pluginID string, dispatch transport.Dispatcher, overrides ...serverOverride) *transport.Server {
			opts := transport.ServerOptions{
				Driver: target.Driver(config), Keyring: keyring, PluginID: pluginID, Version: "1.0.0", Manifest: testManifest(pluginID), Dispatch: dispatch,
				RegistrySecret: registrySecret, AnnounceInterval: 250 * time.Millisecond, DrainTimeout: 200 * time.Millisecond, Log: transport.SilentLogger,
			}
			for _, o := range overrides {
				o(&opts)
			}
			server, err := transport.StartServer(ctx, opts)
			if err != nil {
				t.Fatalf("start server: %v", err)
			}
			t.Cleanup(func() { _ = server.Stop(ctx) })
			return server
		}
		type clientOverride func(*transport.ClientOptions)
		startClient := func(t *testing.T, overrides ...clientOverride) *transport.Client {
			opts := transport.ClientOptions{Driver: target.Driver(config), Keyring: keyring, RegistrySecret: registrySecret, StatsInterval: -1, Log: transport.SilentLogger}
			for _, o := range overrides {
				o(&opts)
			}
			client, err := transport.StartClient(ctx, opts)
			if err != nil {
				t.Fatalf("start client: %v", err)
			}
			t.Cleanup(func() { _ = client.Close() })
			return client
		}
		pluginID := func() string { return "conf-" + randomHex(3) }
		announced := func(t *testing.T, client *transport.Client, id string, instances int) {
			t.Helper()
			WaitFor(t, wait, "announce of "+id, func() bool {
				p, ok := client.Plugin(id)
				return ok && len(p.Instances) >= instances
			})
		}
		call := func(client *transport.Client, id string, method transport.Method, body any, opts transport.CallOptions) (json.RawMessage, error) {
			if opts.Timeout == 0 {
				opts.Timeout = wait
			}
			return client.Call(ctx, id, method, body, opts)
		}

		t.Run("calls a plugin and gets its reply, with the credentials intact end to end", func(t *testing.T) {
			id := pluginID()
			var record seenList
			server := startServer(t, id, echoDispatcher(&record, nil))
			client := startClient(t)
			announced(t, client, id, 1)
			reply, err := client.Invoke(ctx, id, transport.MethodExecute, executeBody(id, "echo", nil), transport.CallOptions{Timeout: wait})
			if err != nil {
				t.Fatal(err)
			}
			outputs := outputsOf(t, reply.Body)
			if len(outputs) != 1 || !bytes.Contains(outputs[0], []byte(`"hello":"world"`)) {
				t.Fatalf("outputs %s", reply.Body)
			}
			if reply.InstanceID != server.InstanceID || reply.Attributes.Type != "dev.landflow.plugin.v1.execute.response" || reply.Attributes.LfManifest != server.ManifestHash {
				t.Fatalf("reply %+v", reply.Attributes)
			}
			if !bytes.Contains(record.at(0).body, []byte(`"token":"top-secret-token"`)) {
				t.Fatalf("credentials lost: %s", record.at(0).body)
			}
			if record.at(0).context.Delivery != transport.AtMostOnce || record.at(0).context.Attempt != 1 {
				t.Fatalf("context %+v", record.at(0).context)
			}
			health, err := call(client, id, transport.MethodHealth, map[string]any{}, transport.CallOptions{})
			if err != nil || !bytes.Contains(health, []byte(`"status":"ok"`)) {
				t.Fatalf("health %s %v", health, err)
			}
			if record.at(1).context.Delivery != transport.AtLeastOnce {
				t.Fatal("health should be at least once")
			}
		})

		t.Run("puts only ciphertext on the wire", func(t *testing.T) {
			if target.Tap == nil {
				t.Skip("no tap")
			}
			id := pluginID()
			startServer(t, id, echoDispatcher(nil, nil))
			client := startClient(t)
			announced(t, client, id, 1)
			var mu sync.Mutex
			var captured []string
			untap := target.Tap(func(channel string, event transport.WireEvent) (transport.WireEvent, bool) {
				if channel == names.Request(id) || strings.HasPrefix(channel, prefix+".v1.reply.") || strings.HasSuffix(channel, ":reply") {
					mu.Lock()
					captured = append(captured, string(event.Body)+fmt.Sprint(event.Headers))
					mu.Unlock()
				}
				return event, true
			})
			_, err := call(client, id, transport.MethodExecute, executeBody(id, "echo", nil), transport.CallOptions{})
			untap()
			if err != nil {
				t.Fatal(err)
			}
			if len(captured) == 0 {
				t.Fatal("nothing captured")
			}
			for _, c := range captured {
				if strings.Contains(c, "top-secret-token") || strings.Contains(c, "hello") {
					t.Fatal("plaintext on the wire")
				}
			}
		})

		t.Run("fails with TimeoutError at the deadline and cancels the dispatcher", func(t *testing.T) {
			id := pluginID()
			var record seenList
			startServer(t, id, echoDispatcher(&record, blockUntilCancelled))
			client := startClient(t)
			announced(t, client, id, 1)
			_, err := client.Call(ctx, id, transport.MethodExecute, executeBody(id, "echo", nil), transport.CallOptions{Timeout: 300 * time.Millisecond})
			var te *transport.TimeoutError
			if !errors.As(err, &te) {
				t.Fatalf("got %v", err)
			}
			if me, _ := transport.AsMessagingError(err); me.Knowledge() != transport.MaybeDelivered {
				t.Fatal("knowledge")
			}
			WaitFor(t, wait, "dispatcher cancel", func() bool { return record.len() == 1 && record.at(0).ctx.Err() != nil })
		})

		t.Run("sends a cancel when the caller cancels; the plugin cancels the call", func(t *testing.T) {
			id := pluginID()
			var record seenList
			server := startServer(t, id, echoDispatcher(&record, blockUntilCancelled))
			client := startClient(t)
			announced(t, client, id, 1)
			callCtx, cancel := context.WithCancelCause(ctx)
			done := make(chan error, 1)
			go func() {
				_, err := client.Call(callCtx, id, transport.MethodExecute, executeBody(id, "echo", nil), transport.CallOptions{Timeout: wait * 2})
				done <- err
			}()
			WaitFor(t, wait, "dispatch", func() bool { return record.len() == 1 })
			cancel(errors.New("user stopped"))
			var ce *transport.CancelledError
			if err := <-done; !errors.As(err, &ce) {
				t.Fatalf("got %v", err)
			}
			WaitFor(t, wait, "plugin-side cancel", func() bool { return record.at(0).ctx.Err() != nil })
			WaitFor(t, wait, "cancel counter", func() bool { return server.Counters().Cancelled == 1 })
		})

		t.Run("rejects a call cancelled before publishing as undeliverable", func(t *testing.T) {
			client := startClient(t)
			aborted, cancel := context.WithCancel(ctx)
			cancel()
			_, err := client.Call(aborted, pluginID(), transport.MethodHealth, map[string]any{}, transport.CallOptions{})
			var ue *transport.UndeliverableError
			if !errors.As(err, &ue) || ue.Reason != transport.ReasonAborted {
				t.Fatalf("got %v", err)
			}
		})

		t.Run("uses at most once by default and at least once only for repeatable work", func(t *testing.T) {
			id := pluginID()
			var record seenList
			startServer(t, id, echoDispatcher(&record, nil))
			client := startClient(t)
			announced(t, client, id, 1)
			must := func(_ json.RawMessage, err error) {
				if err != nil {
					t.Fatal(err)
				}
			}
			must(call(client, id, transport.MethodExecute, executeBody(id, "echo", nil), transport.CallOptions{}))
			must(call(client, id, transport.MethodExecute, executeBody(id, "echo", nil), transport.CallOptions{Delivery: transport.AtLeastOnce}))
			must(call(client, id, transport.MethodExecute, executeBody(id, "lookup", nil), transport.CallOptions{Delivery: transport.AtLeastOnce}))
			must(call(client, id, transport.MethodExecute, executeBody(id, "echo", map[string]any{"idempotencyKey": "k1"}), transport.CallOptions{Delivery: transport.AtLeastOnce, IdempotencyKey: "k1"}))
			must(call(client, id, transport.MethodLoadOptions, map[string]any{"nodeType": id + ".echo", "method": "m", "parameters": map[string]any{}}, transport.CallOptions{}))
			want := []transport.DeliveryMode{transport.AtMostOnce, transport.AtMostOnce, transport.AtLeastOnce, transport.AtLeastOnce, transport.AtLeastOnce}
			for i, w := range want {
				if record.at(i).context.Delivery != w {
					t.Fatalf("call %d: %s want %s", i, record.at(i).context.Delivery, w)
				}
			}
			if record.at(3).context.IdempotencyKey != "k1" {
				t.Fatal("idempotency key")
			}
		})

		t.Run("a replica that dies mid-call: at least once moves to the survivor, at most once times out", func(t *testing.T) {
			if !caps.WorkSharing || !caps.Nack {
				t.Skip("needs work sharing and nack")
			}
			id := pluginID()
			var seenA, seenB seenList
			hang := func(ctx context.Context, _ transport.DispatchContext, _ json.RawMessage) (any, bool, error) {
				<-ctx.Done()
				return nil, true, ctx.Err()
			}
			a := startServer(t, id, echoDispatcher(&seenA, hang))
			client := startClient(t)
			announced(t, client, id, 1)
			atLeastOnce := make(chan struct {
				body json.RawMessage
				err  error
			}, 1)
			atMostOnce := make(chan error, 1)
			go func() {
				body, err := client.Call(ctx, id, transport.MethodExecute, executeBody(id, "lookup", nil), transport.CallOptions{Timeout: wait * 3, Delivery: transport.AtLeastOnce})
				atLeastOnce <- struct {
					body json.RawMessage
					err  error
				}{body, err}
			}()
			go func() {
				_, err := client.Call(ctx, id, transport.MethodExecute, executeBody(id, "echo", nil), transport.CallOptions{Timeout: 600 * time.Millisecond})
				atMostOnce <- err
			}()
			WaitFor(t, wait, "both calls at replica A", func() bool { return seenA.len() == 2 })
			b := startServer(t, id, echoDispatcher(&seenB, nil))
			announced(t, client, id, 2)
			_ = a.Driver().Close() // crash: no Stop, no drain
			res := <-atLeastOnce
			if res.err != nil {
				t.Fatalf("at least once: %v", res.err)
			}
			if outputs := outputsOf(t, res.body); len(outputs) != 1 {
				t.Fatalf("outputs %s", res.body)
			}
			if seenB.len() != 1 {
				t.Fatalf("B saw %d", seenB.len())
			}
			if caps.Attempts && seenB.at(0).context.Attempt != 2 {
				t.Fatalf("attempt %d", seenB.at(0).context.Attempt)
			}
			var te *transport.TimeoutError
			if err := <-atMostOnce; !errors.As(err, &te) {
				t.Fatalf("at most once: %v", err)
			}
			if b.Counters().Dispatched != 1 {
				t.Fatalf("B dispatched %d", b.Counters().Dispatched)
			}
		})

		t.Run("discovers plugins on the registry channel and forgets them on withdraw", func(t *testing.T) {
			id := pluginID()
			client := startClient(t)
			var mu sync.Mutex
			var events []string
			client.OnPlugin(func(e transport.PluginEvent) {
				mu.Lock()
				events = append(events, string(e.Type)+":"+e.Plugin.PluginID)
				mu.Unlock()
			})
			server := startServer(t, id, echoDispatcher(nil, nil))
			announced(t, client, id, 1)
			plugin, _ := client.Plugin(id)
			if plugin.Endpoint != fmt.Sprintf("%s://%s/%s", target.Driver(config).Kind(), config.ConnectionID, id) || plugin.ManifestHash != server.ManifestHash || plugin.Version != "1.0.0" {
				t.Fatalf("%+v", plugin)
			}
			if plugin.Instances[0].InstanceID != server.InstanceID || plugin.Instances[0].MaxConcurrency != 2 {
				t.Fatalf("%+v", plugin.Instances)
			}
			mu.Lock()
			if strings.Join(events, ",") != "announced:"+id {
				t.Fatalf("events %v", events)
			}
			mu.Unlock()
			_ = server.Stop(ctx)
			WaitFor(t, wait, "withdraw", func() bool { p, ok := client.Plugin(id); return ok && len(p.Instances) == 0 })
			mu.Lock()
			if strings.Join(events, ",") != "announced:"+id+",withdrawn:"+id {
				t.Fatalf("events %v", events)
			}
			mu.Unlock()
			_, err := client.Call(ctx, id, transport.MethodHealth, map[string]any{}, transport.CallOptions{Timeout: 300 * time.Millisecond})
			var ue *transport.UndeliverableError
			if !errors.As(err, &ue) || ue.Reason != transport.ReasonNoConsumers {
				t.Fatalf("got %v", err)
			}
		})

		t.Run("ignores announces without a valid registry proof, and unsigned ones", func(t *testing.T) {
			id := pluginID()
			client := startClient(t)
			startServer(t, id, echoDispatcher(nil, nil), func(o *transport.ServerOptions) { o.RegistrySecret = "another-secret" })
			other := pluginID()
			startServer(t, other, echoDispatcher(nil, nil), func(o *transport.ServerOptions) { o.Keyring = transport.MustKeyring("another-transport-secret") })
			time.Sleep(200 * time.Millisecond)
			if _, ok := client.Plugin(id); ok {
				t.Fatal("announce with a bad proof accepted")
			}
			if _, ok := client.Plugin(other); ok {
				t.Fatal("announce with a foreign key accepted")
			}
			lenient := startClient(t, func(o *transport.ClientOptions) { o.NoRegistryProof = true })
			announced(t, lenient, id, 1)
		})

		t.Run("answers manifest_mismatch after one requeue when the host knows another manifest", func(t *testing.T) {
			id := pluginID()
			server := startServer(t, id, echoDispatcher(nil, nil))
			client := startClient(t)
			announced(t, client, id, 1)
			_, err := call(client, id, transport.MethodHealth, map[string]any{}, transport.CallOptions{ManifestHash: "deadbeefdeadbeef"})
			var mm *transport.ManifestMismatchError
			if !errors.As(err, &mm) || mm.Actual != server.ManifestHash || mm.Expected != "deadbeefdeadbeef" {
				t.Fatalf("got %v", err)
			}
			var re *transport.RemoteError
			if !errors.As(err, &re) || re.RemoteCode != transport.CodeManifestMismatch {
				t.Fatal("ManifestMismatchError must unwrap to a RemoteError")
			}
			counters := server.Counters()
			wantMismatched, wantRequeued := int64(1), int64(0)
			if caps.Nack {
				wantMismatched, wantRequeued = 2, 1
			}
			if counters.Mismatched != wantMismatched || counters.Requeued != wantRequeued {
				t.Fatalf("counters %+v", counters)
			}
			if health, err := call(client, id, transport.MethodHealth, map[string]any{}, transport.CallOptions{}); err != nil || !bytes.Contains(health, []byte(`"ok"`)) {
				t.Fatalf("%s %v", health, err)
			}
		})

		t.Run("drops tampered, unsigned and foreign-key requests without running them", func(t *testing.T) {
			id := pluginID()
			var record seenList
			server := startServer(t, id, echoDispatcher(&record, nil))
			client := startClient(t)
			announced(t, client, id, 1)
			raw := target.Driver(config)
			if err := raw.Connect(ctx); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = raw.Close() })
			_ = raw.Declare(ctx, []transport.ChannelSpec{transport.RequestSpec(names.Request(id), 0)})
			codec := transport.NewCodec(keyring, caps, transport.CodecOptions{})
			base := func() transport.Attributes {
				a := codec.Base(transport.HostSource("attacker"), transport.RequestType(transport.MethodHealth))
				a.LfReplyTo = names.Reply("attacker")
				a.LfDeadline = fmt.Sprint(time.Now().Add(10 * time.Second).UnixMilli())
				return a
			}
			pack := func(c *transport.Codec) transport.WireEvent {
				p, err := c.Pack(id, base(), map[string]any{}, true)
				if err != nil {
					t.Fatal(err)
				}
				return p.Wire
			}
			// 1. a valid event with one body byte flipped
			flipped := pack(codec)
			flipped.Body = append([]byte(nil), flipped.Body...)
			flipped.Body[len(flipped.Body)-1] ^= 0xff
			_, _ = raw.Publish(ctx, names.Request(id), flipped, transport.PublishOptions{})
			// 2. a header changed after signing (binary mode only)
			if caps.Headers {
				edited := pack(codec)
				edited.Headers["lfdeadline"] = fmt.Sprint(time.Now().Add(time.Minute).UnixMilli())
				_, _ = raw.Publish(ctx, names.Request(id), edited, transport.PublishOptions{})
			}
			// 3. unsigned
			unsigned := pack(codec)
			if caps.Headers {
				delete(unsigned.Headers, "lfsig")
			} else {
				var doc map[string]json.RawMessage
				_ = json.Unmarshal(unsigned.Body, &doc)
				delete(doc, "lfsig")
				unsigned.Body, _ = json.Marshal(doc)
			}
			_, _ = raw.Publish(ctx, names.Request(id), unsigned, transport.PublishOptions{})
			// 4. signed with another secret
			_, _ = raw.Publish(ctx, names.Request(id), pack(transport.NewCodec(transport.MustKeyring("wrong-secret"), caps, transport.CodecOptions{})), transport.PublishOptions{})
			expected := int64(3)
			if caps.Headers {
				expected = 4
			}
			WaitFor(t, wait, "drops", func() bool { return server.Counters().Dropped == expected })
			if record.len() != 0 {
				t.Fatal("a bad request ran")
			}
			if health, err := call(client, id, transport.MethodHealth, map[string]any{}, transport.CallOptions{}); err != nil || !bytes.Contains(health, []byte(`"ok"`)) {
				t.Fatalf("%s %v", health, err)
			}
		})

		t.Run("drops a tampered reply (the call times out instead of using it)", func(t *testing.T) {
			if target.Tap == nil {
				t.Skip("no tap")
			}
			id := pluginID()
			startServer(t, id, echoDispatcher(nil, nil))
			client := startClient(t)
			announced(t, client, id, 1)
			untap := target.Tap(func(channel string, event transport.WireEvent) (transport.WireEvent, bool) {
				if !strings.HasPrefix(channel, prefix+".v1.reply.") && !strings.HasSuffix(channel, ":reply") {
					return event, true
				}
				body := append([]byte(nil), event.Body...)
				body[0] ^= 0xff
				return transport.WireEvent{Headers: event.Headers, Body: body}, true
			})
			_, err := client.Call(ctx, id, transport.MethodHealth, map[string]any{}, transport.CallOptions{Timeout: 400 * time.Millisecond})
			untap()
			var te *transport.TimeoutError
			if !errors.As(err, &te) {
				t.Fatalf("got %v", err)
			}
		})

		t.Run("refuses a call bigger than the broker limit before publishing", func(t *testing.T) {
			id := pluginID()
			startServer(t, id, echoDispatcher(nil, nil))
			client := startClient(t)
			announced(t, client, id, 1)
			huge := executeBody(id, "echo", map[string]any{"inputs": []any{[]map[string]any{{"json": map[string]any{"blob": strings.Repeat("x", caps.MaxMessageBytes+1024)}}}}})
			_, err := call(client, id, transport.MethodExecute, huge, transport.CallOptions{})
			var ue *transport.UndeliverableError
			if !errors.As(err, &ue) || ue.Reason != transport.ReasonTooLargeEvent {
				t.Fatalf("got %v", err)
			}
		})

		t.Run(fmt.Sprintf("fails a call to a plugin nobody consumes (undeliverable: %s)", caps.Undeliverable), func(t *testing.T) {
			client := startClient(t)
			_, err := client.Call(ctx, pluginID(), transport.MethodHealth, map[string]any{}, transport.CallOptions{Timeout: 300 * time.Millisecond})
			if _, ok := transport.AsMessagingError(err); !ok {
				t.Fatalf("got %v", err)
			}
			if caps.Undeliverable == transport.UndeliverableReported {
				var ue *transport.UndeliverableError
				if !errors.As(err, &ue) || ue.Reason != transport.ReasonUnroutable {
					t.Fatalf("got %v", err)
				}
			} else {
				var te *transport.TimeoutError
				if !errors.As(err, &te) {
					t.Fatalf("got %v", err)
				}
			}
		})

		t.Run("runs at most maxConcurrency calls at once per instance", func(t *testing.T) {
			id := pluginID()
			var active, peak atomic.Int32
			startServer(t, id, echoDispatcher(nil, func(context.Context, transport.DispatchContext, json.RawMessage) (any, bool, error) {
				n := active.Add(1)
				for {
					p := peak.Load()
					if n <= p || peak.CompareAndSwap(p, n) {
						break
					}
				}
				time.Sleep(60 * time.Millisecond)
				active.Add(-1)
				return nil, false, nil
			}))
			client := startClient(t)
			announced(t, client, id, 1)
			var wg sync.WaitGroup
			errs := make(chan error, 6)
			for i := 0; i < 6; i++ {
				wg.Add(1)
				go func() {
					defer wg.Done()
					_, err := client.Call(ctx, id, transport.MethodExecute, executeBody(id, "echo", nil), transport.CallOptions{Timeout: wait * 3})
					errs <- err
				}()
			}
			wg.Wait()
			close(errs)
			for err := range errs {
				if err != nil {
					t.Fatal(err)
				}
			}
			if peak.Load() != 2 {
				t.Fatalf("peak %d", peak.Load())
			}
		})

		t.Run("drops a request cancelled or expired while it waited for a slot", func(t *testing.T) {
			id := pluginID()
			var record seenList
			server := startServer(t, id, echoDispatcher(&record, blockUntilCancelled), func(o *transport.ServerOptions) { o.MaxConcurrency = 1 })
			client := startClient(t)
			announced(t, client, id, 1)
			// Occupy the single slot with a call on the request channel; the waiter arrives on the instance channel (its own
			// prefetch), so it reaches the server's semaphore and waits there.
			occupy := func() (release func(), done chan error) {
				firstCtx, cancel := context.WithCancel(ctx)
				done = make(chan error, 1)
				before := record.len()
				go func() {
					_, err := client.Call(firstCtx, id, transport.MethodExecute, executeBody(id, "echo", nil), transport.CallOptions{Timeout: wait * 4})
					done <- err
				}()
				WaitFor(t, wait, "blocking call dispatched", func() bool { return record.len() == before+1 })
				return cancel, done
			}
			settle := func(what string, pred func(transport.Counters) bool) {
				t.Helper()
				until := time.Now().Add(wait)
				for !pred(server.Counters()) {
					if time.Now().After(until) {
						t.Fatalf("%s: counters %+v, dispatched %d", what, server.Counters(), record.len())
					}
					time.Sleep(5 * time.Millisecond)
				}
			}
			// 1. Cancelled while waiting.
			release, first := occupy()
			received := server.Counters().Received
			waiterCtx, cancelWaiter := context.WithCancel(ctx)
			waiter := make(chan error, 1)
			go func() {
				_, err := client.Call(waiterCtx, id, transport.MethodExecute, executeBody(id, "echo", nil), transport.CallOptions{Timeout: wait * 4, InstanceID: server.InstanceID})
				waiter <- err
			}()
			WaitFor(t, wait, "waiter received", func() bool { return server.Counters().Received > received })
			cancelWaiter()
			var ce *transport.CancelledError
			if err := <-waiter; !errors.As(err, &ce) {
				t.Fatalf("waiter: %v", err)
			}
			time.Sleep(200 * time.Millisecond) // the cancel event is published asynchronously; let it land before the slot frees
			release()
			<-first
			settle("cancelled waiter", func(c transport.Counters) bool { return c.Cancelled >= 2 }) // the blocking call's own cancel + the waiter's
			if record.len() != 1 {
				t.Fatalf("dispatched %d calls; the cancelled waiter must not run", record.len())
			}
			// 2. Expired while waiting (the deadline passes after the server received it).
			release, first = occupy()
			received = server.Counters().Received
			expiring := make(chan error, 1)
			go func() {
				_, err := client.Call(ctx, id, transport.MethodExecute, executeBody(id, "echo", nil), transport.CallOptions{Timeout: 400 * time.Millisecond, InstanceID: server.InstanceID})
				expiring <- err
			}()
			WaitFor(t, wait, "expiring waiter received", func() bool { return server.Counters().Received > received })
			var te *transport.TimeoutError
			if err := <-expiring; !errors.As(err, &te) {
				t.Fatalf("expiring waiter: %v", err)
			}
			release()
			<-first
			settle("expired waiter", func(c transport.Counters) bool { return c.Expired >= 1 })
			if record.len() != 2 {
				t.Fatalf("dispatched %d calls; the expired waiter must not run", record.len())
			}
		})

		t.Run("drains: Stop waits for the call in flight and the host gets its reply", func(t *testing.T) {
			id := pluginID()
			var record seenList
			server := startServer(t, id, echoDispatcher(&record, func(context.Context, transport.DispatchContext, json.RawMessage) (any, bool, error) {
				time.Sleep(150 * time.Millisecond)
				return nil, false, nil
			}))
			client := startClient(t)
			announced(t, client, id, 1)
			done := make(chan struct {
				body json.RawMessage
				err  error
			}, 1)
			go func() {
				body, err := call(client, id, transport.MethodExecute, executeBody(id, "echo", nil), transport.CallOptions{})
				done <- struct {
					body json.RawMessage
					err  error
				}{body, err}
			}()
			WaitFor(t, wait, "dispatch", func() bool { return record.len() == 1 })
			if err := server.Stop(ctx); err != nil {
				t.Fatal(err)
			}
			if server.InFlightCount() != 0 {
				t.Fatal("in flight after stop")
			}
			res := <-done
			if res.err != nil || len(outputsOf(t, res.body)) != 1 {
				t.Fatalf("%s %v", res.body, res.err)
			}
		})

		t.Run("reaches one instance through its instance channel", func(t *testing.T) {
			if !caps.WorkSharing {
				t.Skip("no work sharing")
			}
			id := pluginID()
			a := startServer(t, id, echoDispatcher(nil, nil))
			b := startServer(t, id, echoDispatcher(nil, nil))
			client := startClient(t)
			announced(t, client, id, 2)
			for _, server := range []*transport.Server{a, b} {
				reply, err := client.Invoke(ctx, id, transport.MethodHealth, map[string]any{}, transport.CallOptions{Timeout: wait, InstanceID: server.InstanceID})
				if err != nil || reply.InstanceID != server.InstanceID {
					t.Fatalf("%v %+v", err, reply)
				}
			}
		})

		t.Run("samples stats for announced plugins", func(t *testing.T) {
			if _, ok := target.Driver(config).(transport.StatsReporter); !ok {
				t.Skip("driver has no stats")
			}
			id := pluginID()
			startServer(t, id, echoDispatcher(nil, nil))
			client := startClient(t)
			announced(t, client, id, 1)
			client.SampleStats(ctx)
			stats, ok := client.Stats(id)
			if !ok || stats.SampledAt.IsZero() {
				t.Fatal("no stats")
			}
			if stats.Consumers != nil && *stats.Consumers < 1 {
				t.Fatalf("consumers %d", *stats.Consumers)
			}
		})

		t.Run("fails pending calls with ConnectionLostError when the client closes", func(t *testing.T) {
			id := pluginID()
			startServer(t, id, echoDispatcher(nil, func(context.Context, transport.DispatchContext, json.RawMessage) (any, bool, error) {
				time.Sleep(wait)
				return nil, false, nil
			}))
			client := startClient(t)
			announced(t, client, id, 1)
			done := make(chan error, 1)
			go func() {
				_, err := client.Call(ctx, id, transport.MethodExecute, executeBody(id, "echo", nil), transport.CallOptions{Timeout: wait * 3})
				done <- err
			}()
			time.Sleep(50 * time.Millisecond)
			_ = client.Close()
			var cl *transport.ConnectionLostError
			if err := <-done; !errors.As(err, &cl) {
				t.Fatalf("got %v", err)
			}
		})

		t.Run("propagates trace context, attempt and the subject", func(t *testing.T) {
			id := pluginID()
			var record seenList
			startServer(t, id, echoDispatcher(&record, nil))
			client := startClient(t)
			announced(t, client, id, 1)
			traceparent := "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
			reply, err := client.Invoke(ctx, id, transport.MethodExecute, executeBody(id, "echo", nil), transport.CallOptions{Timeout: wait, TraceParent: traceparent, Attempt: 3})
			if err != nil {
				t.Fatal(err)
			}
			if record.at(0).context.TraceParent != traceparent || record.at(0).context.Source != transport.HostSource(client.HostInstanceID) {
				t.Fatalf("%+v", record.at(0).context)
			}
			if reply.Attributes.TraceParent != traceparent || reply.Attributes.Subject != id+".echo" {
				t.Fatalf("%+v", reply.Attributes)
			}
		})

		t.Run("maps DispatchError codes and plain errors onto lferror", func(t *testing.T) {
			id := pluginID()
			startServer(t, id, echoDispatcher(nil, func(_ context.Context, _ transport.DispatchContext, body json.RawMessage) (any, bool, error) {
				if bytes.Contains(body, []byte(`"boom"`)) {
					return nil, true, errors.New("kaboom")
				}
				return nil, true, &transport.DispatchError{Code: transport.CodeNotFound, Message: "no such node", Details: map[string]any{"nodeType": "x"}}
			}))
			client := startClient(t)
			announced(t, client, id, 1)
			_, err := call(client, id, transport.MethodExecute, executeBody(id, "echo", nil), transport.CallOptions{})
			var re *transport.RemoteError
			if !errors.As(err, &re) || re.RemoteCode != transport.CodeNotFound || re.Message != "no such node" || re.Details["nodeType"] != "x" {
				t.Fatalf("got %v", err)
			}
			_, err = call(client, id, transport.MethodExecute, executeBody(id, "boom", nil), transport.CallOptions{})
			if !errors.As(err, &re) || re.RemoteCode != transport.CodeInternal || re.Message != "kaboom" {
				t.Fatalf("got %v", err)
			}
		})
	})
}
