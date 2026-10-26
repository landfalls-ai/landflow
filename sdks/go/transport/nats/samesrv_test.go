package nats

import (
	"context"
	"reflect"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/landflow/landflow/sdks/go/transport"
)

type collector struct {
	mu   sync.Mutex
	seen []string
}

func (c *collector) add(s string) { c.mu.Lock(); c.seen = append(c.seen, s); c.mu.Unlock() }
func (c *collector) get() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := append([]string(nil), c.seen...)
	sort.Strings(out)
	return out
}

func wire(text string) transport.WireEvent {
	return transport.WireEvent{Headers: map[string]string{"specversion": "1.0", "id": text, "type": "test", "source": "test"}, Body: []byte(text)}
}

// TestCoreAndJetStreamOnOneServer runs a "nats" and a "jetstream" driver on the same server with the same channel names
// at the same time: each request reaches only its own consumer and gets its own reply, and an announce on one kind's
// registry channel is not seen by the other.
func TestCoreAndJetStreamOnOneServer(t *testing.T) {
	url := serverURL(t)
	prefix := randomPrefix()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	mk := func(js bool) *Driver {
		d := New(Config{Config: transport.Config{ConnectionID: "same", Prefix: prefix}, URL: url, JetStream: js, AckWait: 5 * time.Second})
		if err := d.Connect(ctx); err != nil {
			t.Skipf("NATS not reachable: %v", err)
		}
		return d
	}
	core, js := mk(false), mk(true)
	plugin, registry := prefix+".v1.plugin.echo", prefix+".v1.registry"
	specs := []transport.ChannelSpec{
		{Name: plugin, Role: transport.RoleRequest, Delivery: transport.DeliveryShared, Durable: true},
		{Name: registry, Role: transport.RoleRegistry, Delivery: transport.DeliveryBroadcast},
	}
	t.Cleanup(func() {
		dctx, dcancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer dcancel()
		_ = js.DeleteStreams(dctx, plugin)
		_ = core.Close()
		_ = js.Close()
	})
	for _, d := range []*Driver{core, js} {
		if err := d.Declare(ctx, specs); err != nil {
			t.Fatal(err)
		}
	}
	reqs := map[string]*collector{"core": {}, "js": {}}
	regs := map[string]*collector{"core": {}, "js": {}}
	for who, d := range map[string]*Driver{"core": core, "js": js} {
		who := who
		if _, err := d.Consume(ctx, plugin, transport.ConsumeOptions{Group: plugin, Prefetch: 4, AckMode: transport.AckManual}, func(c context.Context, e transport.WireEvent, dl transport.Delivery) {
			reqs[who].add(string(e.Body))
			_ = dl.(transport.Replier).Reply(c, wire(who+":"+string(e.Body)))
			_ = dl.Ack(c)
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := d.Consume(ctx, registry, transport.ConsumeOptions{Prefetch: 4, AckMode: transport.AckAuto}, func(c context.Context, e transport.WireEvent, dl transport.Delivery) {
			regs[who].add(string(e.Body))
		}); err != nil {
			t.Fatal(err)
		}
	}
	for who, d := range map[string]*Driver{"core": core, "js": js} {
		res, err := d.Request(ctx, plugin, wire(who[:1]), transport.RequestOptions{Timeout: 3 * time.Second})
		if err != nil || res.Outcome != transport.RequestReplied || string(res.Event.Body) != who+":"+who[:1] {
			t.Fatalf("%s request = %+v, %v", who, res, err)
		}
	}
	if !reflect.DeepEqual(reqs["core"].get(), []string{"c"}) || !reflect.DeepEqual(reqs["js"].get(), []string{"j"}) {
		t.Errorf("requests: core %v, js %v", reqs["core"].get(), reqs["js"].get())
	}
	for who, d := range map[string]*Driver{"core": core, "js": js} {
		if _, err := d.Publish(ctx, registry, wire("from-"+who), transport.PublishOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	time.Sleep(500 * time.Millisecond)
	if !reflect.DeepEqual(regs["core"].get(), []string{"from-core"}) || !reflect.DeepEqual(regs["js"].get(), []string{"from-js"}) {
		t.Errorf("announces: core %v, js %v", regs["core"].get(), regs["js"].get())
	}
}
