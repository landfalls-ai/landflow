package kit

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	landflow "github.com/landflow/landflow/sdks/go"
)

// Hooks is what a runner observes about node runs (packages/sdk/test/conformance-plugin.ts `hooks`): in-process
// for the Go plugin, over a side HTTP endpoint for the Python one.
type Hooks interface {
	Reset()
	Executions() int
	ByNode(name string) int
	// LastSleepAborted reports whether the last sleep run saw its cancellation (ok false: no sleep ran).
	LastSleepAborted() (aborted, ok bool)
}

// MemoryHooks is the in-process Hooks of the Go conformance plugin.
type MemoryHooks struct {
	mu         sync.Mutex
	executions int
	byNode     map[string]int
	sleeps     []*sleepRecord
	counters   map[string]int
}

type sleepRecord struct{ aborted bool }

func newMemoryHooks() *MemoryHooks {
	return &MemoryHooks{byNode: map[string]int{}, counters: map[string]int{}}
}

func (h *MemoryHooks) ran(node string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.executions++
	h.byNode[node]++
}

// Reset clears every count.
func (h *MemoryHooks) Reset() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.executions, h.byNode, h.sleeps, h.counters = 0, map[string]int{}, nil, map[string]int{}
}

// Executions is the number of node runs since Reset.
func (h *MemoryHooks) Executions() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.executions
}

// ByNode is the number of runs of one node since Reset.
func (h *MemoryHooks) ByNode(name string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.byNode[name]
}

// LastSleepAborted reports the last sleep's abort flag.
func (h *MemoryHooks) LastSleepAborted() (bool, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.sleeps) == 0 {
		return false, false
	}
	return h.sleeps[len(h.sleeps)-1].aborted, true
}

// GoPlugin is the conformance plugin built with the Go SDK, with no broker code of its own.
type GoPlugin struct {
	Plugin *landflow.Plugin
	Hooks  *MemoryHooks
}

// NewGoPlugin builds the conformance plugin from plugin-manifest.json's descriptors.
func NewGoPlugin() (*GoPlugin, error) {
	raw, err := LoadPluginManifest()
	if err != nil {
		return nil, err
	}
	var manifest struct {
		Plugin landflow.PluginInfo       `json:"plugin"`
		Nodes  []landflow.NodeDescriptor `json:"nodes"`
	}
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return nil, fmt.Errorf("plugin-manifest.json: %w", err)
	}
	hooks := newMemoryHooks()
	var nodes []landflow.Node
	for _, d := range manifest.Nodes {
		d := d
		nodes = append(nodes, &conformanceNode{descriptor: d, hooks: hooks})
	}
	info := landflow.PluginInfo{
		ID: PluginID, Name: manifest.Plugin.Name, Version: manifest.Plugin.Version, Description: manifest.Plugin.Description,
		CredentialTypes: []landflow.CredentialType{{
			Name: "conformanceApi", DisplayName: "Conformance API",
			Properties: []landflow.PropertyDescriptor{{Name: "token", DisplayName: "Token", Type: "string", Required: true, TypeOptions: &landflow.TypeOptions{Password: true}}},
			Test: func(_ context.Context, data landflow.CredentialData) (bool, string) {
				if data["token"] == "t" {
					return true, "ok"
				}
				return false, "bad token"
			},
		}},
	}
	plugin, err := landflow.BuildPlugin(info, nodes...)
	if err != nil {
		return nil, err
	}
	return &GoPlugin{Plugin: plugin, Hooks: hooks}, nil
}

type conformanceNode struct {
	descriptor landflow.NodeDescriptor
	hooks      *MemoryHooks
}

func (n *conformanceNode) Description() landflow.NodeDescriptor { return n.descriptor }

