package landflow

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/url"
	"strings"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

// App webhook triggers (docs/protocol.md §12): a trigger with TriggerSource
// TriggerAppWebhook registers its own webhook with an external service when
// the workflow is published and removes it when it is unpublished, like n8n's
// webhookMethods. Implement WebhookNode (and optionally WebhookChecker):
//
//	func (repoTrigger) WebhookCreate(ctx *landflow.WebhookContext) error {
//		hook, err := api.CreateHook(ctx, ctx.WebhookURL())
//		if err != nil {
//			return err
//		}
//		ctx.StaticData()["hookId"] = hook.ID
//		return nil
//	}
//
//	func (repoTrigger) Webhook(ctx *landflow.WebhookContext) (*landflow.WebhookResult, error) {
//		if !landflow.VerifyGitHubSignature(secret, ctx.RawBody(), ctx.Header("X-Hub-Signature-256")) {
//			return &landflow.WebhookResult{Response: &landflow.WebhookReply{Status: 401}}, nil
//		}
//		return &landflow.WebhookResult{Items: []landflow.Item{{JSON: ctx.BodyObject()}}, IdempotencyKey: ctx.Header("X-GitHub-Delivery")}, nil
//	}
//
// The host keeps the static data per workflow and node; changes made to
// ctx.StaticData() (or SetStaticData) go back with the response.

// WebhookNode is implemented by app webhook triggers.
type WebhookNode interface {
	Node
	// WebhookCreate registers ctx.WebhookURL() at the service and stores what
	// WebhookDelete needs in ctx.StaticData().
	WebhookCreate(ctx *WebhookContext) error
	// WebhookDelete removes the webhook (one that is already gone is not an error).
	WebhookDelete(ctx *WebhookContext) error
	// Webhook turns a call to the webhook URL into items for a run (none: no
	// run) and an optional reply.
	Webhook(ctx *WebhookContext) (*WebhookResult, error)
}

// WebhookChecker is optionally implemented by app webhook triggers: is the
// webhook in the static data still registered? Without it the host always
// calls WebhookCreate.
type WebhookChecker interface {
	WebhookCheckExists(ctx *WebhookContext) (bool, error)
}

// WebhookMethodName is checkExists | create | delete.
type WebhookMethodName string

const (
	WebhookMethodCheckExists WebhookMethodName = "checkExists"
	WebhookMethodCreate      WebhookMethodName = "create"
	WebhookMethodDelete      WebhookMethodName = "delete"
)

// WebhookMethodRequest is the body of POST /landflow/v1/webhook-method.
type WebhookMethodRequest struct {
	Protocol   string            `json:"protocol"`
	Method     WebhookMethodName `json:"method"`
	WorkflowID string            `json:"workflowId"`
	Node       NodeRef           `json:"node"`
	// Parameters are resolved without items.
	Parameters  map[string]any `json:"parameters"`
	Credentials map[string]any `json:"credentials,omitempty"`
	// WebhookURL is where the service must call: {publicUrl}/api/webhook/app/<workflowId>/<nodeId>.
	WebhookURL string `json:"webhookUrl"`
	// StaticData is what the node stored so far ({} at first).
	StaticData map[string]any `json:"staticData"`
}

// WebhookMethodResponse answers a WebhookMethodRequest. Over gRPC an Exists
// of false is indistinguishable from absent; hosts treat anything but true as
// not registered.
type WebhookMethodResponse struct {
	Exists bool `json:"exists,omitempty"`
	// StaticData is the node's static data after the call; nil = unchanged.
	StaticData map[string]any    `json:"staticData,omitzero"`
	Logs       []LogEntry        `json:"logs,omitempty"`
	Error      *NodeErrorPayload `json:"error,omitempty"`
}

// IncomingWebhookRequest is a call the service made to the webhook URL.
type IncomingWebhookRequest struct {
	Method string `json:"method"`
	Path   string `json:"path"`
	// Headers have lower-case names.
	Headers map[string]string `json:"headers"`
	Query   map[string]string `json:"query"`
	// Body is the raw body exactly as sent (base64 in JSON, bytes over gRPC).
	Body []byte `json:"body"`
}

