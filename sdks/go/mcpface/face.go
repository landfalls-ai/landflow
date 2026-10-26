package mcpface

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"sync"

	"github.com/google/uuid"
	"github.com/landflow/landflow/sdks/go/transport"
	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// ListOptionsTool is the read-only tool that resolves dynamic options (LoadOptions) for another tool's parameter.
const ListOptionsTool = "list_options"

// maxBodyBytes bounds /mcp request bodies like the HTTP face (item batches can be large).
const maxBodyBytes = 64 << 20

// FaceOptions tunes New.
type FaceOptions struct {
	// Credentials by local credential type name (LoadCredentials). Default: LoadCredentialsFromEnv.
	Credentials Credentials
	// Token is required as `Authorization: Bearer` on the HTTP handler unless Loopback; stdio needs none.
	Token string
	// Loopback says the HTTP server listens on loopback only, so no token is needed.
	Loopback bool
	// Realm is reported in the 401 challenge (default landflow-plugin).
	Realm string
	// Logger receives the go-sdk's and the face's log lines (default: warnings and errors to stderr).
	Logger *slog.Logger
	// Mapping options.
	Mapping Options
}

// Face is the MCP face of one plugin: its tools, a server factory and the token-checking HTTP handler.
type Face struct {
	manifest *Manifest
	dispatch transport.Dispatcher
	opts     FaceOptions
	defs     []*Tool
	tools    []*mcp.Tool
	runtimes map[string]*Tool
	dynamic  bool
	logger   *slog.Logger

	once    sync.Once
	handler *mcp.StreamableHTTPHandler
}

type toolNameKey struct{}

// WithToolName records the tool a dispatched call belongs to; the SDK reads it with ToolNameOf for the `mcp.tool.name` span attribute.
func WithToolName(ctx context.Context, name string) context.Context {
	return context.WithValue(ctx, toolNameKey{}, name)
}

// ToolNameOf returns the tool name WithToolName recorded, or "".
func ToolNameOf(ctx context.Context) string {
	name, _ := ctx.Value(toolNameKey{}).(string)
	return name
}

// New builds the face over a manifest (any form ParseManifest accepts) and a dispatcher (the contract of
// sdks/go/transport: Execute and LoadOptions bodies in, results out). The SDK passes its in-process dispatcher;
// landflow-bridge passes one that forwards to the plugin.
func New(manifest any, dispatch transport.Dispatcher, opts ...FaceOptions) (*Face, error) {
	m, err := ParseManifest(manifest)
	if err != nil {
		return nil, err
	}
	if dispatch == nil {
		return nil, errors.New("mcpface: New needs a dispatcher")
	}
	var o FaceOptions
	if len(opts) > 0 {
		o = opts[0]
	}
	if o.Credentials == nil {
		if o.Credentials, err = LoadCredentialsFromEnv(); err != nil {
			return nil, err
		}
	}
	if o.Logger == nil {
		o.Logger = slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))
	}
	if o.Realm == "" {
		o.Realm = "landflow-plugin"
	}
	f := &Face{manifest: m, dispatch: dispatch, opts: o, logger: o.Logger, runtimes: map[string]*Tool{}, tools: []*mcp.Tool{}}
	f.defs = ToolsFromDescriptors(m.Plugin.ID, m.Nodes, o.Mapping)
	for _, d := range f.defs {
		f.runtimes[d.Name] = d
		f.tools = append(f.tools, toMCPTool(d))
		if len(d.Binding().DynamicOptions) > 0 {
			f.dynamic = true
		}
	}
	f.dynamic = f.dynamic && len(o.Credentials) > 0
	if f.dynamic && f.runtimes[ListOptionsTool] == nil {
		f.tools = append(f.tools, f.listOptionsTool())
	}
	return f, nil
}

// Manifest returns the parsed manifest.
func (f *Face) Manifest() *Manifest { return f.manifest }

