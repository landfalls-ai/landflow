// Package mcpface is the MCP face of a Landflow plugin (docs/protocol.md §15.1 and §15.2): the pure mapping from a
// plugin manifest to MCP tool definitions, the way back from a tool call to node parameters, and a Streamable HTTP /
// stdio server over any transport.Dispatcher. It is the Go twin of packages/protocol/src/mcp-tools.ts and
// packages/sdk/src/mcp.ts, checked against the shared fixtures in packages/protocol/conformance.
//
// The package reads the manifest as JSON and dispatches JSON bodies, so it serves a plugin in process (the SDK's
// Serve mounts it at /mcp) and a plugin behind landflow-bridge alike. It depends on sdks/go/transport for the
// Dispatcher contract and the error codes, not on the SDK root package.
package mcpface

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Tool names: letters, digits, `_` and `-`, at most 64 characters (the MCP spec allows 128 and `.`; the strictest
// common client allows 64).
const (
	ToolNameMaxLength = 64
	// ToolMetaKey is the `_meta` key under which a tool definition carries its node binding.
	ToolMetaKey = "dev.landflow/node"
)

var toolNamePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// IsValidToolName reports whether name matches `[A-Za-z0-9_-]{1,64}`.
func IsValidToolName(name string) bool { return toolNamePattern.MatchString(name) }

// ---------------------------------------------------------------------------
// The manifest subset the mapping reads (decoded from JSON so any producer works)
// ---------------------------------------------------------------------------

// Manifest is the part of a plugin manifest the mapping needs.
type Manifest struct {
	Protocol        string           `json:"protocol"`
	Plugin          PluginInfo       `json:"plugin"`
	Nodes           []NodeDescriptor `json:"nodes"`
	CredentialTypes []CredentialType `json:"credentialTypes,omitempty"`
}

// PluginInfo identifies the plugin.
type PluginInfo struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Version     string `json:"version"`
	Description string `json:"description,omitempty"`
}

// CredentialType names the fields of a credential (for the "credential missing" message).
type CredentialType struct {
	Name       string     `json:"name"`
	Properties []Property `json:"properties"`
}

// NodeDescriptor is a node as the mapping sees it.
type NodeDescriptor struct {
	Name            string           `json:"name"`
	DisplayName     string           `json:"displayName"`
	Description     *string          `json:"description,omitempty"`
	Version         json.RawMessage  `json:"version"`
	DefaultVersion  *int             `json:"defaultVersion,omitempty"`
	Kind            string           `json:"kind"`
	Idempotent      *bool            `json:"idempotent,omitempty"`
	MCP             *bool            `json:"mcp,omitempty"`
	OutputSchema    map[string]any   `json:"outputSchema,omitempty"`
	ToolAnnotations map[string]any   `json:"toolAnnotations,omitempty"`
	UsableAsTool    bool             `json:"usableAsTool,omitempty"`
	ToolDescription *string          `json:"toolDescription,omitempty"`
	Properties      []Property       `json:"properties"`
	Credentials     []NodeCredential `json:"credentials,omitempty"`
}

// NodeCredential is one entry of a node's `credentials`.
type NodeCredential struct {
	Name           string          `json:"name"`
	Required       bool            `json:"required,omitempty"`
	DisplayOptions *DisplayOptions `json:"displayOptions,omitempty"`
}

// DisplayOptions is n8n-style conditional visibility.
type DisplayOptions struct {
	Show Conditions `json:"show,omitempty"`
	Hide Conditions `json:"hide,omitempty"`
}

// Conditions is a `show` or `hide` map that remembers the order of its keys (the notes in descriptions follow it).
type Conditions struct {
	Keys   []string
	Values map[string][]any
}

// Get returns the values of one condition.
func (c Conditions) Get(key string) ([]any, bool) {
	v, ok := c.Values[key]
	return v, ok
}

// UnmarshalJSON keeps the key order of the JSON object.
func (c *Conditions) UnmarshalJSON(data []byte) error {
	c.Keys, c.Values = nil, map[string][]any{}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	tok, err := dec.Token()
	if err != nil {
		return err
	}
	if tok == nil {
		return nil
	}
	if tok != json.Delim('{') {
		return fmt.Errorf("displayOptions condition must be an object")
	}
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return err
		}
		key, _ := keyTok.(string)
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			return err
		}
		var values []any
		if err := json.Unmarshal(raw, &values); err != nil {
			return fmt.Errorf("displayOptions condition %q must be an array: %w", key, err)
		}
		if _, dup := c.Values[key]; !dup {
			c.Keys = append(c.Keys, key)
		}
		c.Values[key] = values
	}
	_, err = dec.Token()
	return err
}

