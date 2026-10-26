// Package conformance is the plugin every conformance runner embeds (packages/protocol/conformance/README.md "The
// conformance plugin"), in Go: nodes with fixed behaviour so the kit's fixtures can predict replies, plus Hooks the
// runners read (executions per node, the abort flags of sleeps, the counters, the delivery modes seen).
//
// The SDK's conformance_test.go runs the kit over every face with it; cmd/landflow-conformance-plugin serves it as
// a process for live checks.
package conformance

import (
	"context"
	"strings"
	"sync"
	"time"

	landflow "github.com/landflow/landflow/sdks/go"
)

// PluginID is the id of the conformance plugin (its manifest is packages/protocol/conformance/plugin-manifest.json).
const PluginID = "landflow-conformance"

// Hooks is what the runners observe about node runs.
type Hooks struct {
	mu         sync.Mutex
	executions int
	byNode     map[string]int
	sleeps     []*SleepRecord
	counters   map[string]int
	deliveries []landflow.DeliveryInfo
}

// SleepRecord is one run of the sleep node: did its context end before the sleep did?
type SleepRecord struct {
	mu      sync.Mutex
	aborted bool
}

// Aborted reports whether the sleep saw its context end.
func (r *SleepRecord) Aborted() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.aborted
}

// Default is the hook set the package-level plugin records into.
var Default = &Hooks{byNode: map[string]int{}, counters: map[string]int{}}

func (h *Hooks) ran(ctx context.Context, node string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.executions++
	h.byNode[node]++
	if info, ok := landflow.DeliveryOf(ctx); ok {
		h.deliveries = append(h.deliveries, info)
	}
}

// Reset clears everything.
func (h *Hooks) Reset() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.executions = 0
	h.byNode = map[string]int{}
	h.sleeps = nil
	h.counters = map[string]int{}
	h.deliveries = nil
}

// Executions is the number of node runs since Reset (every node).
func (h *Hooks) Executions() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.executions
}

// RunsOf is the number of runs of one node since Reset.
func (h *Hooks) RunsOf(node string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.byNode[node]
}

// LastSleep is the most recent sleep run, or nil.
func (h *Hooks) LastSleep() *SleepRecord {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.sleeps) == 0 {
		return nil
	}
	return h.sleeps[len(h.sleeps)-1]
}

// LastDelivery is the delivery info of the most recent brokered node run, if any.
func (h *Hooks) LastDelivery() (landflow.DeliveryInfo, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.deliveries) == 0 {
		return landflow.DeliveryInfo{}, false
	}
	return h.deliveries[len(h.deliveries)-1], true
}

func ports() ([]landflow.PortDescriptor, []landflow.PortDescriptor) {
	return []landflow.PortDescriptor{landflow.MainPort()}, []landflow.PortDescriptor{landflow.MainPort()}
}

type echoNode struct{ h *Hooks }

func (echoNode) Description() landflow.NodeDescriptor {
	in, out := ports()
	return landflow.NodeDescriptor{
		Name: "echo", DisplayName: "Echo", Description: "Emit each input item with the message added as `echo`; without items, one item { echo }.",
		Version: landflow.V(1), Kind: landflow.KindAction, UsableAsTool: true, Idempotent: true, Inputs: in, Outputs: out,
		OutputSchema: map[string]any{"type": "object", "properties": map[string]any{"echo": map[string]any{"type": "string"}}, "required": []any{"echo"}},
		Properties:   []landflow.PropertyDescriptor{{Name: "message", DisplayName: "Message", Type: landflow.PropString, Default: "", Description: "Copied into `echo` on every item."}},
	}
}

func (n echoNode) Execute(ctx *landflow.ExecuteContext) ([][]landflow.Item, error) {
	n.h.ran(ctx.Context(), "echo")
	message := ctx.ParamString("message", 0, "")
	items := ctx.InputData(0)
	if len(items) == 0 {
		return [][]landflow.Item{{{JSON: map[string]any{"echo": message}}}}, nil
	}
	out := make([]landflow.Item, 0, len(items))
	for _, item := range items {
		next := map[string]any{}
		for k, v := range item.JSON {
			next[k] = v
		}
		next["echo"] = message
		out = append(out, landflow.Item{JSON: next})
	}
	return [][]landflow.Item{out}, nil
}

