package landflow

import (
	"context"
	"errors"
	"testing"
)

func TestParamResolutionOrder(t *testing.T) {
	d := upperNode{}.Description()
	req := &ExecuteRequest{
		Parameters: map[string]any{"field": "fromParams", "suffix": "!", "nullish": nil},
		ItemParameters: []map[string]any{
			{"field": "fromItem0"},
			{"suffix": nil}, // null falls through to parameters
		},
	}
	ctx := NewExecuteContext(context.Background(), req, &d)

	cases := []struct {
		name string
		item int
		want any
	}{
		{"field", 0, "fromItem0"},  // itemParameters wins
		{"field", 1, "fromParams"}, // missing in item 1 → parameters
		{"field", 5, "fromParams"}, // item out of range → parameters
		{"suffix", 1, "!"},         // null in item → parameters
		{"mode", 0, "upper"},       // descriptor default
		{"nope", 0, nil},           // nothing
		{"nullish", 0, nil},        // null everywhere → unset
	}
	for _, c := range cases {
		if got := ctx.Param(c.name, c.item); got != c.want {
			t.Errorf("Param(%q, %d) = %#v, want %#v", c.name, c.item, got, c.want)
		}
	}
	if got := ctx.ParamString("nope", 0, "callerDefault"); got != "callerDefault" {
		t.Errorf("caller default not used: %q", got)
	}
	if got := ctx.ParamString("mode", 0, "callerDefault"); got != "upper" {
		t.Errorf("descriptor default should beat caller default, got %q", got)
	}
	if ctx.HasParam("nope", 0) || !ctx.HasParam("mode", 0) {
		t.Error("HasParam mismatch")
	}
}

func TestTypedParams(t *testing.T) {
	d := NodeDescriptor{Properties: []PropertyDescriptor{
		{Name: "count", Type: PropNumber, Default: 3},
		{Name: "enabled", Type: PropBoolean, Default: true},
	}}
	req := &ExecuteRequest{Parameters: map[string]any{
		"f": 2.75, "s": "42", "sf": " 1.5 ", "b": true, "bs": "false", "bn": 0.0,
		"bad": "abc", "obj": map[string]any{"a": 1.0}, "big": 1e21,
	}}
	ctx := NewExecuteContext(context.Background(), req, &d)

	if got := ctx.ParamInt("f", 0, -1); got != 2 {
		t.Errorf("ParamInt(f) = %d", got)
	}
	if got := ctx.ParamInt("s", 0, -1); got != 42 {
		t.Errorf("ParamInt(s) = %d", got)
	}
	if got := ctx.ParamInt("bad", 0, -1); got != -1 {
		t.Errorf("ParamInt(bad) = %d, want default", got)
	}
	if got := ctx.ParamInt("count", 0, -1); got != 3 {
		t.Errorf("ParamInt(count) from descriptor default = %d", got)
	}
	if got := ctx.ParamInt("missing", 0, 9); got != 9 {
		t.Errorf("ParamInt(missing) = %d", got)
	}
	if got := ctx.ParamFloat("sf", 0, 0); got != 1.5 {
		t.Errorf("ParamFloat(sf) = %v", got)
	}
	if got := ctx.ParamFloat("f", 0, 0); got != 2.75 {
		t.Errorf("ParamFloat(f) = %v", got)
	}
	if !ctx.ParamBool("b", 0, false) || ctx.ParamBool("bs", 0, true) || ctx.ParamBool("bn", 0, true) {
		t.Error("ParamBool conversions wrong")
	}
	if !ctx.ParamBool("enabled", 0, false) {
		t.Error("ParamBool descriptor default not used")
	}
	if !ctx.ParamBool("bad", 0, true) {
		t.Error("ParamBool(bad) should return caller default")
	}
	if got := ctx.ParamString("f", 0, ""); got != "2.75" {
		t.Errorf("ParamString(f) = %q", got)
	}
	if got := ctx.ParamString("big", 0, ""); got != "1000000000000000000000" {
		t.Errorf("ParamString(big) = %q", got)
	}
	if got := ctx.ParamString("obj", 0, ""); got != `{"a":1}` {
		t.Errorf("ParamString(obj) = %q", got)
	}
}

func TestParamDefaultHonoursDisplayOptions(t *testing.T) {
	// Two properties share a name; the visible one supplies the default.
	d := NodeDescriptor{Properties: []PropertyDescriptor{
		{Name: "op", Type: PropOptions, Default: "a", Options: []PropertyOption{{Name: "A", Value: "a"}, {Name: "B", Value: "b"}}},
		{Name: "size", Type: PropNumber, Default: 1, DisplayOptions: &DisplayOptions{Show: map[string][]any{"op": {"a"}}}},
		{Name: "size", Type: PropNumber, Default: 2, DisplayOptions: &DisplayOptions{Show: map[string][]any{"op": {"b"}}}},
	}}
	ctxA := NewExecuteContext(context.Background(), &ExecuteRequest{}, &d)
	if got := ctxA.ParamInt("size", 0, 0); got != 1 {
		t.Errorf("op=a size default = %d, want 1", got)
	}
	ctxB := NewExecuteContext(context.Background(), &ExecuteRequest{ItemParameters: []map[string]any{{"op": "b"}}}, &d)
	if got := ctxB.ParamInt("size", 0, 0); got != 2 {
		t.Errorf("op=b size default = %d, want 2", got)
	}
}

func TestContinueOnFailAndErrorItem(t *testing.T) {
	req := execReq("test-plugin.upper", map[string]any{}, map[string]any{"value": "x"})
	req.ContinueOnFail = true
	req.Credentials = map[string]any{"token": "s3cret-token"}
	ctx := NewExecuteContext(context.Background(), req, nil)
	if !ctx.ContinueOnFail() {
		t.Fatal("ContinueOnFail() = false")
	}
	item := ctx.ErrorItem(2, ItemError(2, "bad call").WithDescription("details"))
	if item.JSON["error"] != "bad call" || item.JSON["description"] != "details" || item.PairedItem == nil || item.PairedItem.Item != 2 {
		t.Errorf("ErrorItem = %+v", item)
	}
	if plain := ctx.ErrorItem(0, errors.New("boom")); plain.JSON["error"] != "boom" || plain.JSON["description"] != nil {
		t.Errorf("ErrorItem(plain) = %+v", plain)
	}
}

func TestContextAccessors(t *testing.T) {
	req := execReq("test-plugin.upper", map[string]any{}, map[string]any{"value": "x"})
	req.Credentials = map[string]any{"token": "t"}
	ctx := NewExecuteContext(context.Background(), req, nil)
	if ctx.ExecutionID() != "ex_1" || ctx.WorkflowID() != "wf_1" || ctx.Mode() != ModeManual {
		t.Error("ids/mode mismatch")
	}
	if ctx.Node().Type != "test-plugin.upper" || ctx.Credentials()["token"] != "t" {
		t.Error("node/credentials mismatch")
	}
	if len(ctx.InputData(0)) != 1 || ctx.InputData(1) != nil || ctx.InputData(-1) != nil {
		t.Error("InputData mismatch")
	}
	ctx.Logger.Debug("d")
	ctx.Logger.Warn("w %d", 1)
	ctx.Logger.Error("100%")
	got := ctx.Logger.Entries()
	if len(got) != 3 || got[1] != (LogEntry{Level: LevelWarn, Message: "w 1"}) || got[2].Message != "100%" {
		t.Errorf("logs = %#v", got)
	}
}