// MarshalJSON writes the conditions in their original order.
func (c Conditions) MarshalJSON() ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteByte('{')
	for i, key := range c.Keys {
		if i > 0 {
			buf.WriteByte(',')
		}
		k, _ := json.Marshal(key)
		v, err := json.Marshal(c.Values[key])
		if err != nil {
			return nil, err
		}
		buf.Write(k)
		buf.WriteByte(':')
		buf.Write(v)
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}

// Option is one choice of an options / multiOptions property.
type Option struct {
	Name            string         `json:"name"`
	Value           any            `json:"value"`
	Description     *string        `json:"description,omitempty"`
	Action          *string        `json:"action,omitempty"`
	MCP             *bool          `json:"mcp,omitempty"`
	Idempotent      *bool          `json:"idempotent,omitempty"`
	OutputSchema    map[string]any `json:"outputSchema,omitempty"`
	ToolAnnotations map[string]any `json:"toolAnnotations,omitempty"`
}

// TypeOptions tweaks a property.
type TypeOptions struct {
	Language             string   `json:"language,omitempty"`
	MinValue             *float64 `json:"minValue,omitempty"`
	MaxValue             *float64 `json:"maxValue,omitempty"`
	NumberPrecision      *int     `json:"numberPrecision,omitempty"`
	MultipleValues       bool     `json:"multipleValues,omitempty"`
	LoadOptionsMethod    string   `json:"loadOptionsMethod,omitempty"`
	LoadOptionsDependsOn []string `json:"loadOptionsDependsOn,omitempty"`
}

// Group is one group of a fixedCollection.
type Group struct {
	Name        string     `json:"name"`
	DisplayName string     `json:"displayName"`
	Values      []Property `json:"values"`
}

// Property is one node property. Default keeps JSON null apart from absent (both mean "no default").
type Property struct {
	Name           string          `json:"name"`
	DisplayName    string          `json:"displayName"`
	Type           string          `json:"type"`
	Default        json.RawMessage `json:"default,omitempty"`
	Description    *string         `json:"description,omitempty"`
	Hint           *string         `json:"hint,omitempty"`
	Required       bool            `json:"required,omitempty"`
	Options        []Option        `json:"options,omitempty"`
	Values         []Property      `json:"values,omitempty"`
	Groups         []Group         `json:"groups,omitempty"`
	TypeOptions    *TypeOptions    `json:"typeOptions,omitempty"`
	DisplayOptions *DisplayOptions `json:"displayOptions,omitempty"`
}

// ParseManifest decodes a manifest given as JSON bytes, json.RawMessage, a *Manifest / Manifest, or any value that
// marshals to a manifest (the SDK's PluginManifest struct, a map).
func ParseManifest(manifest any) (*Manifest, error) {
	switch m := manifest.(type) {
	case *Manifest:
		return m, nil
	case Manifest:
		return &m, nil
	case json.RawMessage:
		return decodeManifest(m)
	case []byte:
		return decodeManifest(m)
	case string:
		return decodeManifest([]byte(m))
	default:
		data, err := json.Marshal(manifest)
		if err != nil {
			return nil, fmt.Errorf("mcpface: manifest is not JSON-encodable: %w", err)
		}
		return decodeManifest(data)
	}
}

func decodeManifest(data []byte) (*Manifest, error) {
	var m Manifest
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("mcpface: manifest is not valid JSON: %w", err)
	}
	if m.Plugin.ID == "" {
		return nil, fmt.Errorf("mcpface: manifest has no plugin.id")
	}
	return &m, nil
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

// DynamicOption is a parameter whose values come from LoadOptions.
type DynamicOption struct {
	// Parameter is a path inside the arguments ("channel", "options/labels").
	Parameter string   `json:"parameter"`
	Method    string   `json:"method"`
	DependsOn []string `json:"dependsOn,omitempty"`
}

// CredentialSelector is a parameter that chooses the credential (`authentication`): never an argument.
type CredentialSelector struct {
	Parameter    string         `json:"parameter"`
	ByCredential map[string]any `json:"byCredential"`
}

// Binding is what ties a tool to a node, kept under `_meta[ToolMetaKey]`.
type Binding struct {
	PluginID            string               `json:"pluginId"`
	NodeType            string               `json:"nodeType"`
	NodeName            string               `json:"nodeName"`
	TypeVersion         int                  `json:"typeVersion"`
	Resource            *string              `json:"resource,omitempty"`
	Operation           *string              `json:"operation,omitempty"`
	FixedParameters     map[string]any       `json:"fixedParameters"`
	Arguments           []string             `json:"arguments"`
	Credentials         []string             `json:"credentials"`
	CredentialSelectors []CredentialSelector `json:"credentialSelectors"`
	DynamicOptions      []DynamicOption      `json:"dynamicOptions"`
}

