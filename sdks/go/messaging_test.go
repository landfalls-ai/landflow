package landflow

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/landflow/landflow/sdks/go/transport"
	"github.com/landflow/landflow/sdks/go/transport/memory"
)

// deliveryNode echoes what DeliveryOf says about the current call.
type deliveryNode struct{}

func (deliveryNode) Description() NodeDescriptor {
	return NodeDescriptor{Name: "delivery", DisplayName: "Delivery", Description: "echo delivery info", Version: V(1), Kind: KindAction,
		Inputs: []PortDescriptor{MainPort()}, Outputs: []PortDescriptor{MainPort()}, Properties: []PropertyDescriptor{}, Idempotent: true}
}

func (deliveryNode) Execute(ctx *ExecuteContext) ([][]Item, error) {
	info, ok := DeliveryOf(ctx.Context())
	return [][]Item{{{JSON: map[string]any{"ok": ok, "transport": info.Transport, "attempt": info.Attempt, "mode": string(info.Mode), "callId": info.CallID, "viaCtx": TransportOf(ctx.Context())}}}}, nil
}

func messagingPlugin() *Plugin {
	return NewPlugin(PluginInfo{ID: "msg-plugin", Name: "Messaging <&> Plugin", Version: "1.2.3"}, upperNode{}, behaviourNode{}, deliveryNode{})
}

func brokerEnv(t *testing.T) {
	clearEnv(t)
	t.Setenv("LANDFLOW_TRANSPORT_SECRET", "sdk-test-transport-secret")
	t.Setenv("LANDFLOW_TRANSPORT_SECRET_PREVIOUS", "")
	t.Setenv("LANDFLOW_REGISTRY_SECRET", "")
	t.Setenv("LANDFLOW_TRANSPORT_PREFIX", "")
}

func startClient(t *testing.T, broker *memory.Broker, cfg transport.Config) *transport.Client {
	t.Helper()
	client, err := transport.StartClient(context.Background(), transport.ClientOptions{Driver: broker.Driver(cfg), Keyring: transport.MustKeyring("sdk-test-transport-secret"), NoRegistryProof: true, StatsInterval: -1, Log: transport.SilentLogger})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return client
}

func waitAnnounced(t *testing.T, client *transport.Client, pluginID string) transport.AnnouncedPlugin {
	t.Helper()
	var plugin transport.AnnouncedPlugin
	waitFor(t, "announce of "+pluginID, func() bool {
		p, ok := client.Plugin(pluginID)
		plugin = p
		return ok && len(p.Instances) == 1
	})
	return plugin
}

