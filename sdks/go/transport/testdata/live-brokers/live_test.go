// Cross-language check over every tier 1 broker: a Go plugin served with landflow.WithBroker(<driver>.New(…)) and a Go
// transport.Client on one side, the TypeScript MessagingServer + MessagingClient of @landflow/transports with its driver
// of the same kind on the other (live.mts, run with the repo's tsx). Each side discovers the other on the registry
// channel and calls it; the test asserts both directions, so the wire (channel names, header prefixes, entry layouts,
// reply headers, signing and encryption) is proven compatible per broker.
//
// Gated per kind on LANDFLOW_TEST_KAFKA / _AMQP / _NATS (also jetstream) / _VALKEY; skipped without node or tsx. Every
// run uses a unique channel prefix and deletes what it created.
package livebrokers

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kgo"
	valkeygo "github.com/valkey-io/valkey-go"

	landflow "github.com/landflow/landflow/sdks/go"
	"github.com/landflow/landflow/sdks/go/transport"
	"github.com/landflow/landflow/sdks/go/transport/amqp"
	"github.com/landflow/landflow/sdks/go/transport/kafka"
	"github.com/landflow/landflow/sdks/go/transport/nats"
	"github.com/landflow/landflow/sdks/go/transport/valkey"
)

type upperNode struct{}

func (upperNode) Description() landflow.NodeDescriptor {
	return landflow.NodeDescriptor{
		Name: "upper", DisplayName: "Upper", Description: "Upper-case a field", Version: landflow.V(1), Kind: landflow.KindAction,
		Inputs: []landflow.PortDescriptor{landflow.MainPort()}, Outputs: []landflow.PortDescriptor{landflow.MainPort()},
		Properties: []landflow.PropertyDescriptor{{Name: "field", DisplayName: "Field", Type: landflow.PropString, Default: "value"}},
		Idempotent: true,
	}
}

func (upperNode) Execute(ctx *landflow.ExecuteContext) ([][]landflow.Item, error) {
	in := ctx.InputData(0)
	out := make([]landflow.Item, 0, len(in))
	info, _ := landflow.DeliveryOf(ctx.Context())
	for i, item := range in {
		field := ctx.ParamString("field", i, "value")
		v, _ := item.JSON[field].(string)
		if v == "slow" {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(5 * time.Second):
			}
		}
		out = append(out, landflow.Item{JSON: map[string]any{field: strings.ToUpper(v), "via": info.Transport, "attempt": info.Attempt, "mode": string(info.Mode)}})
	}
	return [][]landflow.Item{out}, nil
}

func (upperNode) LoadOptions(method string, _ map[string]any) ([]landflow.PropertyOption, error) {
	return []landflow.PropertyOption{{Name: "From Go: " + method, Value: "go"}}, nil
}

type broker struct {
	kind   string
	envVar string
	url    string
	driver func(prefix string) transport.Driver
	// cleanup deletes what a run with prefix created.
	cleanup func(t *testing.T, prefix string)
}