// Tool is an MCP tool as `tools/list` returns it, plus the Landflow binding under `_meta`.
type Tool struct {
	Name         string         `json:"name"`
	Title        string         `json:"title"`
	Description  string         `json:"description"`
	InputSchema  map[string]any `json:"inputSchema"`
	OutputSchema map[string]any `json:"outputSchema,omitempty"`
	// Annotations always carries title, readOnlyHint, destructiveHint, idempotentHint and openWorldHint.
	Annotations map[string]any     `json:"annotations"`
	Meta        map[string]Binding `json:"_meta"`
}

// Binding returns the node binding of the tool.
func (t *Tool) Binding() Binding { return t.Meta[ToolMetaKey] }

// WithoutBinding is the tool as agents see it: the same without `_meta`.
func (t *Tool) WithoutBinding() map[string]any {
	out := map[string]any{"name": t.Name, "title": t.Title, "description": t.Description, "inputSchema": t.InputSchema, "annotations": t.Annotations}
	if t.OutputSchema != nil {
		out["outputSchema"] = t.OutputSchema
	}
	return out
}

// Options tunes the mapping.
type Options struct {
	// IncludeAllActions also maps action nodes without usableAsTool.
	IncludeAllActions bool
	// TypeVersion maps this version instead of the node's default one (0 = default).
	TypeVersion int
}

// ToolsFromManifest maps a manifest (see ParseManifest for the accepted forms) to its tools, names unique per plugin.
func ToolsFromManifest(manifest any, opts ...Options) ([]*Tool, error) {
	m, err := ParseManifest(manifest)
	if err != nil {
		return nil, err
	}
	var o Options
	if len(opts) > 0 {
		o = opts[0]
	}
	return ToolsFromDescriptors(m.Plugin.ID, m.Nodes, o), nil
}

// ToolsFromDescriptors maps node descriptors to tools with names unique across them.
func ToolsFromDescriptors(pluginID string, nodes []NodeDescriptor, o Options) []*Tool {
	var tools []*Tool
	for i := range nodes {
		tools = append(tools, ToolsForNode(pluginID, &nodes[i], o)...)
	}
	names := make([]string, len(tools))
	for i, t := range tools {
		names[i] = t.Name
	}
	for i, name := range uniqueNames(names) {
		tools[i].Name = name
	}
	return tools
}

// IsToolNode says whether a node is offered as tools at all: an action node, usableAsTool (unless IncludeAllActions), not opted out.
func IsToolNode(node *NodeDescriptor, o Options) bool {
	if node.Kind != "action" || (node.MCP != nil && !*node.MCP) {
		return false
	}
	return o.IncludeAllActions || node.UsableAsTool
}

// ToolsForNode maps one node, before names are made unique across the plugin.
func ToolsForNode(pluginID string, node *NodeDescriptor, o Options) []*Tool {
	if !IsToolNode(node, o) {
		return nil
	}
	typeVersion := o.TypeVersion
	if typeVersion == 0 {
		typeVersion = defaultVersionOf(node)
	}
	selectors := credentialSelectorsOf(node)
	selectorSet := map[string]bool{}
	for _, s := range selectors {
		selectorSet[s.Parameter] = true
	}
	var tools []*Tool
	for _, slot := range operationSlots(node) {
		if (slot.resource != nil && slot.resource.MCP != nil && !*slot.resource.MCP) || (slot.operation != nil && slot.operation.MCP != nil && !*slot.operation.MCP) {
			continue
		}
		ctx := &schemaContext{fixed: slot.fixed, selectors: selectorSet, dynamic: []DynamicOption{}}
		inputSchema, args := objectSchema(node.Properties, ctx)
		title := toolTitle(node, slot)
		outputSchema := node.OutputSchema
		if slot.operation != nil && slot.operation.OutputSchema != nil {
			outputSchema = slot.operation.OutputSchema
		}
		binding := Binding{
			PluginID: pluginID, NodeType: pluginID + "." + node.Name, NodeName: node.Name, TypeVersion: typeVersion,
			FixedParameters: slot.fixed, Arguments: args, Credentials: []string{}, CredentialSelectors: selectors, DynamicOptions: ctx.dynamic,
		}
		for _, c := range node.Credentials {
			binding.Credentials = append(binding.Credentials, c.Name)
		}
		if slot.resource != nil {
			binding.Resource = ptr(stringOf(slot.resource.Value))
		}
		if slot.operation != nil {
			binding.Operation = ptr(stringOf(slot.operation.Value))
		}
		tool := &Tool{
			Name: SanitizeToolName(rawToolName(pluginID, node, slot)), Title: title, Description: toolDescription(node, slot),
			InputSchema: inputSchema, Annotations: deriveAnnotations(node, slot, title), Meta: map[string]Binding{ToolMetaKey: binding},
		}
		if outputSchema != nil {
			tool.OutputSchema = map[string]any{"type": "object", "properties": map[string]any{"items": map[string]any{"type": "array", "items": outputSchema}}, "required": []any{"items"}}
		}
		tools = append(tools, tool)
	}
	return tools
}

