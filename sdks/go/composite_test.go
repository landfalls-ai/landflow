package landflow

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	pb "github.com/landflow/landflow/sdks/go/landflowpb"
)

func testComposite() CompositeTypeDescriptor {
	return CompositeTypeDescriptor{
		Name: "aiTriage", DisplayName: "AI triage", Description: "Enrich, reason, decide", Version: 1,
		Inputs:  []CompositePort{{Name: "in", Slot: "enrich"}},
		Outputs: []CompositePort{{Name: "decision", Slot: "decide", Index: 1}},
		Slots: []CompositeSlot{
			{Name: "enrich", DisplayName: "Enrich", Accepts: NodeMatcher{Capability: OneOrMany{"ioc.enrich"}}, Max: IntPtr(1)},
			{Name: "decide", DisplayName: "Decide", Accepts: NodeMatcher{AnyOf: []NodeMatcher{{Type: OneOrMany{"a.b", "a.c"}}, {Kind: OneOrMany{"action"}}}}, Min: IntPtr(0)},
		},
		Rules: []CompositeRule{{Rule: "feeds", From: "enrich", To: "decide"}, {Rule: "onError", Slots: []string{"enrich"}, Value: "continue"}, {Rule: "sealed"}},
		Starter: &CompositeStarter{
			Nodes:       []CompositeStarterNode{{ID: "a", Name: "A", Type: "x.y", Position: [2]float64{0, 10}, Slot: "enrich"}, {ID: "b", Name: "B", Type: "x.z", Position: [2]float64{200, 10}}},
			Connections: []CompositeStarterConnection{{Source: "a", Target: "b"}},
		},
	}
}

func compositePlugin(c CompositeTypeDescriptor) (*Plugin, error) {
	return BuildPlugin(PluginInfo{ID: "test-plugin", Name: "Test Plugin", Version: "1.2.3", Composites: []CompositeTypeDescriptor{c}}, upperNode{})
}

func TestCompositeManifestHTTP(t *testing.T) {
	p, err := compositePlugin(testComposite())
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(p.Handler())
	defer srv.Close()
	code, m := doJSON(t, srv, "GET", PathManifest, "")
	if code != 200 {
		t.Fatalf("manifest: %d", code)
	}
	comps := m["composites"].([]any)
	if len(comps) != 1 {
		t.Fatalf("composites = %v", comps)
	}
	c := comps[0].(map[string]any)
	slots := c["slots"].([]any)
	enrich := slots[0].(map[string]any)
	if enrich["accepts"].(map[string]any)["capability"] != "ioc.enrich" || enrich["max"] != 1.0 {
		t.Errorf("enrich slot = %v", enrich)
	}
	if _, ok := enrich["min"]; ok {
		t.Errorf("unset min must be omitted: %v", enrich)
	}
	if slots[1].(map[string]any)["min"] != 0.0 {
		t.Errorf("min 0 must be kept: %v", slots[1])
	}
	anyOf := slots[1].(map[string]any)["accepts"].(map[string]any)["anyOf"].([]any)
	if _, ok := anyOf[0].(map[string]any)["type"].([]any); !ok || anyOf[1].(map[string]any)["kind"] != "action" {
		t.Errorf("anyOf = %v", anyOf)
	}
	for _, key := range []string{"icon", "color", "closed", "onError", "timeoutSeconds", "properties"} {
		if _, ok := c[key]; ok {
			t.Errorf("empty %s must be omitted", key)
		}
	}
	if c["starter"].(map[string]any)["nodes"].([]any)[0].(map[string]any)["position"].([]any)[1] != 10.0 {
		t.Errorf("starter = %v", c["starter"])
	}

	// No composites: the key is absent.
	_, plain := doJSON(t, httptest.NewServer(testPlugin().Handler()), "GET", PathManifest, "")
	if _, ok := plain["composites"]; ok {
		t.Error("composites must be omitted when none are declared")
	}
}

