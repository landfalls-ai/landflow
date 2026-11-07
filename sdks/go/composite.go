package landflow

import (
	"encoding/json"
	"fmt"
	"regexp"
)

// Composite types: canvas frames with a contract of slots, ports and rules (docs/composites.md). A plugin declares
// them in PluginInfo.Composites; NewPlugin validates them and serves them as PluginManifest.composites.

var capabilityPattern = regexp.MustCompile(`^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$`)

// OneOrMany is a list that travels as a bare string when it holds one value ("ioc.enrich") and as an array
// otherwise, the form NodeMatcher fields take on the wire.
type OneOrMany []string

func (o OneOrMany) MarshalJSON() ([]byte, error) {
	if len(o) == 1 {
		return json.Marshal(o[0])
	}
	return json.Marshal([]string(o))
}

func (o *OneOrMany) UnmarshalJSON(data []byte) error {
	var one string
	if err := json.Unmarshal(data, &one); err == nil {
		*o = OneOrMany{one}
		return nil
	}
	var many []string
	if err := json.Unmarshal(data, &many); err != nil {
		return err
	}
	*o = many
	return nil
}

// NodeMatcher says what a composite slot accepts. Every field given must match; a list matches any of its values.
type NodeMatcher struct {
	// Type: fully-qualified node types ("triage.triageDecision").
	Type OneOrMany `json:"type,omitempty"`
	// Kind: "trigger", "action" or "subnode".
	Kind OneOrMany `json:"kind,omitempty"`
	// Supplies: the connection type a sub-node supplies ("ai_languageModel").
	Supplies OneOrMany `json:"supplies,omitempty"`
	// Category is one of the node's categories (case-insensitive).
	Category OneOrMany `json:"category,omitempty"`
	// Capability is one of the node's Capabilities.
	Capability OneOrMany `json:"capability,omitempty"`
	// Input: the node has an input port of this connection type.
	Input ConnectionType `json:"input,omitempty"`
	// Composite: a composite of this type, nested in the frame, fills the slot instead of a node.
	Composite OneOrMany `json:"composite,omitempty"`
	// AnyOf matches when any of these does (combined with the fields above).
	AnyOf []NodeMatcher `json:"anyOf,omitempty"`
}

// CompositeSlot is a step a composite must (or may) contain.
type CompositeSlot struct {
	Name        string      `json:"name"`
	DisplayName string      `json:"displayName"`
	Description string      `json:"description,omitempty"`
	Accepts     NodeMatcher `json:"accepts"`
	// Min is the fewest nodes that fill the slot; nil means 1, 0 makes it optional.
	Min *int `json:"min,omitempty"`
	// Max is the most nodes; nil means no limit.
	Max *int `json:"max,omitempty"`
	// Locked: its nodes can be configured but not deleted or retyped.
	Locked bool `json:"locked,omitempty"`
}

// CompositePort is a named edge of the frame. An output carries one output of a slot's node (Slot + Index); an input
// names the slot whose node takes what comes in from outside.
type CompositePort struct {
	Name        string `json:"name"`
	DisplayName string `json:"displayName,omitempty"`
	Slot        string `json:"slot,omitempty"`
	Index       int    `json:"index,omitempty"`
}

// CompositeRule is a structural rule over the frame. Rule is "feeds" (From, To, optional Via), "onError" (Slots,
// Value "stop" or "continue"), "reaches" (To) or "sealed". Fields a rule does not use stay empty.
type CompositeRule struct {
	Rule  string         `json:"rule"`
	From  string         `json:"from,omitempty"`
	To    string         `json:"to,omitempty"`
	Via   ConnectionType `json:"via,omitempty"`
	Slots []string       `json:"slots,omitempty"`
	Value string         `json:"value,omitempty"`
}

// CompositeStarterNode is a node of a composite's starter graph. Slot binds it; ids are local to the starter.
type CompositeStarterNode struct {
	ID          string         `json:"id"`
	Name        string         `json:"name"`
	Type        string         `json:"type"`
	TypeVersion int            `json:"typeVersion,omitempty"`
	Position    [2]float64     `json:"position"`
	Parameters  map[string]any `json:"parameters,omitempty"`
	OnError     string         `json:"onError,omitempty"`
	RetryOnFail bool           `json:"retryOnFail,omitempty"`
	MaxTries    int            `json:"maxTries,omitempty"`
	// WaitBetweenTriesMs and RetryBackoff ("fixed" or "exponential") apply when RetryOnFail is set.
	WaitBetweenTriesMs int    `json:"waitBetweenTriesMs,omitempty"`
	RetryBackoff       string `json:"retryBackoff,omitempty"`
	Slot               string `json:"slot,omitempty"`
}