// FindTool returns the tool with that name, or nil.
func FindTool(tools []*Tool, name string) *Tool {
	for _, t := range tools {
		if t.Name == name {
			return t
		}
	}
	return nil
}

// CallMapping is the result of mapping a tool call back onto a node.
type CallMapping struct {
	NodeType    string
	TypeVersion int
	// Parameters are the fixed parameters (resource, operation) with the known arguments merged over them.
	Parameters map[string]any
	// Ignored are the argument names the tool's schema does not know (sorted).
	Ignored []string
}

// ToolCallToParameters is the reverse mapping: only arguments the tool declares become parameters; the rest is reported.
func ToolCallToParameters(tool *Tool, args map[string]any) CallMapping {
	b := tool.Binding()
	known := map[string]bool{}
	for _, a := range b.Arguments {
		known[a] = true
	}
	params := map[string]any{}
	for k, v := range b.FixedParameters {
		params[k] = v
	}
	ignored := []string{}
	for k, v := range args {
		if known[k] {
			params[k] = v
		} else {
			ignored = append(ignored, k)
		}
	}
	sort.Strings(ignored)
	return CallMapping{NodeType: b.NodeType, TypeVersion: b.TypeVersion, Parameters: params, Ignored: ignored}
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

var (
	illegalRun   = regexp.MustCompile(`[^A-Za-z0-9_-]+`)
	underscores  = regexp.MustCompile(`_{2,}`)
	edgeRun      = regexp.MustCompile(`^[_-]+|[_-]+$`)
	trailingRun  = regexp.MustCompile(`[_-]+$`)
	readOnlyVerb = []string{"get", "getAll", "getMany", "list", "search", "read", "find", "fetch", "describe", "count", "exists", "check", "download", "select", "info", "keys", "llen", "lookup", "retrieve", "view", "show", "preview", "head"}
	destructive  = []string{"delete", "remove", "destroy", "drop", "purge", "archive", "trash", "clear", "truncate", "revoke", "unpublish", "deleteTable", "deleteMessage"}
)

// SanitizeToolName makes any string a legal tool name: characters outside `[A-Za-z0-9_-]` become `_`, runs collapse,
// leading and trailing `_` go, and the result is cut to 64 characters (`tool` if nothing is left).
func SanitizeToolName(raw string) string { return sanitizeToolName(raw, ToolNameMaxLength) }

func sanitizeToolName(raw string, max int) string {
	cleaned := illegalRun.ReplaceAllString(raw, "_")
	cleaned = underscores.ReplaceAllString(cleaned, "_")
	cleaned = edgeRun.ReplaceAllString(cleaned, "")
	if len(cleaned) > max {
		cleaned = cleaned[:max]
	}
	cleaned = trailingRun.ReplaceAllString(cleaned, "")
	if cleaned == "" {
		return "tool"
	}
	return cleaned
}

// GatewayToolName is the name a tool has on the gateway's shared endpoint: `<GatewayTargetName(pluginId)>_<tool>`.
func GatewayToolName(pluginID, toolName string) string {
	return SanitizeToolName(GatewayTargetName(pluginID) + "_" + toolName)
}

var (
	targetIllegal = regexp.MustCompile(`[^a-z0-9.-]+`)
	targetEdges   = regexp.MustCompile(`^[.-]+|[.-]+$`)
	targetTrail   = regexp.MustCompile(`[.-]+$`)
)

// GatewayTargetName is the gateway target name of a plugin (the prefix of its tools on the shared endpoint): an id
// already in `[a-z0-9.-]` (at most 63 characters) as is; any other id lowercased, runs of other characters as `-`,
// the stem cut to 40 characters plus `-` and 6 hex digits of FNV-1a 32 over the original id, so ids never collide.
func GatewayTargetName(pluginID string) string {
	cleaned := targetEdges.ReplaceAllString(targetIllegal.ReplaceAllString(strings.ToLower(pluginID), "-"), "")
	if cleaned == pluginID && len(cleaned) <= 63 {
		return cleaned
	}
	stem := cleaned
	if len(stem) > 40 {
		stem = stem[:40]
	}
	stem = targetTrail.ReplaceAllString(stem, "")
	if stem == "" {
		stem = "plugin"
	}
	return stem + "-" + fmt.Sprintf("%08x", fnv1a(pluginID))[:6]
}

// fnv1a is FNV-1a over the UTF-8 bytes, 32 bits.
func fnv1a(text string) uint32 {
	hash := uint32(0x811c9dc5)
	for _, b := range []byte(text) {
		hash = (hash ^ uint32(b)) * 0x01000193
	}
	return hash
}

// uniqueNames gives every entry a distinct name: a repeat gets `_2`, `_3`, … within the length limit.
func uniqueNames(names []string) []string {
	seen := map[string]int{}
	taken := map[string]bool{}
	for _, n := range names {
		taken[n] = true
	}
	out := make([]string, 0, len(names))
	for _, name := range names {
		seen[name]++
		if seen[name] == 1 {
			out = append(out, name)
			continue
		}
		n := seen[name]
		var candidate string
		for {
			suffix := "_" + strconv.Itoa(n)
			n++
			base := name
			if len(base) > ToolNameMaxLength-len(suffix) {
				base = base[:ToolNameMaxLength-len(suffix)]
			}
			candidate = base + suffix
			if !taken[candidate] {
				break
			}
		}
		taken[candidate] = true
		out = append(out, candidate)
	}
	return out
}

// rawToolName is `<resource>_<operation>`, prefixed with the node name unless the node is named after its plugin and
// has a resource; without a resource the node name takes its place; without both, the node name alone.
func rawToolName(pluginID string, node *NodeDescriptor, slot operationSlot) string {
	var segments []string
	if slot.resource == nil || node.Name != pluginID {
		segments = append(segments, node.Name)
	}
	if slot.resource != nil {
		segments = append(segments, stringOf(slot.resource.Value))
	}
	if slot.operation != nil {
		segments = append(segments, stringOf(slot.operation.Value))
	}
	return strings.Join(segments, "_")
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

type operationSlot struct {
	resource  *Option
	operation *Option
	fixed     map[string]any
}

func isOptionsProperty(p *Property, name string) bool {
	return p.Name == name && p.Type == "options" && (p.TypeOptions == nil || p.TypeOptions.LoadOptionsMethod == "") && len(p.Options) > 0
}

// appliesToResource: only the `resource` condition of an `operation` property counts.
func appliesToResource(p *Property, resource any) bool {
	if p.DisplayOptions == nil {
		return true
	}
	if show, ok := p.DisplayOptions.Show.Get("resource"); ok && show != nil && !containsValue(show, resource) {
		return false
	}
	if hide, ok := p.DisplayOptions.Hide.Get("resource"); ok && containsValue(hide, resource) {
		return false
	}
	return true
}

func uniqueOptions(options []*Option) []*Option {
	seen := map[string]bool{}
	var out []*Option
	for _, o := range options {
		key := stringOf(o.Value)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, o)
	}
	return out
}

// operationSlots lists the (resource, operation) pairs of a node in manifest order; operations split over several
// `operation` properties (one per authentication method) are merged per resource.
func operationSlots(node *NodeDescriptor) []operationSlot {
	var resourceProperty *Property
	var operationProperties []*Property
	for i := range node.Properties {
		p := &node.Properties[i]
		if resourceProperty == nil && isOptionsProperty(p, "resource") {
			resourceProperty = p
		}
		if isOptionsProperty(p, "operation") {
			operationProperties = append(operationProperties, p)
		}
	}
	if resourceProperty == nil {
		if len(operationProperties) == 0 {
			return []operationSlot{{fixed: map[string]any{}}}
		}
		var all []*Option
		for _, p := range operationProperties {
			for i := range p.Options {
				all = append(all, &p.Options[i])
			}
		}
		var slots []operationSlot
		for _, op := range uniqueOptions(all) {
			slots = append(slots, operationSlot{operation: op, fixed: map[string]any{"operation": op.Value}})
		}
		return slots
	}
	var slots []operationSlot
	for i := range resourceProperty.Options {
		resource := &resourceProperty.Options[i]
		var candidates []*Option
		for _, p := range operationProperties {
			if !appliesToResource(p, resource.Value) {
				continue
			}
			for j := range p.Options {
				candidates = append(candidates, &p.Options[j])
			}
		}
		operations := uniqueOptions(candidates)
		if len(operations) == 0 {
			slots = append(slots, operationSlot{resource: resource, fixed: map[string]any{"resource": resource.Value}})
		}
		for _, op := range operations {
			slots = append(slots, operationSlot{resource: resource, operation: op, fixed: map[string]any{"resource": resource.Value, "operation": op.Value}})
		}
	}
	return slots
}

// shownForSlot: a condition on resource/operation must hold; conditions on other parameters are ignored.
func shownForSlot(do *DisplayOptions, fixed map[string]any) bool {
	if do == nil {
		return true
	}
	for key, allowed := range do.Show.Values {
		if v, ok := fixed[key]; ok && !containsValue(allowed, v) {
			return false
		}
	}
	for key, blocked := range do.Hide.Values {
		if v, ok := fixed[key]; ok && containsValue(blocked, v) {
			return false
		}
	}
	return true
}

// conditionNote: "Only used when `sendTo` is `channel`." for conditions on arguments.
func conditionNote(do *DisplayOptions, fixed map[string]any, selectors map[string]bool) string {
	if do == nil {
		return ""
	}
	skip := func(key string) bool {
		_, inFixed := fixed[key]
		return inFixed || strings.HasPrefix(key, "/") || selectors[key]
	}
	var parts []string
	for _, key := range do.Show.Keys {
		if skip(key) {
			continue
		}
		parts = append(parts, "`"+key+"` is "+joinValues(do.Show.Values[key]))
	}
	for _, key := range do.Hide.Keys {
		if skip(key) {
			continue
		}
		parts = append(parts, "`"+key+"` is not "+joinValues(do.Hide.Values[key]))
	}
	if len(parts) == 0 {
		return ""
	}
	return "Only used when " + strings.Join(parts, " and ") + "."
}

func joinValues(values []any) string {
	parts := make([]string, len(values))
	for i, v := range values {
		parts[i] = "`" + stringOf(v) + "`"
	}
	return strings.Join(parts, " or ")
}

// ---------------------------------------------------------------------------
// Property → JSON Schema
// ---------------------------------------------------------------------------

type schemaContext struct {
	fixed     map[string]any
	dynamic   []DynamicOption
	path      []string
	selectors map[string]bool
}

// credentialSelectorsOf: the parameters a node's `credentials[].displayOptions` switch on, with the value each
// credential type needs, in order of first appearance.
func credentialSelectorsOf(node *NodeDescriptor) []CredentialSelector {
	var order []string
	byParameter := map[string]map[string]any{}
	for _, c := range node.Credentials {
		if c.DisplayOptions == nil {
			continue
		}
		for _, parameter := range c.DisplayOptions.Show.Keys {
			values := c.DisplayOptions.Show.Values[parameter]
			if len(values) == 0 {
				continue
			}
			entry, ok := byParameter[parameter]
			if !ok {
				entry = map[string]any{}
				byParameter[parameter] = entry
				order = append(order, parameter)
			}
			entry[c.Name] = values[0]
		}
	}
	out := []CredentialSelector{}
	for _, parameter := range order {
		out = append(out, CredentialSelector{Parameter: parameter, ByCredential: byParameter[parameter]})
	}
	return out
}

// joinText trims the parts, ends each with a period and joins them; "" when nothing is left.
func joinText(parts ...string) string {
	var out []string
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		if !strings.HasSuffix(p, ".") {
			p += "."
		}
		out = append(out, p)
	}
	return strings.Join(out, " ")
}

