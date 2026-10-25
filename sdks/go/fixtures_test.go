package landflow

import (
	"errors"
	"fmt"
	"strings"
)

// upperNode upper-cases a field; exercises params, logs and pairedItem filling.
type upperNode struct{}

func (upperNode) Description() NodeDescriptor {
	return NodeDescriptor{
		Name: "upper", DisplayName: "Upper", Description: "Upper-case a field",
		Version: V(1), Kind: KindAction,
		Inputs: []PortDescriptor{MainPort()}, Outputs: []PortDescriptor{MainPort()},
		Properties: []PropertyDescriptor{
			{Name: "field", DisplayName: "Field", Type: PropString, Default: "value"},
			{Name: "suffix", DisplayName: "Suffix", Type: PropString, Default: ""},
			{Name: "mode", DisplayName: "Mode", Type: PropOptions, Default: "upper",
				Options:     []PropertyOption{{Name: "Upper", Value: "upper"}, {Name: "Lower", Value: "lower"}},
				TypeOptions: &TypeOptions{LoadOptionsMethod: "modes"}},
		},
	}
}

func (upperNode) Execute(ctx *ExecuteContext) ([][]Item, error) {
	in := ctx.InputData(0)
	out := make([]Item, 0, len(in))
	for i, item := range in {
		field := ctx.ParamString("field", i, "value")
		v, ok := item.JSON[field].(string)
		if !ok {
			return nil, ItemError(i, "field %q is not a string", field).WithDescription("check the input")
		}
		if ctx.ParamString("mode", i, "upper") == "lower" {
			v = strings.ToLower(v)
		} else {
			v = strings.ToUpper(v)
		}
		next := map[string]any{}
		for k, val := range item.JSON {
			next[k] = val
		}
		next[field] = v + ctx.ParamString("suffix", i, "")
		out = append(out, Item{JSON: next})
	}
	ctx.Logger.Info("processed %d item(s)", len(in))
	return [][]Item{out}, nil
}

func (upperNode) LoadOptions(method string, params map[string]any) ([]PropertyOption, error) {
	if method != "modes" {
		return nil, fmt.Errorf("unknown method %q", method)
	}
	return []PropertyOption{{Name: "Upper", Value: "upper"}, {Name: "Lower", Value: "lower"}}, nil
}

// behaviourNode fails in configurable ways.
type behaviourNode struct{}

func (behaviourNode) Description() NodeDescriptor {
	return NodeDescriptor{
		Name: "behave", DisplayName: "Behave", Description: "Test failure modes", Version: V(1, 2),
		Properties: []PropertyDescriptor{
			{Name: "do", DisplayName: "Do", Type: PropString, Default: "ok"},
			{Name: "flag", DisplayName: "Flag", Type: PropBoolean, Default: false},
		},
	}
}

func (behaviourNode) Execute(ctx *ExecuteContext) ([][]Item, error) {
	switch ctx.ParamString("do", 0, "ok") {
	case "panic":
		panic("boom")
	case "plain":
		return nil, errors.New("plain failure")
	case "nodeErrorValue":
		return nil, NodeError{Message: "by value"}
	case "wrapped":
		return nil, fmt.Errorf("context: %w", ItemError(2, "wrapped node error"))
	case "nil":
		return nil, nil
	case "generate":
		return [][]Item{{{JSON: map[string]any{"n": 1}}, {JSON: map[string]any{"n": 2}}, {JSON: nil}}}, nil
	case "explicitPair":
		return [][]Item{{{JSON: map[string]any{"a": 1}, PairedItem: &PairedItem{Item: 7}}, {JSON: map[string]any{"b": 2}}}}, nil
	}
	return [][]Item{ctx.InputData(0)}, nil
}

func testPlugin() *Plugin {
	return NewPlugin(PluginInfo{ID: "test-plugin", Name: "Test Plugin", Version: "1.2.3"}, upperNode{}, behaviourNode{})
}

func execReq(nodeType string, params map[string]any, items ...map[string]any) *ExecuteRequest {
	req := &ExecuteRequest{
		Protocol: ProtocolVersion, ExecutionID: "ex_1", WorkflowID: "wf_1", Mode: ModeManual,
		Node:       NodeRef{ID: "n1", Name: "Node", Type: nodeType, TypeVersion: 1},
		Parameters: params, Inputs: [][]Item{{}},
	}
	for _, it := range items {
		req.Inputs[0] = append(req.Inputs[0], Item{JSON: it})
		req.ItemParameters = append(req.ItemParameters, params)
	}
	return req
}