func brokers(t *testing.T) []broker {
	t.Helper()
	kafkaURL := os.Getenv("LANDFLOW_TEST_KAFKA")
	amqpURL := os.Getenv("LANDFLOW_TEST_AMQP")
	natsURL := os.Getenv("LANDFLOW_TEST_NATS")
	valkeyURL := os.Getenv("LANDFLOW_TEST_VALKEY")
	cfg := func(kind, prefix string) transport.Config {
		return transport.Config{ConnectionID: kind + "-live", Prefix: prefix}
	}
	return []broker{
		{kind: "kafka", envVar: "LANDFLOW_TEST_KAFKA", url: kafkaURL,
			driver: func(p string) transport.Driver {
				return kafka.New(kafka.Config{Config: cfg("kafka", p), Brokers: strings.Split(kafkaURL, ","), Partitions: 2})
			},
			cleanup: func(t *testing.T, prefix string) {
				cl, err := kgo.NewClient(kgo.SeedBrokers(strings.Split(kafkaURL, ",")...))
				if err != nil {
					return
				}
				defer cl.Close()
				adm := kadm.NewClient(cl)
				ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
				defer cancel()
				topics, err := adm.ListTopics(ctx)
				if err != nil {
					return
				}
				var mine []string
				for name := range topics {
					if strings.HasPrefix(name, prefix+".") {
						mine = append(mine, name)
					}
				}
				_, _ = adm.DeleteGroups(ctx, mine...)
				_, _ = adm.DeleteTopics(ctx, mine...)
			}},
		{kind: "amqp", envVar: "LANDFLOW_TEST_AMQP", url: amqpURL,
			driver: func(p string) transport.Driver { return amqp.New(amqp.Config{Config: cfg("amqp", p), URL: amqpURL}) },
			cleanup: func(t *testing.T, prefix string) {
				d := amqp.New(amqp.Config{URL: amqpURL})
				ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
				defer cancel()
				if err := d.Connect(ctx); err != nil {
					return
				}
				defer d.Close()
				names := transport.NewNames(prefix)
				// Queues (request channels; instance queues auto-delete) and exchanges (broadcast channels).
				_ = d.Declare(ctx, []transport.ChannelSpec{
					transport.RequestSpec(names.Request("live-go"), 0), transport.RequestSpec(names.Request("ts-echo"), 0),
					{Name: names.Registry(), Delivery: transport.DeliveryBroadcast}, {Name: names.Control("live-go"), Delivery: transport.DeliveryBroadcast},
					{Name: names.Control("ts-echo"), Delivery: transport.DeliveryBroadcast}, {Name: names.Reply("ts-host"), Delivery: transport.DeliveryBroadcast},
					{Name: names.Reply("go-host"), Delivery: transport.DeliveryBroadcast},
				})
				_ = d.DeleteChannels(ctx, names.Request("live-go"), names.Request("ts-echo"), names.Registry(), names.Control("live-go"), names.Control("ts-echo"), names.Reply("ts-host"), names.Reply("go-host"))
			}},
		{kind: "nats", envVar: "LANDFLOW_TEST_NATS", url: natsURL,
			driver:  func(p string) transport.Driver { return nats.New(nats.Config{Config: cfg("nats", p), URL: natsURL}) },
			cleanup: func(*testing.T, string) {}},
		{kind: "jetstream", envVar: "LANDFLOW_TEST_NATS", url: natsURL,
			driver: func(p string) transport.Driver {
				return nats.New(nats.Config{Config: cfg("jetstream", p), URL: natsURL, JetStream: true, AckWait: 5 * time.Second})
			},
			cleanup: func(t *testing.T, prefix string) {
				d := nats.New(nats.Config{URL: natsURL, JetStream: true})
				ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
				defer cancel()
				if err := d.Connect(ctx); err != nil {
					return
				}
				defer d.Close()
				names := transport.NewNames(prefix)
				_ = d.DeleteStreams(ctx, names.Request("live-go"), names.Request("ts-echo"))
			}},
		{kind: "valkey", envVar: "LANDFLOW_TEST_VALKEY", url: valkeyURL,
			driver: func(p string) transport.Driver {
				return valkey.New(valkey.Config{Config: cfg("valkey", p), URL: valkeyURL, ClaimIdle: 2 * time.Second, Block: 200 * time.Millisecond})
			},
			cleanup: func(t *testing.T, prefix string) {
				opt, err := valkeygo.ParseURL(valkeyURL)
				if err != nil {
					return
				}
				opt.DisableCache = true
				client, err := valkeygo.NewClient(opt)
				if err != nil {
					return
				}
				defer client.Close()
				ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
				defer cancel()
				var cursor uint64
				for {
					res, err := client.Do(ctx, client.B().Scan().Cursor(cursor).Match(prefix+".*").Count(200).Build()).AsScanEntry()
					if err != nil {
						return
					}
					if len(res.Elements) > 0 {
						_ = client.Do(ctx, client.B().Del().Key(res.Elements...).Build()).Error()
					}
					if res.Cursor == 0 {
						return
					}
					cursor = res.Cursor
				}
			}},
	}
}

func findTSX(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node is not installed")
	}
	dir, _ := os.Getwd()
	for i := 0; i < 8; i++ {
		candidate := filepath.Join(dir, "packages", "transports", "node_modules", ".bin", "tsx")
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
		dir = filepath.Dir(dir)
	}
	t.Skip("packages/transports/node_modules/.bin/tsx not found (run pnpm install)")
	return ""
}