func enumOf(options []Option, several bool) (values []any, typ string, note string) {
	kinds := map[string]bool{}
	var names []string
	for _, o := range options {
		values = append(values, o.Value)
		kinds[jsType(o.Value)] = true
		label := "`" + stringOf(o.Value) + "` (" + o.Name
		if o.Description != nil && *o.Description != "" {
			label += ": " + *o.Description
		}
		names = append(names, label+")")
	}
	if len(kinds) == 1 {
		for k := range kinds {
			switch k {
			case "number", "boolean":
				typ = k
			default:
				typ = "string"
			}
		}
	}
	prefix := "One of"
	if several {
		prefix = "Any of"
	}
	return values, typ, prefix + ": " + strings.Join(names, ", ")
}

// objectSchema maps fields to `{ type: object, properties, required? }`; the second result lists the property names in order.
func objectSchema(fields []Property, ctx *schemaContext) (map[string]any, []string) {
	properties := map[string]any{}
	names := []string{}
	required := []any{}
	for i := range fields {
		field := &fields[i]
		if _, dup := properties[field.Name]; dup {
			continue
		}
		schema := propertyToJSONSchema(field, ctx)
		if schema == nil {
			continue
		}
		properties[field.Name] = schema
		names = append(names, field.Name)
		if field.Required {
			required = append(required, field.Name)
		}
	}
	out := map[string]any{"type": "object", "properties": properties}
	if len(required) > 0 {
		out["required"] = required
	}
	return out, names
}