// CompositeStarterConnection joins two starter nodes by id.
type CompositeStarterConnection struct {
	Source      string         `json:"source"`
	SourceIndex int            `json:"sourceIndex,omitempty"`
	Target      string         `json:"target"`
	TargetIndex int            `json:"targetIndex,omitempty"`
	Type        ConnectionType `json:"type,omitempty"`
}

// CompositeStarter is the graph dropped in when a composite is inserted.
type CompositeStarter struct {
	Nodes       []CompositeStarterNode       `json:"nodes"`
	Connections []CompositeStarterConnection `json:"connections"`
}

// CompositeTypeDescriptor declares a composite type: a contract for a canvas frame plus its starter graph. The
// workflow owns the frame's nodes; the contract is only checked against them. Name is local to the plugin; the host
// qualifies it as "<pluginId>.<name>".
type CompositeTypeDescriptor struct {
	Name        string `json:"name"`
	DisplayName string `json:"displayName"`
	Description string `json:"description"`
	// Version: a plugin may declare several versions of a type; an instance pins the one it was built for.
	Version int    `json:"version"`
	Icon    string `json:"icon,omitempty"`
	// Color is an accent colour (hex).
	Color   string          `json:"color,omitempty"`
	Inputs  []CompositePort `json:"inputs,omitempty"`
	Outputs []CompositePort `json:"outputs,omitempty"`
	Slots   []CompositeSlot `json:"slots"`
	Rules   []CompositeRule `json:"rules,omitempty"`
	// Closed: nodes that fill no slot are not allowed.
	Closed bool `json:"closed,omitempty"`
	// OnError is "stop" or "fallback" (a failing node sends the frame's input out of an extra Fallback output).
	OnError        string               `json:"onError,omitempty"`
	TimeoutSeconds float64              `json:"timeoutSeconds,omitempty"`
	Properties     []PropertyDescriptor `json:"properties,omitempty"`
	Starter        *CompositeStarter    `json:"starter,omitempty"`
}

// IntPtr returns a pointer to n, for CompositeSlot.Min and Max.
func IntPtr(n int) *int { return &n }

var validMatcherKinds = map[string]bool{"trigger": true, "action": true, "subnode": true}
var validSubnodeTypes = map[string]bool{
	"ai_languageModel": true, "ai_tool": true, "ai_memory": true, "ai_embedding": true,
	"ai_document": true, "ai_textSplitter": true, "ai_retriever": true, "ai_reranker": true,
}

func validConnectionType(t ConnectionType) bool {
	return t == ConnectionMain || validSubnodeTypes[string(t)]
}

func validateMatcher(path string, m NodeMatcher) []string {
	var problems []string
	add := func(format string, args ...any) { problems = append(problems, path+": "+fmt.Sprintf(format, args...)) }
	if len(m.Type) == 0 && len(m.Kind) == 0 && len(m.Supplies) == 0 && len(m.Category) == 0 && len(m.Capability) == 0 &&
		m.Input == "" && len(m.Composite) == 0 && len(m.AnyOf) == 0 {
		add("a matcher needs at least one field")
	}
	for _, k := range m.Kind {
		if !validMatcherKinds[k] {
			add("kind %q is not trigger, action or subnode", k)
		}
	}
	for _, s := range m.Supplies {
		if !validSubnodeTypes[s] {
			add("supplies %q is not a sub-node connection type", s)
		}
	}
	for _, c := range m.Capability {
		if !capabilityPattern.MatchString(c) {
			add("capability %q is not a lowercase dotted tag like ioc.enrich", c)
		}
	}
	for name, list := range map[string]OneOrMany{"type": m.Type, "category": m.Category, "composite": m.Composite} {
		for _, v := range list {
			if v == "" {
				add("%s has an empty value", name)
			}
		}
	}
	if m.Input != "" && !validConnectionType(m.Input) {
		add("input %q is not a connection type", m.Input)
	}
	for i, sub := range m.AnyOf {
		problems = append(problems, validateMatcher(fmt.Sprintf("%s.anyOf[%d]", path, i), sub)...)
	}
	return problems
}