func TestBrokerBindingServesOverMemory(t *testing.T) {
	brokerEnv(t)
	broker := memory.NewBroker(memory.Options{})
	cfg := transport.Config{ConnectionID: "mem-main", Prefix: "sdk" + InstanceID()[:6]}
	p := messagingPlugin()
	logs := &syncBuffer{}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	binding := NewBrokerBinding(broker.Driver(cfg))
	binding.AnnounceInterval = 200 * time.Millisecond
	go func() {
		done <- Serve(ctx, p, WithBinding(binding), WithMaxConcurrency(2), WithRegistryURL("off"), WithLogger(log.New(logs, "", 0)))
	}()
	client := startClient(t, broker, cfg)
	announced := waitAnnounced(t, client, "msg-plugin")
	if announced.Endpoint != "memory://mem-main/msg-plugin" || announced.Version != "1.2.3" || announced.Instances[0].InstanceID != InstanceID() || announced.Instances[0].MaxConcurrency != 2 {
		t.Fatalf("announce %+v", announced)
	}
	if strings.Join(announced.Instances[0].Transports, ",") != "memory" || binding.Endpoint() != announced.Endpoint {
		t.Fatalf("hints %v endpoint %s", announced.Instances[0].Transports, binding.Endpoint())
	}
	callOpts := transport.CallOptions{Timeout: 3 * time.Second}

	// Execute through the shared dispatcher, with the node's output intact.
	var exec ExecuteResponse
	if err := client.CallInto(ctx, "msg-plugin", transport.MethodExecute, execReq("msg-plugin.upper", map[string]any{}, map[string]any{"value": "hi"}), callOpts, &exec); err != nil {
		t.Fatal(err)
	}
	if exec.Error != nil || exec.Outputs[0][0].JSON["value"] != "HI" {
		t.Fatalf("execute: %+v", exec)
	}
	// Delivery info reaches the node; at least once for the idempotent node when asked.
	if err := client.CallInto(ctx, "msg-plugin", transport.MethodExecute, execReq("msg-plugin.delivery", map[string]any{}, map[string]any{}), transport.CallOptions{Timeout: 3 * time.Second, Delivery: transport.AtLeastOnce}, &exec); err != nil {
		t.Fatal(err)
	}
	got := exec.Outputs[0][0].JSON
	if got["ok"] != true || got["transport"] != "memory" || got["mode"] != "at-least-once" || got["attempt"] != float64(1) || got["viaCtx"] != "memory" || got["callId"] == "" {
		t.Fatalf("delivery info %v", got)
	}
	// A node failure is a normal response; dispatcher errors become remote codes.
	if err := client.CallInto(ctx, "msg-plugin", transport.MethodExecute, execReq("msg-plugin.behave", map[string]any{"do": "plain"}, map[string]any{}), callOpts, &exec); err != nil || exec.Error == nil {
		t.Fatalf("node failure: %+v %v", exec, err)
	}
	_, err := client.Call(ctx, "msg-plugin", transport.MethodExecute, execReq("msg-plugin.nope", map[string]any{}, map[string]any{}), callOpts)
	var re *transport.RemoteError
	if !errors.As(err, &re) || re.RemoteCode != transport.CodeNotFound {
		t.Fatalf("unknown node: %v", err)
	}
	_, err = client.Call(ctx, "msg-plugin", transport.MethodExecute, map[string]any{"protocol": 1}, callOpts)
	if !errors.As(err, &re) || re.RemoteCode != transport.CodeBadRequest {
		t.Fatalf("bad body: %v", err)
	}
	_, err = client.Call(ctx, "msg-plugin", transport.MethodLoadOptions, &LoadOptionsRequest{NodeType: "msg-plugin.behave", Method: "x"}, callOpts)
	if !errors.As(err, &re) || re.RemoteCode != transport.CodeNotFound {
		t.Fatalf("no options loader: %v", err)
	}
	var health HealthResponse
	if err := client.CallInto(ctx, "msg-plugin", transport.MethodHealth, map[string]any{}, callOpts, &health); err != nil || health.Status != "ok" || health.PluginID != "msg-plugin" {
		t.Fatalf("health %+v %v", health, err)
	}

	// The announced manifest hash is the hash of the manifest the plugin serves, over the broker and over HTTP.
	reply, err := client.Invoke(ctx, "msg-plugin", transport.MethodGetManifest, map[string]any{}, callOpts)
	if err != nil {
		t.Fatal(err)
	}
	brokerHash, _ := transport.ManifestHashOf(reply.Body)
	if brokerHash != announced.ManifestHash || reply.Attributes.LfManifest != announced.ManifestHash {
		t.Fatalf("hash over broker %s vs announced %s", brokerHash, announced.ManifestHash)
	}
	srv := httptest.NewServer(p.Dispatcher().Handler())
	defer srv.Close()
	resp, err := http.Get(srv.URL + PathManifest)
	if err != nil {
		t.Fatal(err)
	}
	served, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	httpHash, _ := transport.ManifestHashOf(json.RawMessage(served))
	if httpHash != announced.ManifestHash {
		t.Fatalf("hash of the HTTP manifest %s vs announced %s", httpHash, announced.ManifestHash)
	}
	if !bytes.Contains(served, []byte(`"transports":["memory"]`)) || !bytes.Contains(served, []byte(`"idempotent":true`)) {
		t.Fatalf("served manifest %s", served)
	}
	if tsHash, ok := tsManifestHash(t, served); ok && tsHash != announced.ManifestHash {
		t.Fatalf("TS manifestHash() of the served bytes %s vs announced %s", tsHash, announced.ManifestHash)
	}

	// Shutdown withdraws and the host forgets the instance.
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("serve: %v", err)
	}
	waitFor(t, "withdraw", func() bool { p, ok := client.Plugin("msg-plugin"); return ok && len(p.Instances) == 0 })
	if !strings.Contains(logs.String(), "memory binding serving memory://mem-main/msg-plugin") {
		t.Fatalf("logs:\n%s", logs.String())
	}
}