type sleepNode struct{ h *Hooks }

func (sleepNode) Description() landflow.NodeDescriptor {
	in, out := ports()
	return landflow.NodeDescriptor{
		Name: "sleep", DisplayName: "Sleep", Description: "Wait `ms` milliseconds while watching the abort signal, then emit { sleptMs }. Aborted: fail at once with `canceled`.",
		Version: landflow.V(1), Kind: landflow.KindAction, UsableAsTool: true, Inputs: in, Outputs: out,
		Properties: []landflow.PropertyDescriptor{{Name: "ms", DisplayName: "Milliseconds", Type: landflow.PropNumber, Default: 100, TypeOptions: &landflow.TypeOptions{MinValue: landflow.Ptr(0.0), NumberPrecision: landflow.Ptr(0)}}},
	}
}

func (n sleepNode) Execute(ctx *landflow.ExecuteContext) ([][]landflow.Item, error) {
	n.h.ran(ctx.Context(), "sleep")
	record := &SleepRecord{}
	n.h.mu.Lock()
	n.h.sleeps = append(n.h.sleeps, record)
	n.h.mu.Unlock()
	ms := ctx.ParamInt("ms", 0, 100)
	select {
	case <-time.After(time.Duration(ms) * time.Millisecond):
		return [][]landflow.Item{{{JSON: map[string]any{"sleptMs": ms}}}}, nil
	case <-ctx.Context().Done():
		record.mu.Lock()
		record.aborted = true
		record.mu.Unlock()
		return nil, landflow.NewNodeError("canceled")
	}
}

type failNode struct{ h *Hooks }

func (failNode) Description() landflow.NodeDescriptor {
	in, out := ports()
	return landflow.NodeDescriptor{
		Name: "fail", DisplayName: "Fail", Description: "Fail with the given message (and item index), no outputs.",
		Version: landflow.V(1), Kind: landflow.KindAction, UsableAsTool: true, Inputs: in, Outputs: out,
		Properties: []landflow.PropertyDescriptor{
			{Name: "message", DisplayName: "Message", Type: landflow.PropString, Default: "boom", Required: true},
			{Name: "itemIndex", DisplayName: "Item index", Type: landflow.PropNumber, Default: -1, Description: "-1: not item-specific.", TypeOptions: &landflow.TypeOptions{NumberPrecision: landflow.Ptr(0)}},
		},
	}
}

func (n failNode) Execute(ctx *landflow.ExecuteContext) ([][]landflow.Item, error) {
	n.h.ran(ctx.Context(), "fail")
	message := ctx.ParamString("message", 0, "boom")
	if index := ctx.ParamInt("itemIndex", 0, -1); index >= 0 {
		return nil, landflow.ItemError(index, "%s", message)
	}
	return nil, landflow.NewNodeError("%s", message)
}

type payloadNode struct{ h *Hooks }

func (payloadNode) Description() landflow.NodeDescriptor {
	in, out := ports()
	return landflow.NodeDescriptor{
		Name: "payload", DisplayName: "Payload", Description: "Emit one item { data } where data is `bytes` characters long.",
		Version: landflow.V(1), Kind: landflow.KindAction, UsableAsTool: true, Idempotent: true, Inputs: in, Outputs: out,
		Properties: []landflow.PropertyDescriptor{{Name: "bytes", DisplayName: "Bytes", Type: landflow.PropNumber, Default: 1024, TypeOptions: &landflow.TypeOptions{MinValue: landflow.Ptr(0.0), NumberPrecision: landflow.Ptr(0)}}},
	}
}