type tsResults struct {
	mu      sync.Mutex
	results map[string]map[string]any
	ready   chan struct{}
	done    chan struct{}
	raw     strings.Builder
}

func (r *tsResults) get(label string) map[string]any {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.results[label]
}

func (r *tsResults) read(out io.Reader) {
	sc := bufio.NewScanner(out)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	var readyOnce, doneOnce sync.Once
	for sc.Scan() {
		line := sc.Text()
		r.mu.Lock()
		r.raw.WriteString(line + "\n")
		r.mu.Unlock()
		switch {
		case strings.HasPrefix(line, "READY "):
			readyOnce.Do(func() { close(r.ready) })
		case line == "DONE":
			doneOnce.Do(func() { close(r.done) })
		case strings.HasPrefix(line, "RESULT "):
			rest := strings.SplitN(strings.TrimPrefix(line, "RESULT "), " ", 2)
			if len(rest) == 2 {
				var v map[string]any
				if json.Unmarshal([]byte(rest[1]), &v) == nil {
					r.mu.Lock()
					r.results[rest[0]] = v
					r.mu.Unlock()
				}
			}
		}
	}
	readyOnce.Do(func() { close(r.ready) })
	doneOnce.Do(func() { close(r.done) })
}

func TestCrossLanguage(t *testing.T) {
	tsx := findTSX(t)
	for _, b := range brokers(t) {
		b := b
		t.Run(b.kind, func(t *testing.T) {
			if b.url == "" {
				t.Skipf("set %s to run the %s cross-language check", b.envVar, b.kind)
			}
			probe := b.driver("lfprobe")
			pctx, pcancel := context.WithTimeout(context.Background(), 10*time.Second)
			err := probe.Connect(pctx)
			pcancel()
			_ = probe.Close()
			if err != nil {
				t.Skipf("%s not reachable: %v", b.kind, err)
			}
			runCross(t, tsx, b)
		})
	}
}

