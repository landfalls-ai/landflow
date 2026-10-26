// Live cross-language check, Go side (see live-nats.mts for the TypeScript side and README.md for how to run it).
//
// It serves a small Go plugin ("live-go", one upper-case node) over NATS with landflow.WithBroker(nats.New(…)), and at
// the same time acts as a host: a transport.Client on the same broker waits for the TS plugin "ts-echo" to announce,
// calls Health and Execute on it and prints the replies. It exits when the TS side has called it (LIVE_SECONDS, default
// 40 s, bounds the whole run).
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"
	"time"

	landflow "github.com/landflow/landflow/sdks/go"
	"github.com/landflow/landflow/sdks/go/transport"
	"github.com/landflow/landflow/sdks/go/transport/nats"
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
		out = append(out, landflow.Item{JSON: map[string]any{field: strings.ToUpper(v), "via": info.Transport, "attempt": info.Attempt, "mode": string(info.Mode)}})
	}
	return [][]landflow.Item{out}, nil
}

func (upperNode) LoadOptions(method string, _ map[string]any) ([]landflow.PropertyOption, error) {
	return []landflow.PropertyOption{{Name: "From Go: " + method, Value: "go"}}, nil
}

func env(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

func main() {
	url := env("LIVE_NATS_URL", "nats://127.0.0.1:54222")
	prefix := env("LIVE_PREFIX", "lflive")
	seconds, _ := strconv.Atoi(env("LIVE_SECONDS", "40"))
	if os.Getenv("LANDFLOW_TRANSPORT_SECRET") == "" {
		os.Setenv("LANDFLOW_TRANSPORT_SECRET", "live-cross-transport-secret")
	}
	if os.Getenv("LANDFLOW_REGISTRY_SECRET") == "" {
		os.Setenv("LANDFLOW_REGISTRY_SECRET", "live-cross-registry-secret")
	}
	os.Setenv("LANDFLOW_LOG_LEVEL", env("LANDFLOW_LOG_LEVEL", "warn"))
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(seconds)*time.Second)
	defer cancel()

	plugin := landflow.NewPlugin(landflow.PluginInfo{ID: "live-go", Name: "Live Go <&> plugin", Version: "0.0.1"}, upperNode{})
	driver := func() *nats.Driver {
		return nats.New(nats.Config{Config: transport.Config{ConnectionID: "nats-live", Prefix: prefix}, URL: url})
	}
	served := make(chan error, 1)
	go func() {
		served <- landflow.Serve(ctx, plugin, landflow.WithBroker(driver()), landflow.WithRegistryURL("off"), landflow.WithMaxConcurrency(4), landflow.WithLogger(log.New(os.Stderr, "[go-plugin] ", 0)))
	}()

	// Host side: call the TS plugin when it shows up.
	keyring, err := transport.KeyringFromEnv(nil)
	if err != nil {
		log.Fatal(err)
	}
	client, err := transport.StartClient(ctx, transport.ClientOptions{Driver: driver(), Keyring: keyring, HostInstanceID: "go-host", StatsInterval: -1, Log: transport.SilentLogger})
	if err != nil {
		log.Fatal(err)
	}
	defer client.Close()
	fmt.Println("[go-host] waiting for ts-echo to announce on", url, "prefix", prefix)
	for {
		if p, ok := client.Plugin("ts-echo"); ok && len(p.Instances) > 0 {
			fmt.Printf("[go-host] discovered %s %s manifest %s instances %d\n", p.PluginID, p.Version, p.ManifestHash, len(p.Instances))
			break
		}
		select {
		case <-ctx.Done():
			fmt.Println("[go-host] ts-echo never announced; is live-nats.mts running?")
			os.Exit(1)
		case err := <-served:
			log.Fatalf("serve ended early: %v", err)
		case <-time.After(100 * time.Millisecond):
		}
	}
	opts := transport.CallOptions{Timeout: 5 * time.Second}
	health, err := client.Call(ctx, "ts-echo", transport.MethodHealth, map[string]any{}, opts)
	fmt.Printf("[go-host] Health → %s %v\n", health, err)
	exec := map[string]any{
		"protocol": "landflow.plugin/v1", "executionId": "live-1", "mode": "manual",
		"node": map[string]any{"id": "n1", "name": "echo", "type": "ts-echo.echo", "typeVersion": 1}, "parameters": map[string]any{},
		"itemParameters": []any{map[string]any{}}, "inputs": []any{[]any{map[string]any{"json": map[string]any{"from": "go", "secret": "s3"}}}},
		"credentials": map[string]any{"api": map[string]any{"token": "go-token"}},
	}
	reply, err := client.Invoke(ctx, "ts-echo", transport.MethodExecute, exec, transport.CallOptions{Timeout: 5 * time.Second, Delivery: transport.AtLeastOnce})
	fmt.Printf("[go-host] Execute → %s (instance %s, %s) %v\n", reply.Body, reply.InstanceID, reply.Elapsed, err)
	_, err = client.Call(ctx, "ts-echo", transport.MethodExecute, map[string]any{"node": map[string]any{"type": "ts-echo.nope"}, "inputs": []any{}}, opts)
	fmt.Printf("[go-host] Execute unknown node → %v\n", err)
	_, err = client.Call(ctx, "ts-echo", transport.MethodHealth, map[string]any{}, transport.CallOptions{Timeout: 5 * time.Second, ManifestHash: "deadbeefdeadbeef"})
	fmt.Printf("[go-host] Health with a stale manifest hash → %v\n", err)
	out, _ := json.Marshal(map[string]any{"ok": true})
	fmt.Printf("[go-host] done %s; serving live-go until the TS side finishes or %ds pass\n", out, seconds)
	<-ctx.Done()
	if err := <-served; err != nil {
		log.Fatal(err)
	}
}