func TestCompositeManifestGRPC(t *testing.T) {
	p, err := compositePlugin(testComposite())
	if err != nil {
		t.Fatal(err)
	}
	client := bufconnClient(t, p)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	m, err := client.GetManifest(ctx, &pb.GetManifestRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if len(m.GetComposites()) != 1 {
		t.Fatalf("composites = %d", len(m.GetComposites()))
	}
	var c CompositeTypeDescriptor
	if err := json.Unmarshal(m.GetComposites()[0].GetJson(), &c); err != nil || c.Name != "aiTriage" || len(c.Slots) != 2 || c.Slots[0].Accepts.Capability[0] != "ioc.enrich" {
		t.Errorf("composite = %+v (%v)", c, err)
	}
}

func TestCapabilitiesInManifest(t *testing.T) {
	node := capNode{caps: []string{"ioc.enrich"}}
	p := NewPlugin(PluginInfo{ID: "test-plugin", Name: "T", Version: "1"}, node)
	if got := p.Manifest().Nodes[0].Capabilities; len(got) != 1 || got[0] != "ioc.enrich" {
		t.Errorf("capabilities = %v", got)
	}
	_, err := BuildPlugin(PluginInfo{ID: "test-plugin", Name: "T", Version: "1"}, capNode{caps: []string{"IOC Enrich"}})
	if err == nil || !strings.Contains(err.Error(), "capability") {
		t.Errorf("bad capability must fail: %v", err)
	}
}

type capNode struct {
	upperNode
	caps []string
}

func (n capNode) Description() NodeDescriptor {
	d := n.upperNode.Description()
	d.Capabilities = n.caps
	return d
}

func TestCompositeValidation(t *testing.T) {
	cases := map[string]struct {
		edit func(*CompositeTypeDescriptor)
		want string
	}{
		"duplicate slot":    {func(c *CompositeTypeDescriptor) { c.Slots[1].Name = "enrich" }, `duplicate slot "enrich"`},
		"max below min":     {func(c *CompositeTypeDescriptor) { c.Slots[0].Min, c.Slots[0].Max = IntPtr(2), IntPtr(1) }, "max is below min"},
		"max below default": {func(c *CompositeTypeDescriptor) { c.Slots[0].Max = IntPtr(0) }, "max must be positive"},
		"port slot":         {func(c *CompositeTypeDescriptor) { c.Outputs[0].Slot = "nope" }, `port "decision" names unknown slot "nope"`},
		"feeds slot":        {func(c *CompositeTypeDescriptor) { c.Rules[0].To = "nope" }, `a feeds rule names unknown slot "nope"`},
		"onError slot":      {func(c *CompositeTypeDescriptor) { c.Rules[1].Slots = []string{"nope"} }, `an onError rule names unknown slot "nope"`},
		"reaches slot": {func(c *CompositeTypeDescriptor) {
			c.Rules = append(c.Rules, CompositeRule{Rule: "reaches", To: "nope"})
		}, `a reaches rule names unknown slot "nope"`},
		"starter slot":      {func(c *CompositeTypeDescriptor) { c.Starter.Nodes[0].Slot = "nope" }, `starter node "a" names unknown slot "nope"`},
		"starter conn":      {func(c *CompositeTypeDescriptor) { c.Starter.Connections[0].Target = "zzz" }, "names an unknown node"},
		"bad name":          {func(c *CompositeTypeDescriptor) { c.Name = "1bad" }, "must be an identifier"},
		"bad slot name":     {func(c *CompositeTypeDescriptor) { c.Slots[0].Name = "has space" }, "slot name"},
		"bad port name":     {func(c *CompositeTypeDescriptor) { c.Inputs[0].Name = "bad name" }, "port name"},
		"bad rule":          {func(c *CompositeTypeDescriptor) { c.Rules[2].Rule = "mystery" }, "is not feeds"},
		"empty matcher":     {func(c *CompositeTypeDescriptor) { c.Slots[0].Accepts = NodeMatcher{} }, "needs at least one field"},
		"bad capability":    {func(c *CompositeTypeDescriptor) { c.Slots[0].Accepts.Capability = OneOrMany{"Bad Tag"} }, "capability"},
		"no slots":          {func(c *CompositeTypeDescriptor) { c.Slots = nil }, "at least one slot"},
		"duplicate version": {func(c *CompositeTypeDescriptor) {}, ""},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			c := testComposite()
			tc.edit(&c)
			if name == "duplicate version" {
				_, err := BuildPlugin(PluginInfo{ID: "p", Name: "P", Version: "1", Composites: []CompositeTypeDescriptor{c, c}}, upperNode{})
				if err == nil || !strings.Contains(err.Error(), "duplicate composite") {
					t.Errorf("err = %v", err)
				}
				return
			}
			_, err := compositePlugin(c)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Errorf("want error containing %q, got %v", tc.want, err)
			}
		})
	}
	if _, err := compositePlugin(testComposite()); err != nil {
		t.Errorf("valid composite rejected: %v", err)
	}
}