func (n *conformanceNode) Execute(ctx *landflow.ExecuteContext) ([][]landflow.Item, error) {
	h := n.hooks
	switch n.descriptor.Name {
	case "echo":
		h.ran("echo")
		message := ctx.ParamString("message", 0, "")
		items := ctx.InputData(0)
		if len(items) == 0 {
			return [][]landflow.Item{{{JSON: map[string]any{"echo": message}}}}, nil
		}
		out := make([]landflow.Item, 0, len(items))
		for _, item := range items {
			j := map[string]any{}
			for k, v := range item.JSON {
				j[k] = v
			}
			j["echo"] = message
			out = append(out, landflow.Item{JSON: j})
		}
		return [][]landflow.Item{out}, nil
	case "sleep":
		h.ran("sleep")
		record := &sleepRecord{}
		h.mu.Lock()
		h.sleeps = append(h.sleeps, record)
		h.mu.Unlock()
		ms := ctx.ParamInt("ms", 0, 100)
		select {
		case <-time.After(time.Duration(ms) * time.Millisecond):
			return [][]landflow.Item{{{JSON: map[string]any{"sleptMs": ms}}}}, nil
		case <-ctx.Done():
			h.mu.Lock()
			record.aborted = true
			h.mu.Unlock()
			return nil, landflow.NewNodeError("canceled")
		}
	case "fail":
		h.ran("fail")
		idx := ctx.ParamInt("itemIndex", 0, -1)
		msg := ctx.ParamString("message", 0, "boom")
		if idx >= 0 {
			return nil, landflow.ItemError(idx, "%s", msg)
		}
		return nil, landflow.NewNodeError("%s", msg)
	case "payload":
		h.ran("payload")
		return [][]landflow.Item{{{JSON: map[string]any{"data": strings.Repeat("x", ctx.ParamInt("bytes", 0, 1024))}}}}, nil
	case "counter":
		h.ran("counter")
		key := ctx.ParamString("key", 0, "default")
		h.mu.Lock()
		h.counters[key]++
		count := h.counters[key]
		h.mu.Unlock()
		return [][]landflow.Item{{{JSON: map[string]any{"key": key, "count": count}}}}, nil
	case "hidden":
		h.ran("hidden")
		return [][]landflow.Item{{{JSON: map[string]any{"field": ctx.ParamString("field", 0, "")}}}}, nil
	default:
		return [][]landflow.Item{{}}, nil
	}
}

// ServeGoPlugin serves the Go conformance plugin over HTTP and gRPC on 127.0.0.1 (announce off, maxConcurrency 4,
// like the TS runner) until stop is called.
func ServeGoPlugin(ctx context.Context, httpPort, grpcPort int) (*GoPlugin, func(), error) {
	gp, err := NewGoPlugin()
	if err != nil {
		return nil, nil, err
	}
	ctx, cancel := context.WithCancel(ctx)
	done := make(chan error, 1)
	announce := false
	go func() {
		done <- landflow.Serve(ctx, gp.Plugin, landflow.ServeOptions{
			HTTPPort: httpPort, GRPCPort: grpcPort, ListenHost: "127.0.0.1", AdvertiseHost: "127.0.0.1", Announce: &announce,
			MaxConcurrency: 4, Telemetry: landflow.TelemetryOptions{Disabled: &announce, LogWriter: discard{}},
		})
	}()
	if err := WaitHealthy(ctx, fmt.Sprintf("http://127.0.0.1:%d", httpPort), 15*time.Second); err != nil {
		cancel()
		return nil, nil, err
	}
	stop := func() {
		cancel()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
		}
	}
	return gp, stop, nil
}

type discard struct{}

func (discard) Write(p []byte) (int, error) { return len(p), nil }

// WaitHealthy polls GET <base>/landflow/v1/health until it answers 200.
func WaitHealthy(ctx context.Context, base string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	client := &http.Client{Timeout: time.Second}
	for {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, base+landflow.PathHealth, nil)
		resp, err := client.Do(req)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return nil
			}
		}
		if time.Now().After(deadline) {
			if err == nil {
				err = errors.New("health did not answer 200")
			}
			return fmt.Errorf("%s not healthy after %s: %w", base, timeout, err)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}