// validateComposite mirrors the protocol's compositeTypeSchema (packages/protocol/src/schema.ts).
func validateComposite(c CompositeTypeDescriptor) []string {
	var problems []string
	add := func(format string, args ...any) { problems = append(problems, fmt.Sprintf(format, args...)) }
	if !nodeNamePattern.MatchString(c.Name) {
		add("composite name %q must be an identifier (letters, digits, _ and -)", c.Name)
	}
	if c.DisplayName == "" {
		add("displayName is required")
	}
	if c.Version <= 0 {
		add("version %d must be a positive integer", c.Version)
	}
	if c.Color != "" && !hexColorPattern.MatchString(c.Color) {
		add("color %q must be a hex colour like #2563eb", c.Color)
	}
	switch c.OnError {
	case "", "stop", "fallback":
	default:
		add("onError %q is not stop or fallback", c.OnError)
	}
	if c.TimeoutSeconds < 0 {
		add("timeoutSeconds must be positive")
	}
	if len(c.Slots) == 0 {
		add("a composite needs at least one slot")
	}
	slots := map[string]bool{}
	for i, s := range c.Slots {
		at := fmt.Sprintf("slots[%d]", i)
		if !nodeNamePattern.MatchString(s.Name) {
			add("%s: slot name %q must be an identifier (letters, digits, _ and -)", at, s.Name)
		} else if slots[s.Name] {
			add("duplicate slot %q", s.Name)
		}
		slots[s.Name] = true
		if s.DisplayName == "" {
			add("%s: displayName is required", at)
		}
		problems = append(problems, validateMatcher(at+".accepts", s.Accepts)...)
		if s.Min != nil && *s.Min < 0 {
			add("slot %q: min must not be negative", s.Name)
		}
		if s.Max != nil {
			min := 1
			if s.Min != nil {
				min = *s.Min
			}
			if *s.Max <= 0 {
				add("slot %q: max must be positive", s.Name)
			} else if *s.Max < min {
				add("slot %q: max is below min", s.Name)
			}
		}
	}
	known := func(name, where string) {
		if name != "" && !slots[name] {
			add("%s names unknown slot %q", where, name)
		}
	}
	for _, ports := range [][]CompositePort{c.Inputs, c.Outputs} {
		for _, port := range ports {
			if !nodeNamePattern.MatchString(port.Name) {
				add("port name %q must be an identifier (letters, digits, _ and -)", port.Name)
			}
			if port.Index < 0 {
				add("port %q: index must not be negative", port.Name)
			}
			known(port.Slot, fmt.Sprintf("port %q", port.Name))
		}
	}
	for i, r := range c.Rules {
		at := fmt.Sprintf("rules[%d]", i)
		switch r.Rule {
		case "feeds":
			if r.From == "" || r.To == "" {
				add("%s: a feeds rule needs from and to", at)
			}
			known(r.From, "a feeds rule")
			known(r.To, "a feeds rule")
			if r.Via != "" && !validConnectionType(r.Via) {
				add("%s: via %q is not a connection type", at, r.Via)
			}
		case "onError":
			if len(r.Slots) == 0 {
				add("%s: an onError rule needs slots", at)
			}
			if r.Value != "stop" && r.Value != "continue" {
				add("%s: onError value %q is not stop or continue", at, r.Value)
			}
			for _, s := range r.Slots {
				known(s, "an onError rule")
			}
		case "reaches":
			if r.To == "" {
				add("%s: a reaches rule needs to", at)
			}
			known(r.To, "a reaches rule")
		case "sealed":
		default:
			add("%s: rule %q is not feeds, onError, reaches or sealed", at, r.Rule)
		}
	}
	if c.Starter != nil {
		ids := map[string]bool{}
		for _, n := range c.Starter.Nodes {
			if n.ID == "" || n.Name == "" || n.Type == "" {
				add("starter node %q needs id, name and type", n.ID)
			}
			if n.OnError != "" && n.OnError != "stop" && n.OnError != "continue" {
				add("starter node %q: onError %q is not stop or continue", n.ID, n.OnError)
			}
			ids[n.ID] = true
			known(n.Slot, fmt.Sprintf("starter node %q", n.ID))
		}
		for _, conn := range c.Starter.Connections {
			if !ids[conn.Source] || !ids[conn.Target] {
				add("starter connection %s → %s names an unknown node", conn.Source, conn.Target)
			}
			if conn.Type != "" && !validConnectionType(conn.Type) {
				add("starter connection %s → %s: type %q is not a connection type", conn.Source, conn.Target, conn.Type)
			}
		}
	}
	return append(problems, validateProperties("properties", c.Properties, false)...)
}