// Definitions are the mapped tools with their bindings.
func (f *Face) Definitions() []*Tool { return f.defs }

// Tools are the tools as `tools/list` returns them (without `_meta`), in manifest order.
func (f *Face) Tools() []*mcp.Tool { return f.tools }

// toMCPTool converts a definition to the go-sdk's Tool without its binding.
func toMCPTool(d *Tool) *mcp.Tool {
	a := &mcp.ToolAnnotations{}
	if v, ok := d.Annotations["title"].(string); ok {
		a.Title = v
	}
	if v, ok := d.Annotations["readOnlyHint"].(bool); ok {
		a.ReadOnlyHint = v
	}
	if v, ok := d.Annotations["idempotentHint"].(bool); ok {
		a.IdempotentHint = v
	}
	if v, ok := d.Annotations["destructiveHint"].(bool); ok {
		a.DestructiveHint = &v
	}
	if v, ok := d.Annotations["openWorldHint"].(bool); ok {
		a.OpenWorldHint = &v
	}
	t := &mcp.Tool{Name: d.Name, Title: d.Title, Description: d.Description, InputSchema: d.InputSchema, Annotations: a}
	if d.OutputSchema != nil {
		t.OutputSchema = d.OutputSchema
	}
	return t
}

func (f *Face) listOptionsTool() *mcp.Tool {
	var names []any
	for _, d := range f.defs {
		if len(d.Binding().DynamicOptions) > 0 {
			names = append(names, d.Name)
		}
	}
	tr, fa := true, false
	return &mcp.Tool{
		Name: ListOptionsTool, Title: "List options",
		Description: "The values a tool argument with a dynamic list accepts (resolved with the configured credential): pass the tool name, the parameter and, when the list depends on other arguments, those arguments.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"tool":      map[string]any{"type": "string", "description": "The tool whose argument has a dynamic list.", "enum": names},
				"parameter": map[string]any{"type": "string", "description": "The argument (a path like `channel` or `options/labels`)."},
				"arguments": map[string]any{"type": "object", "description": "Other arguments the list depends on."},
			},
			"required": []any{"tool", "parameter"},
		},
		OutputSchema: map[string]any{"type": "object", "properties": map[string]any{"options": map[string]any{"type": "array", "items": map[string]any{"type": "object", "properties": map[string]any{"name": map[string]any{"type": "string"}, "value": map[string]any{}}, "required": []any{"name", "value"}}}}, "required": []any{"options"}},
		Annotations:  &mcp.ToolAnnotations{Title: "List options", ReadOnlyHint: true, DestructiveHint: &fa, IdempotentHint: true, OpenWorldHint: &tr},
	}
}

// NewServer builds a fresh MCP server (one per HTTP request or stdio session): every tool is registered with the
// go-sdk (so tools/call gets its era-specific result shape), tools/list is answered in manifest order from the
// mapping, and everything else is the go-sdk's (server/discover, initialize, ping).
func (f *Face) NewServer() *mcp.Server {
	server := mcp.NewServer(&mcp.Implementation{Name: f.manifest.Plugin.ID, Title: f.manifest.Plugin.Name, Version: f.manifest.Plugin.Version}, &mcp.ServerOptions{
		Instructions: f.manifest.Plugin.Description, HasTools: true, Logger: f.logger,
		SetCacheable: func(_ context.Context, _ mcp.Request, c *mcp.Cacheable) { c.TTLMs, c.CacheScope = 0, "private" },
	})
	for _, tool := range f.tools {
		server.AddTool(tool, f.callTool)
	}
	server.AddReceivingMiddleware(f.middleware)
	return server
}

// middleware answers tools/list from the mapping (manifest order; the go-sdk would sort by name).
func (f *Face) middleware(next mcp.MethodHandler) mcp.MethodHandler {
	return func(ctx context.Context, method string, req mcp.Request) (mcp.Result, error) {
		if method == "tools/list" {
			return &mcp.ListToolsResult{Tools: f.tools, Cacheable: mcp.Cacheable{TTLMs: 0, CacheScope: "private"}}, nil
		}
		return next(ctx, method, req)
	}
}