// WebhookRequest is the body of POST /landflow/v1/webhook.
type WebhookRequest struct {
	Protocol    string                 `json:"protocol"`
	WorkflowID  string                 `json:"workflowId"`
	Node        NodeRef                `json:"node"`
	Parameters  map[string]any         `json:"parameters"`
	Credentials map[string]any         `json:"credentials,omitempty"`
	WebhookURL  string                 `json:"webhookUrl"`
	StaticData  map[string]any         `json:"staticData"`
	Request     IncomingWebhookRequest `json:"request"`
}

// WebhookReply is what the service gets back (status 0 = 200).
type WebhookReply struct {
	Status  int               `json:"status,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
	Body    string            `json:"body,omitempty"`
}

// JSONReply is a WebhookReply with a JSON body.
func JSONReply(status int, v any) *WebhookReply {
	data, err := json.Marshal(v)
	if err != nil {
		data = []byte("null")
	}
	return &WebhookReply{Status: status, Headers: map[string]string{"content-type": "application/json; charset=utf-8"}, Body: string(data)}
}

// WebhookResult is what Webhook returns: Items start a run (none: no run),
// Response is the reply, IdempotencyKey identifies the event (GitHub's
// X-GitHub-Delivery) so a redelivery starts no second run.
type WebhookResult struct {
	Items          []Item
	Response       *WebhookReply
	IdempotencyKey string
}

// WebhookResponse answers a WebhookRequest.
type WebhookResponse struct {
	Items          []Item            `json:"items,omitempty"`
	Response       *WebhookReply     `json:"response,omitempty"`
	StaticData     map[string]any    `json:"staticData,omitzero"`
	IdempotencyKey string            `json:"idempotencyKey,omitempty"`
	Logs           []LogEntry        `json:"logs,omitempty"`
	Error          *NodeErrorPayload `json:"error,omitempty"`
}

// WebhookContext is what WebhookCheckExists, WebhookCreate, WebhookDelete
// and Webhook see. Like ExecuteContext it is a context.Context (pass it to
// landflow.HTTPClient) and offers Credentials, Span and Metrics.
type WebhookContext struct {
	callScope
	// Logger collects log lines into the response's logs.
	Logger *Logger

	method      WebhookMethodName
	workflowID  string
	node        NodeRef
	parameters  map[string]any
	webhookURL  string
	descriptor  *NodeDescriptor
	staticData  map[string]any
	initial     []byte
	incoming    *IncomingWebhookRequest
	headers     map[string]string
	body        any
	bodyDecoded bool
}

func newWebhookContext(ctx context.Context, descriptor *NodeDescriptor, workflowID string, node NodeRef, params, creds, static map[string]any, webhookURL string) *WebhookContext {
	if params == nil {
		params = map[string]any{}
	}
	if static == nil {
		static = map[string]any{}
	}
	initial, _ := json.Marshal(static)
	copied := map[string]any{}
	_ = json.Unmarshal(initial, &copied)
	return &WebhookContext{
		callScope: callScope{ctx: ctx, creds: creds}, Logger: &Logger{},
		workflowID: workflowID, node: node, parameters: params, webhookURL: webhookURL, descriptor: descriptor,
		staticData: copied, initial: initial,
	}
}

// Method is the webhook method being run ("" in Webhook).
func (c *WebhookContext) Method() WebhookMethodName { return c.method }

// WorkflowID is the workflow the trigger belongs to.
func (c *WebhookContext) WorkflowID() string { return c.workflowID }

// Node is the trigger node.
func (c *WebhookContext) Node() NodeRef { return c.node }

// WebhookURL is where the service must send its calls: {publicUrl}/api/webhook/app/<workflowId>/<nodeId>.
func (c *WebhookContext) WebhookURL() string { return c.webhookURL }

// Param returns parameter name, falling back to the property's default.
func (c *WebhookContext) Param(name string) any {
	if v, ok := c.parameters[name]; ok && v != nil {
		return v
	}
	values := map[string]any{}
	for _, p := range c.descriptor.Properties {
		if p.Default != nil {
			if _, set := values[p.Name]; !set {
				values[p.Name] = p.Default
			}
		}
	}
	for k, v := range c.parameters {
		values[k] = v
	}
	for _, p := range c.descriptor.Properties {
		if p.Name == name && p.Default != nil && isVisible(p.DisplayOptions, values) {
			return p.Default
		}
	}
	for _, p := range c.descriptor.Properties {
		if p.Name == name && p.Default != nil {
			return p.Default
		}
	}
	return nil
}

// ParamString returns Param(name) as a string, or def when unset.
func (c *WebhookContext) ParamString(name, def string) string {
	if v := c.Param(name); v != nil {
		return Stringify(v)
	}
	return def
}

// StaticData is the node's static data for this workflow (a webhook id, a
// signing secret). Change it in place; the host stores it.
func (c *WebhookContext) StaticData() map[string]any { return c.staticData }

// SetStaticData replaces the static data.
func (c *WebhookContext) SetStaticData(data map[string]any) {
	if data == nil {
		data = map[string]any{}
	}
	c.staticData = data
}

func (c *WebhookContext) changedStaticData() map[string]any {
	now, err := json.Marshal(c.staticData)
	if err != nil || bytes.Equal(now, c.initial) {
		return nil
	}
	return c.staticData
}

// Request is the incoming call (nil outside Webhook).
func (c *WebhookContext) Request() *IncomingWebhookRequest { return c.incoming }

// Header returns a request header (case-insensitive; "" when absent or outside Webhook).
func (c *WebhookContext) Header(name string) string { return c.headers[strings.ToLower(name)] }

// RawBody is the body exactly as sent (what signatures cover).
func (c *WebhookContext) RawBody() []byte {
	if c.incoming == nil {
		return nil
	}
	return c.incoming.Body
}

// Body is the body decoded: JSON, a form-urlencoded body as map[string]any
// (a JSON "payload" field is decoded), else the text; empty: an empty object.
func (c *WebhookContext) Body() any {
	if !c.bodyDecoded {
		c.body, c.bodyDecoded = parseWebhookBody(c.RawBody(), c.Header("content-type")), true
	}
	return c.body
}

// BodyObject is Body when it is a JSON object, else {"body": Body()}.
func (c *WebhookContext) BodyObject() map[string]any {
	if m, ok := c.Body().(map[string]any); ok {
		return m
	}
	return map[string]any{"body": c.Body()}
}

func parseWebhookBody(raw []byte, contentType string) any {
	text := string(raw)
	if strings.TrimSpace(text) == "" {
		return map[string]any{}
	}
	trimmed := strings.TrimSpace(text)
	looksJSON := strings.HasPrefix(trimmed, "{") || strings.HasPrefix(trimmed, "[")
	lower := strings.ToLower(contentType)
	if strings.Contains(lower, "json") || (contentType == "" && looksJSON) {
		var v any
		if json.Unmarshal(raw, &v) == nil {
			return v
		}
		return text
	}
	if strings.Contains(lower, "application/x-www-form-urlencoded") {
		values, err := url.ParseQuery(text)
		if err != nil {
			return text
		}
		form := map[string]any{}
		for k, v := range values {
			form[k] = v[0]
		}
		if payload, ok := form["payload"].(string); ok {
			var v any
			if p := strings.TrimSpace(payload); (strings.HasPrefix(p, "{") || strings.HasPrefix(p, "[")) && json.Unmarshal([]byte(p), &v) == nil {
				return v
			}
		}
		return form
	}
	return text
}

// ---------------------------------------------------------------------------
// Plugin dispatch
// ---------------------------------------------------------------------------

func (p *Plugin) webhookNode(nodeType string) (*registeredNode, WebhookNode, *NodeErrorPayload, error) {
	rn, err := p.find(nodeType)
	if err != nil {
		return nil, nil, nil, err
	}
	wn, ok := rn.node.(WebhookNode)
	if !ok || rn.descriptor.TriggerSource != TriggerAppWebhook {
		return rn, nil, &NodeErrorPayload{Message: fmt.Sprintf("Node %q is not an app webhook trigger", rn.descriptor.Name)}, nil
	}
	return rn, wn, nil, nil
}

func (p *Plugin) startWebhookSpan(ctx context.Context, name string, rn *registeredNode, workflowID string, node NodeRef, creds map[string]any, attrs ...attribute.KeyValue) (context.Context, trace.Span, *scope) {
	if ctx == nil {
		ctx = context.Background()
	}
	tel := p.tel()
	nodeType := p.qualified(rn.descriptor.Name)
	sc := &scope{tel: tel, redact: newRedactor(creds, p.credTypes), nodeType: nodeType, workflowID: workflowID}
	attrs = append([]attribute.KeyValue{
		attribute.String("landflow.plugin.id", p.info.ID),
		attribute.String("landflow.node.type", nodeType),
		attribute.String("landflow.node.name", node.Name),
		attribute.String("landflow.workflow.id", workflowID),
	}, attrs...)
	ctx, span := tel.tracer.Start(withScope(ctx, sc), name, trace.WithSpanKind(trace.SpanKindServer), trace.WithAttributes(attrs...), trace.WithAttributes(callAttrs(ctx)...))
	return ctx, span, sc
}

func (p *Plugin) webhookLogger(ctx context.Context, sc *scope, workflowID string) *Logger {
	return newSinkLogger(&logSink{ctx: ctx, handler: sc.tel.logHandler, redact: sc.redact, attrs: []slog.Attr{
		slog.String("landflow.node.type", sc.nodeType), slog.String("landflow.workflow.id", workflowID),
	}})
}

// WebhookMethod runs checkExists, create or delete of an app webhook trigger
// inside a "plugin.webhook_method {method}" server span. The only errors
// returned are wrapped ErrBadRequest / ErrUnknownNode; node failures
// (including panics) come back in the response.
func (p *Plugin) WebhookMethod(ctx context.Context, req *WebhookMethodRequest) (*WebhookMethodResponse, error) {
	if req == nil {
		return nil, fmt.Errorf("%w: empty request", ErrBadRequest)
	}
	if req.Protocol != "" && req.Protocol != ProtocolVersion {
		return nil, fmt.Errorf("%w: unsupported protocol %q (want %q)", ErrBadRequest, req.Protocol, ProtocolVersion)
	}
	if req.Node.Type == "" {
		return nil, fmt.Errorf("%w: node.type is required", ErrBadRequest)
	}
	switch req.Method {
	case WebhookMethodCheckExists, WebhookMethodCreate, WebhookMethodDelete:
	default:
		return nil, fmt.Errorf("%w: method must be checkExists, create or delete, got %q", ErrBadRequest, req.Method)
	}
	rn, wn, notTrigger, err := p.webhookNode(req.Node.Type)
	if err != nil {
		return nil, err
	}
	if notTrigger != nil {
		return &WebhookMethodResponse{Error: notTrigger}, nil
	}
	ctx, span, sc := p.startWebhookSpan(ctx, "plugin.webhook_method "+string(req.Method), rn, req.WorkflowID, req.Node, req.Credentials,
		attribute.String("landflow.webhook.method", string(req.Method)))
	defer span.End()

	wc := newWebhookContext(ctx, &rn.descriptor, req.WorkflowID, req.Node, req.Parameters, req.Credentials, req.StaticData, req.WebhookURL)
	wc.method = req.Method
	wc.Logger = p.webhookLogger(ctx, sc, req.WorkflowID)
	resp := &WebhookMethodResponse{}
	err = p.safeWebhook(ctx, rn, func() error {
		switch req.Method {
		case WebhookMethodCheckExists:
			checker, ok := wn.(WebhookChecker)
			if !ok {
				return nil
			}
			exists, err := checker.WebhookCheckExists(wc)
			resp.Exists = exists && err == nil
			return err
		case WebhookMethodCreate:
			return wn.WebhookCreate(wc)
		default:
			return wn.WebhookDelete(wc)
		}
	})
	if err != nil {
		resp.Error = errorPayload(err)
		resp.Error.Message = sc.redact.str(resp.Error.Message)
		resp.Error.Description = sc.redact.str(resp.Error.Description)
		recordError(span, resp.Error.Message, err)
	} else if req.Method == WebhookMethodCheckExists {
		span.SetAttributes(attribute.Bool("landflow.webhook.exists", resp.Exists))
	}
	resp.StaticData = wc.changedStaticData()
	resp.Logs = wc.Logger.Entries()
	return resp, nil
}

// ReceiveWebhook runs Webhook of an app webhook trigger for one incoming
// call, inside a "plugin.webhook {node type}" server span.
func (p *Plugin) ReceiveWebhook(ctx context.Context, req *WebhookRequest) (*WebhookResponse, error) {
	if req == nil {
		return nil, fmt.Errorf("%w: empty request", ErrBadRequest)
	}
	if req.Protocol != "" && req.Protocol != ProtocolVersion {
		return nil, fmt.Errorf("%w: unsupported protocol %q (want %q)", ErrBadRequest, req.Protocol, ProtocolVersion)
	}
	if req.Node.Type == "" {
		return nil, fmt.Errorf("%w: node.type is required", ErrBadRequest)
	}
	rn, wn, notTrigger, err := p.webhookNode(req.Node.Type)
	if err != nil {
		return nil, err
	}
	if notTrigger != nil {
		return &WebhookResponse{Error: notTrigger}, nil
	}
	ctx, span, sc := p.startWebhookSpan(ctx, "plugin.webhook "+p.qualified(rn.descriptor.Name), rn, req.WorkflowID, req.Node, req.Credentials)
	defer span.End()

	wc := newWebhookContext(ctx, &rn.descriptor, req.WorkflowID, req.Node, req.Parameters, req.Credentials, req.StaticData, req.WebhookURL)
	wc.Logger = p.webhookLogger(ctx, sc, req.WorkflowID)
	incoming := req.Request
	if incoming.Method == "" {
		incoming.Method = "POST"
	}
	wc.incoming = &incoming
	wc.headers = make(map[string]string, len(incoming.Headers))
	for k, v := range incoming.Headers {
		wc.headers[strings.ToLower(k)] = v
	}

	resp := &WebhookResponse{}
	var result *WebhookResult
	err = p.safeWebhook(ctx, rn, func() error {
		var err error
		result, err = wn.Webhook(wc)
		return err
	})
	if err != nil {
		resp.Error = errorPayload(err)
		resp.Error.Message = sc.redact.str(resp.Error.Message)
		resp.Error.Description = sc.redact.str(resp.Error.Description)
		recordError(span, resp.Error.Message, err)
	} else if result != nil {
		for _, item := range result.Items {
			if item.JSON == nil {
				item.JSON = map[string]any{}
			}
			resp.Items = append(resp.Items, Item{JSON: item.JSON, Binary: item.Binary})
		}
		resp.Response = result.Response
		resp.IdempotencyKey = result.IdempotencyKey
	}
	span.SetAttributes(attribute.Int("landflow.items.out", len(resp.Items)))
	if resp.Response != nil && resp.Response.Status != 0 {
		span.SetAttributes(attribute.Int("http.response.status_code", resp.Response.Status))
	}
	resp.StaticData = wc.changedStaticData()
	resp.Logs = wc.Logger.Entries()
	return resp, nil
}

func (p *Plugin) safeWebhook(ctx context.Context, rn *registeredNode, fn func() error) (err error) {
	defer func() {
		if r := recover(); r != nil {
			p.logPanic(ctx, fmt.Sprintf("panic in webhook of node %q: %v", rn.descriptor.Name, r))
			err = &NodeError{Message: fmt.Sprintf("panic in node %q: %v", rn.descriptor.Name, r)}
		}
	}()
	return fn()
}

// The webhook context is a context.Context.
var _ context.Context = (*WebhookContext)(nil)