func runCross(t *testing.T, tsx string, b broker) {
	raw := make([]byte, 4)
	_, _ = rand.Read(raw)
	prefix := "lflive" + hex.EncodeToString(raw)
	t.Cleanup(func() { b.cleanup(t, prefix) })
	t.Setenv("LANDFLOW_TRANSPORT_SECRET", "live-cross-transport-secret")
	t.Setenv("LANDFLOW_REGISTRY_SECRET", "live-cross-registry-secret")
	t.Setenv("LANDFLOW_LOG_LEVEL", "error")
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	// The TypeScript side.
	cmd := exec.CommandContext(ctx, tsx, "live.mts")
	cmd.Env = append(os.Environ(), "LIVE_KIND="+b.kind, "LIVE_URL="+b.url, "LIVE_PREFIX="+prefix)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	ts := &tsResults{results: map[string]map[string]any{}, ready: make(chan struct{}), done: make(chan struct{})}
	go ts.read(stdout)
	defer func() {
		stdin.Close()
		_ = cmd.Wait()
		if t.Failed() {
			t.Logf("ts stdout:\n%s\nts stderr:\n%s", ts.raw.String(), stderr.String())
		}
	}()
	select {
	case <-ts.ready:
	case <-time.After(60 * time.Second):
		t.Fatalf("the TS side never became ready:\n%s\n%s", ts.raw.String(), stderr.String())
	}

	// The Go side: the plugin over the broker, and a host client on the same broker.
	plugin := landflow.NewPlugin(landflow.PluginInfo{ID: "live-go", Name: "Live Go plugin", Version: "0.0.1"}, upperNode{})
	serveCtx, stopServe := context.WithCancel(ctx)
	served := make(chan error, 1)
	go func() {
		served <- landflow.Serve(serveCtx, plugin, landflow.WithBroker(b.driver(prefix)), landflow.WithRegistryURL("off"), landflow.WithMaxConcurrency(4), landflow.WithAnnounce(false))
	}()
	keyring, err := transport.KeyringFromEnv(nil)
	if err != nil {
		t.Fatal(err)
	}
	client, err := transport.StartClient(ctx, transport.ClientOptions{Driver: b.driver(prefix), Keyring: keyring, HostInstanceID: "go-host", StatsInterval: -1, Log: transport.SilentLogger})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	deadline := time.Now().Add(40 * time.Second)
	for {
		if p, ok := client.Plugin("ts-echo"); ok && len(p.Instances) > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("ts-echo never announced to the Go host:\n%s\n%s", ts.raw.String(), stderr.String())
		}
		select {
		case err := <-served:
			t.Fatalf("serve ended early: %v", err)
		case <-time.After(100 * time.Millisecond):
		}
	}
	opts := transport.CallOptions{Timeout: 10 * time.Second}
	health, err := client.Call(ctx, "ts-echo", transport.MethodHealth, map[string]any{}, opts)
	if err != nil || !strings.Contains(string(health), `"status":"ok"`) {
		t.Errorf("Go → TS Health: %s %v", health, err)
	}
	exec := map[string]any{
		"protocol": "landflow.plugin/v1", "executionId": "live-1", "mode": "manual",
		"node": map[string]any{"id": "n1", "name": "echo", "type": "ts-echo.echo", "typeVersion": 1}, "parameters": map[string]any{},
		"itemParameters": []any{map[string]any{}}, "inputs": []any{[]any{map[string]any{"json": map[string]any{"from": "go"}}}},
		"credentials": map[string]any{"api": map[string]any{"token": "go-token"}},
	}
	reply, err := client.Invoke(ctx, "ts-echo", transport.MethodExecute, exec, transport.CallOptions{Timeout: 10 * time.Second, Delivery: transport.AtLeastOnce})
	if err != nil || !strings.Contains(string(reply.Body), `"echoedBy":"ts"`) || !strings.Contains(string(reply.Body), `"from":"go"`) {
		t.Errorf("Go → TS Execute: %s %v", reply.Body, err)
	}
	var remote *transport.RemoteError
	if _, err := client.Call(ctx, "ts-echo", transport.MethodExecute, map[string]any{"node": map[string]any{"type": "ts-echo.nope"}, "inputs": []any{}}, opts); !errors.As(err, &remote) || remote.RemoteCode != "not_found" {
		t.Errorf("Go → TS unknown node: %v", err)
	}

	// The TS side's results against the Go plugin.
	select {
	case <-ts.done:
	case <-time.After(60 * time.Second):
		t.Fatalf("the TS side did not finish:\n%s\n%s", ts.raw.String(), stderr.String())
	}
	expect := func(label string, check func(v map[string]any) bool) {
		v := ts.get(label)
		if v == nil || !check(v) {
			t.Errorf("TS → Go %s: %v", label, v)
		}
	}
	js := func(v any) string { b, _ := json.Marshal(v); return string(b) }
	expect("discovered", func(v map[string]any) bool {
		return v["pluginId"] == "live-go" && strings.HasPrefix(fmt.Sprint(v["endpoint"]), b.kind+"://")
	})
	expect("health", func(v map[string]any) bool { return strings.Contains(js(v["ok"]), `"status":"ok"`) })
	expect("manifest-hash", func(v map[string]any) bool { return v["match"] == true })
	expect("execute-amo", func(v map[string]any) bool {
		return strings.Contains(js(v["ok"]), `"value":"HELLO FROM TS"`) && strings.Contains(js(v["ok"]), `"mode":"at-most-once"`)
	})
	expect("execute-alo", func(v map[string]any) bool {
		return strings.Contains(js(v["ok"]), `"value":"AGAIN"`) && strings.Contains(js(v["ok"]), `"mode":"at-least-once"`)
	})
	expect("load-options", func(v map[string]any) bool { return strings.Contains(js(v["ok"]), "From Go: modes") })
	expect("unknown-node", func(v map[string]any) bool { return v["code"] == "not_found" })
	expect("stale-manifest", func(v map[string]any) bool { return v["error"] == "ManifestMismatchError" })
	expect("aborted", func(v map[string]any) bool { return v["ok"] == "CancelledError" })

	stopServe()
	select {
	case err := <-served:
		if err != nil {
			t.Errorf("serve: %v", err)
		}
	case <-time.After(30 * time.Second):
		t.Error("serve did not stop")
	}
}