func invalidParams(msg string) error {
	return &jsonrpc.Error{Code: jsonrpc.CodeInvalidParams, Message: msg}
}

func text(s string) *mcp.CallToolResult {
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: s}}}
}

func toolError(msg string) *mcp.CallToolResult {
	r := text(msg)
	r.IsError = true
	return r
}

// callTool runs one tools/call: the arguments become node parameters, the configured credentials are bound, and
// the dispatcher's Execute runs with the request's context (closing the stream cancels it).
func (f *Face) callTool(ctx context.Context, call *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	var args map[string]any
	if len(call.Params.Arguments) > 0 && string(call.Params.Arguments) != "null" {
		if err := json.Unmarshal(call.Params.Arguments, &args); err != nil {
			return nil, invalidParams(`"arguments" must be an object`)
		}
	}
	name := call.Params.Name
	if name == ListOptionsTool && f.dynamic {
		return f.listOptions(ctx, call, args)
	}
	def := f.runtimes[name]
	if def == nil {
		return nil, invalidParams(fmt.Sprintf("unknown tool %q", name))
	}
	mapping := ToolCallToParameters(def, args)
	credentials, selectors, missing := f.bindCredentials(def)
	if missing != "" {
		return toolError(missing), nil
	}
	parameters := map[string]any{}
	for k, v := range selectors {
		parameters[k] = v
	}
	for k, v := range mapping.Parameters {
		parameters[k] = v
	}
	if args == nil {
		args = map[string]any{}
	}
	node := f.node(def.Binding().NodeName)
	nodeName := def.Title
	if node != nil {
		nodeName = node.DisplayName
	}
	request := map[string]any{
		"protocol": f.manifest.Protocol, "executionId": "mcp_" + uuid.NewString(), "mode": "mcp",
		"node":       map[string]any{"id": "mcp-" + def.Name, "name": nodeName, "type": mapping.NodeType, "typeVersion": mapping.TypeVersion},
		"parameters": parameters, "itemParameters": []any{parameters}, "inputs": []any{[]any{map[string]any{"json": args}}},
	}
	if len(credentials) > 0 {
		request["credentials"] = credentials
	}
	if request["protocol"] == "" {
		request["protocol"] = "landflow.plugin/v1"
	}
	body, _ := json.Marshal(request)
	result, err := f.dispatch(WithToolName(ctx, def.Name), transport.MethodExecute, body, dispatchContext(call, transport.MethodExecute))
	if err != nil {
		return nil, mapDispatchError(err)
	}
	var response struct {
		Outputs [][]struct {
			JSON map[string]any `json:"json"`
		} `json:"outputs"`
		Error *struct {
			Message     string `json:"message"`
			Description string `json:"description"`
		} `json:"error"`
	}
	if err := remarshal(result, &response); err != nil {
		return nil, fmt.Errorf("mcpface: decode execute response: %w", err)
	}
	if response.Error != nil {
		msg := response.Error.Message
		if response.Error.Description != "" {
			msg += "\n" + response.Error.Description
		}
		return toolError(msg), nil
	}
	items := []any{}
	if len(response.Outputs) > 0 {
		for _, item := range response.Outputs[0] {
			if item.JSON == nil {
				item.JSON = map[string]any{}
			}
			items = append(items, item.JSON)
		}
	}
	note := ""
	if len(mapping.Ignored) > 0 {
		note = " (arguments outside this tool's schema, passed only as input item fields: " + strings.Join(mapping.Ignored, ", ") + ")"
	}
	summary := fmt.Sprintf("%d items", len(items))
	if len(items) == 1 {
		data, _ := json.Marshal(items[0])
		summary = string(data)
	}
	out := text(summary + note)
	out.StructuredContent = map[string]any{"items": items}
	return out, nil
}