// propertyToJSONSchema is the JSON Schema of one property as a tool argument, or nil for properties that are not
// arguments (notice, hidden, the discriminators, credential selectors, properties the fixed parameters hide).
func propertyToJSONSchema(p *Property, ctx *schemaContext) map[string]any {
	if p.Type == "notice" || p.Type == "hidden" {
		return nil
	}
	if len(ctx.path) == 0 {
		if _, fixed := ctx.fixed[p.Name]; fixed && (p.Name == "resource" || p.Name == "operation") {
			return nil
		}
		if ctx.selectors[p.Name] {
			return nil
		}
	}
	if !shownForSlot(p.DisplayOptions, ctx.fixed) {
		return nil
	}
	path := append(append([]string{}, ctx.path...), p.Name)
	base := map[string]any{"title": p.DisplayName}
	note := ""
	to := p.TypeOptions
	if to == nil {
		to = &TypeOptions{}
	}
	switch p.Type {
	case "string", "color":
		base["type"] = "string"
	case "code":
		base["type"] = "string"
		if to.Language != "" {
			note = to.Language + " code."
		} else {
			note = "Code."
		}
	case "dateTime":
		base["type"] = "string"
		base["format"] = "date-time"
	case "number":
		if to.NumberPrecision != nil && *to.NumberPrecision == 0 {
			base["type"] = "integer"
		} else {
			base["type"] = "number"
		}
		if to.MinValue != nil {
			base["minimum"] = *to.MinValue
		}
		if to.MaxValue != nil {
			base["maximum"] = *to.MaxValue
		}
	case "boolean":
		base["type"] = "boolean"
	case "json":
		base["type"] = []any{"object", "array", "string"}
		note = "A JSON value (an object or array, or JSON text)."
	case "options", "multiOptions":
		var item map[string]any
		if to.LoadOptionsMethod != "" {
			item = map[string]any{"type": "string"}
			note = "Values come from the connected account (a dynamic list); pass the id or value, not the label."
			d := DynamicOption{Parameter: strings.Join(path, "/"), Method: to.LoadOptionsMethod}
			if len(to.LoadOptionsDependsOn) > 0 {
				d.DependsOn = to.LoadOptionsDependsOn
			}
			ctx.dynamic = append(ctx.dynamic, d)
		} else if len(p.Options) > 0 {
			values, typ, enumNote := enumOf(p.Options, p.Type == "multiOptions")
			item = map[string]any{"enum": values}
			if typ != "" {
				item["type"] = typ
			}
			note = enumNote
		} else {
			item = map[string]any{"type": "string"}
		}
		if p.Type == "options" {
			for k, v := range item {
				base[k] = v
			}
		} else {
			base["type"] = "array"
			base["items"] = item
		}
	case "collection":
		sub := &schemaContext{fixed: ctx.fixed, path: path, selectors: ctx.selectors, dynamic: ctx.dynamic}
		nested, _ := objectSchema(p.Values, sub)
		ctx.dynamic = sub.dynamic
		for k, v := range nested {
			base[k] = v
		}
	case "fixedCollection":
		groups := map[string]any{}
		for _, g := range p.Groups {
			sub := &schemaContext{fixed: ctx.fixed, path: append(append([]string{}, path...), g.Name), selectors: ctx.selectors, dynamic: ctx.dynamic}
			nested, _ := objectSchema(g.Values, sub)
			ctx.dynamic = sub.dynamic
			schema := map[string]any{"title": g.DisplayName}
			for k, v := range nested {
				schema[k] = v
			}
			if to.MultipleValues {
				groups[g.Name] = map[string]any{"type": "array", "items": schema}
			} else {
				groups[g.Name] = schema
			}
		}
		base["type"] = "object"
		base["properties"] = groups
	}
	text := ""
	if p.Description != nil {
		text = *p.Description
	} else if p.Hint != nil {
		text = *p.Hint
	}
	if description := joinText(text, note, conditionNote(p.DisplayOptions, ctx.fixed, ctx.selectors)); description != "" {
		base["description"] = description
	}
	if len(p.Default) > 0 && string(p.Default) != "null" && p.Type != "collection" && p.Type != "fixedCollection" {
		var def any
		if err := json.Unmarshal(p.Default, &def); err == nil {
			base["default"] = def
		}
	}
	return base
}