func (n payloadNode) Execute(ctx *landflow.ExecuteContext) ([][]landflow.Item, error) {
	n.h.ran(ctx.Context(), "payload")
	return [][]landflow.Item{{{JSON: map[string]any{"data": strings.Repeat("x", ctx.ParamInt("bytes", 0, 1024))}}}}, nil
}

type counterNode struct{ h *Hooks }

func (counterNode) Description() landflow.NodeDescriptor {
	in, out := ports()
	return landflow.NodeDescriptor{
		Name: "counter", DisplayName: "Counter", Description: "Increment an in-process counter for `key` and emit { key, count }.",
		Version: landflow.V(1), Kind: landflow.KindAction, UsableAsTool: true, Inputs: in, Outputs: out,
		Properties: []landflow.PropertyDescriptor{{Name: "key", DisplayName: "Key", Type: landflow.PropString, Default: "default", Required: true}},
	}
}

func (n counterNode) Execute(ctx *landflow.ExecuteContext) ([][]landflow.Item, error) {
	n.h.ran(ctx.Context(), "counter")
	key := ctx.ParamString("key", 0, "default")
	n.h.mu.Lock()
	n.h.counters[key]++
	count := n.h.counters[key]
	n.h.mu.Unlock()
	return [][]landflow.Item{{{JSON: map[string]any{"key": key, "count": count}}}}, nil
}

type tickNode struct{}

func (tickNode) Description() landflow.NodeDescriptor {
	_, out := ports()
	return landflow.NodeDescriptor{
		Name: "tick", DisplayName: "Tick", Description: "A manual trigger; exists so the MCP mapping has a trigger to leave out.",
		Version: landflow.V(1), Kind: landflow.KindTrigger, TriggerSource: landflow.TriggerManual, Inputs: []landflow.PortDescriptor{}, Outputs: out, Properties: []landflow.PropertyDescriptor{},
	}
}

func (tickNode) Execute(*landflow.ExecuteContext) ([][]landflow.Item, error) {
	return [][]landflow.Item{{}}, nil
}

type hiddenNode struct{ h *Hooks }

func (hiddenNode) Description() landflow.NodeDescriptor {
	in, out := ports()
	return landflow.NodeDescriptor{
		Name: "hidden", DisplayName: "Hidden", Description: "An action node opted out of MCP (mcp: false).",
		Version: landflow.V(1), Kind: landflow.KindAction, UsableAsTool: true, MCP: landflow.Ptr(false), Inputs: in, Outputs: out,
		Properties: []landflow.PropertyDescriptor{{Name: "field", DisplayName: "Field", Type: landflow.PropString, Default: ""}},
	}
}

func (n hiddenNode) Execute(ctx *landflow.ExecuteContext) ([][]landflow.Item, error) {
	n.h.ran(ctx.Context(), "hidden")
	return [][]landflow.Item{{{JSON: map[string]any{"field": ctx.ParamString("field", 0, "")}}}}, nil
}

// New builds the conformance plugin recording into hooks (nil = Default).
func New(hooks *Hooks) *landflow.Plugin {
	if hooks == nil {
		hooks = Default
	}
	info := landflow.PluginInfo{
		ID: PluginID, Name: "Conformance", Version: "1.0.0", Icon: "lucide:check-check", Color: "#0ea5e9",
		Description: "The plugin every conformance runner embeds: fixed behaviour so fixtures can predict replies.",
		CredentialTypes: []landflow.CredentialType{{
			Name: "conformanceApi", DisplayName: "Conformance API",
			Properties: []landflow.PropertyDescriptor{{Name: "token", DisplayName: "Token", Type: landflow.PropString, Required: true, TypeOptions: &landflow.TypeOptions{Password: true}}},
			Test: func(ctx context.Context, data landflow.CredentialData) (bool, string) {
				if data["token"] == "t" {
					return true, "ok"
				}
				return false, "bad token"
			},
		}},
	}
	return landflow.NewPlugin(info, echoNode{hooks}, sleepNode{hooks}, failNode{hooks}, payloadNode{hooks}, counterNode{hooks}, tickNode{}, hiddenNode{hooks})
}