// tsManifestHash runs the TS host's manifestHash() over the served bytes (packages/transports helper), or reports !ok
// when node/tsx are not available.
func tsManifestHash(t *testing.T, served []byte) (string, bool) {
	t.Helper()
	if _, err := exec.LookPath("node"); err != nil {
		return "", false
	}
	dir, _ := os.Getwd()
	root := filepath.Dir(filepath.Dir(dir))
	tsx := filepath.Join(root, "packages", "transports", "node_modules", ".bin", "tsx")
	script := filepath.Join(dir, "transport", "testdata", "crosslang.mts")
	if _, err := os.Stat(tsx); err != nil {
		return "", false
	}
	in, _ := json.Marshal(map[string]any{"secret": "x", "pluginId": "msg-plugin", "manifest": json.RawMessage(served)})
	cmd := exec.Command(tsx, script)
	cmd.Stdin = bytes.NewReader(in)
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("tsx: %v", err)
	}
	var result struct {
		ManifestHash string `json:"manifestHash"`
	}
	if err := json.Unmarshal(out, &result); err != nil {
		t.Fatal(err)
	}
	return result.ManifestHash, true
}

func TestBrokerBindingFromEnv(t *testing.T) {
	brokerEnv(t)
	memory.ResetDefault()
	t.Cleanup(memory.ResetDefault)
	prefix := "env" + InstanceID()[:6]
	t.Setenv("LANDFLOW_TRANSPORTS", "memory")
	t.Setenv("LANDFLOW_MEMORY_URL", "memory://default")
	t.Setenv("LANDFLOW_MEMORY_PREFIX", prefix)
	t.Setenv("LANDFLOW_MEMORY_REGION", "eu-1")
	p := messagingPlugin()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- Serve(ctx, p, WithRegistryURL("off"), WithLogger(log.New(io.Discard, "", 0))) }()
	client := startClient(t, memory.Default(), transport.Config{ConnectionID: "env-memory", Prefix: prefix})
	announced := waitAnnounced(t, client, "msg-plugin")
	if announced.Endpoint != "memory://env-memory/msg-plugin" {
		t.Fatalf("endpoint %s", announced.Endpoint)
	}
	var health HealthResponse
	if err := client.CallInto(ctx, "msg-plugin", transport.MethodHealth, map[string]any{}, transport.CallOptions{Timeout: 3 * time.Second}, &health); err != nil || health.Status != "ok" {
		t.Fatalf("%+v %v", health, err)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}

	// A URL for a kind with no registered driver is a configuration error.
	t.Setenv("LANDFLOW_TRANSPORTS", "nope")
	t.Setenv("LANDFLOW_NOPE_URL", "nope://x")
	err := Serve(context.Background(), p, WithRegistryURL("off"))
	if err == nil || !strings.Contains(err.Error(), `no "nope" driver is registered`) || !strings.Contains(err.Error(), "memory") {
		t.Fatalf("got %v", err)
	}
	// No secret: the broker binding cannot start.
	t.Setenv("LANDFLOW_TRANSPORTS", "")
	t.Setenv("LANDFLOW_TRANSPORT_SECRET", "")
	err = Serve(context.Background(), p, WithBroker(memory.Default().Driver(transport.Config{})), WithRegistryURL("off"), WithLogger(log.New(io.Discard, "", 0)))
	if err == nil || !strings.Contains(err.Error(), "LANDFLOW_TRANSPORT_SECRET") {
		t.Fatalf("got %v", err)
	}
}

func TestRemoteErrorMapping(t *testing.T) {
	cases := map[error]transport.RemoteErrorCode{
		ErrOverloaded:                 transport.CodeCapacity,
		ErrUnknownNode:                transport.CodeNotFound,
		ErrNoOptionsLoader:            transport.CodeNotFound,
		ErrUnknownCredentialType:      transport.CodeNotFound,
		ErrBadRequest:                 transport.CodeBadRequest,
		context.DeadlineExceeded:      transport.CodeExpired,
		context.Canceled:              transport.CodeCancelled,
		errors.New("something broke"): transport.CodeInternal,
	}
	for in, want := range cases {
		var de *transport.DispatchError
		if err := remoteError(in); !errors.As(err, &de) || de.Code != want {
			t.Errorf("%v: got %v want %s", in, err, want)
		}
	}
	if _, ok := DeliveryOf(context.Background()); ok {
		t.Fatal("DeliveryOf must be false outside a brokered call")
	}
}