// ---------------------------------------------------------------------------
// Annotations, titles, descriptions
// ---------------------------------------------------------------------------

func verbMatches(verb string, prefixes []string) bool {
	for _, prefix := range prefixes {
		if strings.HasPrefix(verb, prefix) {
			rest := verb[len(prefix):]
			if rest == "" || rest[0] < 'a' || rest[0] > 'z' {
				return true
			}
		}
	}
	return false
}

// deriveAnnotations: the hints derived from the operation name and `idempotent`, then the node's and the operation's overrides.
func deriveAnnotations(node *NodeDescriptor, slot operationSlot, title string) map[string]any {
	verb := node.Name
	if slot.operation != nil {
		verb = stringOf(slot.operation.Value)
	}
	readOnly := verbMatches(verb, readOnlyVerb)
	isDestructive := !readOnly && verbMatches(verb, destructive)
	idempotent := false
	if slot.operation != nil && slot.operation.Idempotent != nil {
		idempotent = *slot.operation.Idempotent
	} else if node.Idempotent != nil {
		idempotent = *node.Idempotent
	}
	out := map[string]any{"title": title, "readOnlyHint": readOnly, "destructiveHint": isDestructive, "idempotentHint": readOnly || idempotent, "openWorldHint": true}
	for k, v := range node.ToolAnnotations {
		out[k] = v
	}
	if slot.operation != nil {
		for k, v := range slot.operation.ToolAnnotations {
			out[k] = v
		}
	}
	return out
}