// listOptions answers the list_options tool with the dispatcher's LoadOptions.
func (f *Face) listOptions(ctx context.Context, call *mcp.CallToolRequest, args map[string]any) (*mcp.CallToolResult, error) {
	toolName, _ := args["tool"].(string)
	parameter, _ := args["parameter"].(string)
	if toolName == "" || parameter == "" {
		return nil, invalidParams(ListOptionsTool + ` needs "tool" and "parameter"`)
	}
	def := f.runtimes[toolName]
	if def == nil {
		return nil, invalidParams(fmt.Sprintf("unknown tool %q", toolName))
	}
	b := def.Binding()
	var option *DynamicOption
	for i := range b.DynamicOptions {
		if b.DynamicOptions[i].Parameter == parameter {
			option = &b.DynamicOptions[i]
		}
	}
	if option == nil {
		return nil, invalidParams(fmt.Sprintf("%q of %s has no dynamic options", parameter, toolName))
	}
	nested, _ := args["arguments"].(map[string]any)
	mapping := ToolCallToParameters(def, nested)
	credentials, selectors, missing := f.bindCredentials(def)
	if missing != "" {
		return toolError(missing), nil
	}
	parameters := map[string]any{}
	for k, v := range selectors {
		parameters[k] = v
	}
	for k, v := range mapping.Parameters {
		parameters[k] = v
	}
	request := map[string]any{"nodeType": b.NodeType, "method": option.Method, "parameters": parameters}
	if len(credentials) > 0 {
		request["credentials"] = credentials
	}
	body, _ := json.Marshal(request)
	result, err := f.dispatch(WithToolName(ctx, ListOptionsTool), transport.MethodLoadOptions, body, dispatchContext(call, transport.MethodLoadOptions))
	if err != nil {
		var de *transport.DispatchError
		if errors.As(err, &de) && de.Code != transport.CodeCapacity {
			return nil, mapDispatchError(err)
		}
		return toolError(err.Error()), nil
	}
	var response struct {
		Options []map[string]any `json:"options"`
	}
	if err := remarshal(result, &response); err != nil {
		return nil, fmt.Errorf("mcpface: decode load-options response: %w", err)
	}
	if response.Options == nil {
		response.Options = []map[string]any{}
	}
	out := text(fmt.Sprintf("%d option%s", len(response.Options), plural(len(response.Options))))
	out.StructuredContent = map[string]any{"options": response.Options}
	return out, nil
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

// bindCredentials picks the configured credentials a node call gets and the selector parameters that choose them;
// a node whose credentials are all unconfigured gets a message naming the missing types when any is required.
func (f *Face) bindCredentials(def *Tool) (credentials map[string]any, selectors map[string]any, missing string) {
	node := f.node(def.Binding().NodeName)
	selectors = map[string]any{}
	if node == nil || len(node.Credentials) == 0 {
		return nil, selectors, ""
	}
	credentials = map[string]any{}
	b := def.Binding()
	required := false
	for _, c := range node.Credentials {
		required = required || c.Required
		value, ok := f.opts.Credentials[c.Name]
		if !ok {
			continue
		}
		credentials[c.Name] = value
		for _, s := range b.CredentialSelectors {
			if v, has := s.ByCredential[c.Name]; has {
				if _, set := selectors[s.Parameter]; !set {
					selectors[s.Parameter] = v
				}
			}
		}
	}
	if len(credentials) == 0 && required {
		var names []string
		for _, c := range node.Credentials {
			names = append(names, f.describeCredential(c.Name))
		}
		return nil, selectors, fmt.Sprintf("This tool needs a credential that is not configured: %s. Set %s to a JSON file or inline JSON { \"<credentialType>\": { …fields } }.", strings.Join(names, " or "), CredentialsEnv)
	}
	if len(credentials) == 0 {
		credentials = nil
	}
	return credentials, selectors, ""
}

func (f *Face) describeCredential(typ string) string {
	for _, c := range f.manifest.CredentialTypes {
		if c.Name != typ {
			continue
		}
		var fields []string
		for _, p := range c.Properties {
			fields = append(fields, p.Name)
		}
		if len(fields) > 0 {
			return typ + " (fields: " + strings.Join(fields, ", ") + ")"
		}
	}
	return typ
}

func (f *Face) node(name string) *NodeDescriptor {
	for i := range f.manifest.Nodes {
		if f.manifest.Nodes[i].Name == name {
			return &f.manifest.Nodes[i]
		}
	}
	return nil
}

// dispatchContext carries the call's trace context: `_meta.traceparent` (the MCP convention), else the HTTP headers.
func dispatchContext(call *mcp.CallToolRequest, method transport.Method) transport.DispatchContext {
	dc := transport.DispatchContext{CallID: uuid.NewString(), Method: method, Attempt: 1, Delivery: transport.AtMostOnce}
	if tp, ok := call.Params.Meta["traceparent"].(string); ok && tp != "" {
		dc.TraceParent = tp
		dc.TraceState, _ = call.Params.Meta["tracestate"].(string)
	} else if call.Extra != nil && call.Extra.Header != nil {
		dc.TraceParent = call.Extra.Header.Get("traceparent")
		dc.TraceState = call.Extra.Header.Get("tracestate")
	}
	return dc
}

// mapDispatchError turns a dispatcher failure into what the client sees: an unknown node or a bad body is invalid
// params (-32602); a capacity refusal is a tool error the agent may retry; anything else is an internal error.
func mapDispatchError(err error) error {
	var de *transport.DispatchError
	if errors.As(err, &de) {
		switch de.Code {
		case transport.CodeNotFound, transport.CodeBadRequest:
			return invalidParams(de.Message)
		case transport.CodeCapacity:
			return &capacityError{msg: de.Message}
		}
	}
	return err
}

// capacityError is answered as a tool error (not a protocol error) so the agent can try again shortly.
type capacityError struct{ msg string }

func (e *capacityError) Error() string { return e.msg + "; try again shortly" }

func remarshal(from any, to any) error {
	data, err := json.Marshal(from)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, to)
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

// Handler is the Streamable HTTP entry (stateless; 2026-07-28 natively and 2025-era clients per request, from the
// go-sdk) with the Bearer token check in front unless Loopback.
func (f *Face) Handler() http.Handler {
	f.once.Do(func() {
		f.handler = mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return f.NewServer() }, &mcp.StreamableHTTPOptions{
			Stateless: true, JSONResponse: true, DisableLocalhostProtection: true, PropagateRequestCancellation: true, MaxRequestBodyBytes: maxBodyBytes, Logger: f.logger,
		})
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !f.opts.Loopback {
			if f.opts.Token == "" {
				writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "MCP is not configured with a token"})
				return
			}
			if !BearerTokenMatches(r.Header.Get("Authorization"), f.opts.Token) {
				w.Header().Set("WWW-Authenticate", `Bearer realm="`+f.opts.Realm+`"`)
				writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
				return
			}
		}
		f.handler.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	data, _ := json.Marshal(v)
	_, _ = w.Write(data)
}

// ServeStdio speaks MCP on stdin/stdout until the client goes away or ctx ends (both eras; no token). The caller must
// keep stdout for MCP: logs go to stderr.
func (f *Face) ServeStdio(ctx context.Context) error {
	return f.NewServer().Run(ctx, &mcp.StdioTransport{})
}

// ServeTransport is ServeStdio over any go-sdk transport (for tests: mcp.NewInMemoryTransports).
func (f *Face) ServeTransport(ctx context.Context, t mcp.Transport) error {
	return f.NewServer().Run(ctx, t)
}