func toolTitle(node *NodeDescriptor, slot operationSlot) string {
	parts := []string{node.DisplayName}
	if slot.resource != nil && slot.resource.Name != "" {
		parts = append(parts, slot.resource.Name)
	}
	if slot.operation != nil && slot.operation.Name != "" {
		parts = append(parts, slot.operation.Name)
	}
	var kept []string
	for _, p := range parts {
		if p != "" {
			kept = append(kept, p)
		}
	}
	return strings.Join(kept, " · ")
}

func toolDescription(node *NodeDescriptor, slot operationSlot) string {
	what := ""
	switch {
	case slot.operation != nil:
		op := slot.operation
		switch {
		case op.Action != nil:
			what = *op.Action
		case op.Description != nil:
			what = *op.Description
		case slot.resource != nil:
			what = op.Name + " (" + strings.ToLower(slot.resource.Name) + ")"
		default:
			what = op.Name
		}
	case slot.resource != nil:
		what = slot.resource.Name
		if slot.resource.Description != nil && *slot.resource.Description != "" {
			what += ": " + *slot.resource.Description
		}
	}
	about := ""
	if node.ToolDescription != nil {
		about = *node.ToolDescription
	} else if node.Description != nil {
		about = *node.Description
	}
	if text := joinText(what, about); text != "" {
		return text
	}
	return node.DisplayName
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func defaultVersionOf(node *NodeDescriptor) int {
	if node.DefaultVersion != nil {
		return *node.DefaultVersion
	}
	var single int
	if err := json.Unmarshal(node.Version, &single); err == nil {
		return single
	}
	var many []int
	_ = json.Unmarshal(node.Version, &many)
	best := 0
	for _, v := range many {
		if v > best {
			best = v
		}
	}
	return best
}

func ptr[T any](v T) *T { return &v }

// jsType is JavaScript's typeof for a decoded JSON value.
func jsType(v any) string {
	switch v.(type) {
	case float64, int, int64, json.Number:
		return "number"
	case bool:
		return "boolean"
	case string:
		return "string"
	case nil:
		return "object"
	default:
		return "object"
	}
}

// stringOf is JavaScript's String() for a decoded JSON primitive.
func stringOf(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case int:
		return strconv.Itoa(t)
	case int64:
		return strconv.FormatInt(t, 10)
	case json.Number:
		return t.String()
	case bool:
		return strconv.FormatBool(t)
	case nil:
		return "null"
	default:
		data, _ := json.Marshal(t)
		return string(data)
	}
}

// containsValue is Array.prototype.includes for decoded JSON primitives (numbers compare as float64).
func containsValue(values []any, v any) bool {
	for _, candidate := range values {
		if primitiveEqual(candidate, v) {
			return true
		}
	}
	return false
}

func primitiveEqual(a, b any) bool {
	if fa, ok := toFloat(a); ok {
		fb, ok := toFloat(b)
		return ok && fa == fb
	}
	return jsType(a) == jsType(b) && a == b
}

func toFloat(v any) (float64, bool) {
	switch t := v.(type) {
	case float64:
		return t, true
	case int:
		return float64(t), true
	case int64:
		return float64(t), true
	case json.Number:
		f, err := t.Float64()
		return f, err == nil
	}
	return 0, false
}
