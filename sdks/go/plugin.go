package landflow

import (
	"context"
	"errors"
	"fmt"
	"log"
	"log/slog"
	"regexp"
	"runtime/debug"
	"strings"
	"sync/atomic"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"
)

// Plugin hosts a set of nodes and implements the protocol independently of
// the transport. Use Handler() for HTTP, RegisterGRPC/GRPCServer for gRPC, or
// Serve for both plus announcement.
type Plugin struct {
	info      PluginInfo
	nodes     map[string]*registeredNode
	order     []string
	credTypes map[string]*registeredCredType
	credOrder []string
	started   time.Time
	telemetry atomic.Pointer[Telemetry]
}

type registeredNode struct {
	node       Node
	descriptor NodeDescriptor
	loader     OptionsLoader
	ctxLoader  OptionsLoaderWithContext
}

type registeredCredType struct {
	descriptor     CredentialTypeDescriptor
	test           func(ctx context.Context, data CredentialData) (bool, string)
	passwordFields map[string]bool // typeOptions.password properties: values are redacted
}

// ErrUnknownNode is returned (wrapped) when a request names a node type the
// plugin does not host. Transports map it to HTTP 404 / codes.NotFound.
var ErrUnknownNode = errors.New("unknown node type")

// ErrNoOptionsLoader is returned (wrapped) by LoadOptions for nodes that do not
// implement OptionsLoader.
var ErrNoOptionsLoader = errors.New("node does not implement LoadOptions")

// ErrBadRequest is returned (wrapped) for requests that are structurally
// invalid. Transports map it to HTTP 400 / codes.InvalidArgument.
var ErrBadRequest = errors.New("bad request")

// ErrUnknownCredentialType is returned (wrapped) by TestCredentials for a
// credential type the plugin does not declare. Transports map it to HTTP 404
// / codes.NotFound.
var ErrUnknownCredentialType = errors.New("unknown credential type")

// NewPlugin builds a plugin from its info and nodes. Language is forced to
// "go" and SDK to landflow-sdk-go. Descriptors are validated immediately and
// NewPlugin panics with every problem listed if any is invalid; use
// BuildPlugin to get an error instead.
func NewPlugin(info PluginInfo, nodes ...Node) *Plugin {
	p, err := BuildPlugin(info, nodes...)
	if err != nil {
		panic(err)
	}
	return p
}

// BuildPlugin is NewPlugin returning validation problems as an error.
func BuildPlugin(info PluginInfo, nodes ...Node) (*Plugin, error) {
	info.Language = "go"
	info.SDK = &SDKInfo{Name: SDKName, Version: SDKVersion}
	icons := info.IconFS
	info.IconFS = nil
	credTypes := info.CredentialTypes
	info.CredentialTypes = nil

	var problems []string
	problems = append(problems, validateInfo(info)...)
	if icon, err := resolveIcon(info.Icon, icons); err != nil {
		problems = append(problems, "plugin "+err.Error())
	} else {
		info.Icon = icon
	}
	p := &Plugin{info: info, nodes: map[string]*registeredNode{}, credTypes: map[string]*registeredCredType{}, started: time.Now()}
	if len(nodes) == 0 {
		problems = append(problems, "plugin has no nodes")
	}
	for i, ct := range credTypes {
		label := "credential type " + ct.Name
		if ct.Name == "" {
			label = fmt.Sprintf("credentialTypes[%d]", i)
		}
		d := ct.Descriptor()
		normalizeProperties(d.Properties)
		for _, msg := range validateCredentialType(d) {
			problems = append(problems, label+": "+msg)
		}
		if icon, err := resolveIcon(d.Icon, icons); err != nil {
			problems = append(problems, label+": "+err.Error())
		} else {
			d.Icon = icon
		}
		if _, dup := p.credTypes[d.Name]; dup {
			problems = append(problems, label+": duplicate credential type name")
			continue
		}
		rc := &registeredCredType{descriptor: d, test: ct.Test, passwordFields: map[string]bool{}}
		for _, prop := range d.Properties {
			if prop.TypeOptions != nil && prop.TypeOptions.Password {
				rc.passwordFields[prop.Name] = true
			}
		}
		p.credTypes[d.Name] = rc
		p.credOrder = append(p.credOrder, d.Name)
	}
	for i, n := range nodes {
		if n == nil {
			problems = append(problems, fmt.Sprintf("nodes[%d] is nil", i))
			continue
		}
		d := normalizeDescriptor(n.Description())
		loader, _ := n.(OptionsLoader)
		ctxLoader, _ := n.(OptionsLoaderWithContext)
		label := d.Name
		if label == "" {
			label = fmt.Sprintf("nodes[%d]", i)
		}
		for _, msg := range validateDescriptor(d, loader != nil || ctxLoader != nil) {
			problems = append(problems, label+": "+msg)
		}
		for j, req := range d.Credentials {
			if _, ok := p.credTypes[req.Name]; !ok && req.Name != "" {
				problems = append(problems, fmt.Sprintf("%s: credentials[%d] %q is not one of the plugin's credential types (PluginInfo.CredentialTypes)", label, j, req.Name))
			}
		}
		if icon, err := resolveIcon(d.Icon, icons); err != nil {
			problems = append(problems, label+": "+err.Error())
		} else {
			d.Icon = icon
		}
		if _, dup := p.nodes[d.Name]; dup {
			problems = append(problems, fmt.Sprintf("%s: duplicate node name", label))
			continue
		}
		p.nodes[d.Name] = &registeredNode{node: n, descriptor: d, loader: loader, ctxLoader: ctxLoader}
		p.order = append(p.order, d.Name)
	}
	if len(problems) > 0 {
		return nil, fmt.Errorf("landflow: invalid plugin %q:\n  - %s", info.ID, strings.Join(problems, "\n  - "))
	}
	return p, nil
}

// Info returns the plugin info as advertised in the manifest.
func (p *Plugin) Info() PluginInfo { return p.info }

// Manifest returns the manifest served by both transports.
func (p *Plugin) Manifest() PluginManifest {
	nodes := make([]NodeDescriptor, 0, len(p.order))
	for _, name := range p.order {
		nodes = append(nodes, p.nodes[name].descriptor)
	}
	m := PluginManifest{Protocol: ProtocolVersion, Plugin: p.info, Nodes: nodes}
	for _, name := range p.credOrder {
		m.CredentialTypes = append(m.CredentialTypes, p.credTypes[name].descriptor)
	}
	return m
}

// WellKnown returns the discovery document.
func (p *Plugin) WellKnown() WellKnownDocument {
	return WellKnownDocument{
		Protocol: ProtocolVersion,
		Plugin:   WellKnownPlugin{ID: p.info.ID, Name: p.info.Name, Version: p.info.Version, Language: p.info.Language},
		Endpoints: WellKnownEndpoints{
			Manifest: PathManifest, Execute: PathExecute, LoadOptions: PathLoadOptions, Health: PathHealth,
			TestCredentials: PathTestCredentials,
		},
	}
}

// Health returns the liveness document.
func (p *Plugin) Health() HealthResponse {
	return HealthResponse{
		Status:   "ok",
		UptimeMs: time.Since(p.started).Milliseconds(),
		PluginID: p.info.ID,
		Version:  p.info.Version,
	}
}

// localName maps "<pluginId>.<node>" (or a bare "<node>") to the local name.
func (p *Plugin) localName(nodeType string) (string, bool) {
	if rest, ok := strings.CutPrefix(nodeType, p.info.ID+"."); ok {
		return rest, true
	}
	if !strings.Contains(nodeType, ".") {
		return nodeType, true
	}
	return "", false
}

func (p *Plugin) find(nodeType string) (*registeredNode, error) {
	name, ok := p.localName(nodeType)
	if ok {
		if n, found := p.nodes[name]; found {
			return n, nil
		}
	}
	return nil, fmt.Errorf("%w %q (plugin %q hosts: %s)", ErrUnknownNode, nodeType, p.info.ID, strings.Join(p.order, ", "))
}

// Execute runs a request against the matching node. The only error returned
// is a wrapped ErrUnknownNode / ErrBadRequest; node failures (including
// panics) are reported inside the response.
//
// The run is a "plugin.execute {node type}" server span, a child of the
// trace context in ctx (the transports extract it from traceparent headers
// or metadata), and is counted in the landflow.plugin.* metrics.
func (p *Plugin) Execute(ctx context.Context, req *ExecuteRequest) (*ExecuteResponse, error) {
	if req == nil {
		return nil, fmt.Errorf("%w: empty request", ErrBadRequest)
	}
	if req.Protocol != "" && req.Protocol != ProtocolVersion {
		return nil, fmt.Errorf("%w: unsupported protocol %q (want %q)", ErrBadRequest, req.Protocol, ProtocolVersion)
	}
	if req.Node.Type == "" {
		return nil, fmt.Errorf("%w: node.type is required", ErrBadRequest)
	}
	rn, err := p.find(req.Node.Type)
	if err != nil {
		return nil, err
	}
	normalizeRequest(req)
	if ctx == nil {
		ctx = context.Background()
	}

	start := time.Now()
	tel := p.tel()
	nodeType := p.qualified(rn.descriptor.Name)
	sc := &scope{tel: tel, redact: newRedactor(req.Credentials, p.credTypes), nodeType: nodeType, workflowID: req.WorkflowID}
	itemsIn := countItems(req.Inputs)
	ctx, span := tel.tracer.Start(withScope(ctx, sc), "plugin.execute "+nodeType,
		trace.WithSpanKind(trace.SpanKindServer),
		trace.WithAttributes(
			attribute.String("landflow.plugin.id", p.info.ID),
			attribute.String("landflow.node.type", nodeType),
			attribute.String("landflow.node.name", req.Node.Name),
			attribute.String("landflow.workflow.id", req.WorkflowID),
			attribute.String("landflow.execution.id", req.ExecutionID),
			attribute.String("landflow.execution.mode", string(req.Mode)),
			attribute.Int("landflow.items.in", itemsIn),
		))

	ec := NewExecuteContext(ctx, req, &rn.descriptor)
	ec.Logger = newSinkLogger(&logSink{ctx: ctx, handler: tel.logHandler, redact: sc.redact, attrs: []slog.Attr{
		slog.String("landflow.node.type", nodeType),
		slog.String("landflow.execution.id", req.ExecutionID),
		slog.String("landflow.workflow.id", req.WorkflowID),
	}})
	outputs, runErr := p.runNode(rn, ec)

	resp := &ExecuteResponse{Logs: ec.Logger.Entries()}
	status := "success"
	if runErr != nil {
		status = "error"
		resp.Outputs = [][]Item{}
		resp.Error = errorPayload(runErr)
		recordError(span, sc.redact.str(resp.Error.Message), runErr)
	} else {
		resp.Outputs = finalizeOutputs(outputs, req.Inputs, &rn.descriptor)
		if state, set := ec.nextPollState(); set && req.Mode == ModePoll {
			resp.PollState = state
		}
	}
	itemsOut := countItems(resp.Outputs)
	span.SetAttributes(attribute.Int("landflow.items.out", itemsOut))
	span.End()

	typeAttr := attribute.String("landflow.node.type", nodeType)
	statusAttrs := metric.WithAttributes(typeAttr, attribute.String("landflow.node.status", status))
	tel.inst.executions.Add(ctx, 1, statusAttrs)
	tel.inst.duration.Record(ctx, float64(time.Since(start))/float64(time.Millisecond), statusAttrs)
	tel.inst.items.Add(ctx, int64(itemsIn), metric.WithAttributes(typeAttr, attribute.String("landflow.direction", "in")))
	tel.inst.items.Add(ctx, int64(itemsOut), metric.WithAttributes(typeAttr, attribute.String("landflow.direction", "out")))
	return resp, nil
}

func (p *Plugin) qualified(local string) string { return p.info.ID + "." + local }

func countItems(branches [][]Item) int {
	n := 0
	for _, b := range branches {
		n += len(b)
	}
	return n
}

func (p *Plugin) runNode(rn *registeredNode, ec *ExecuteContext) (outputs [][]Item, err error) {
	defer func() {
		if r := recover(); r != nil {
			p.logPanic(ec.ctx, fmt.Sprintf("panic in node %q: %v", rn.descriptor.Name, r))
			outputs = nil
			err = &NodeError{
				Message:     fmt.Sprintf("panic in node %q: %v", rn.descriptor.Name, r),
				Description: "The plugin recovered from a crash while executing this node; see the plugin's logs for the stack trace.",
			}
		}
	}()
	return rn.node.Execute(ec)
}

// logPanic writes a recovered panic and its stack to the process log (stderr
// when telemetry is not set up).
func (p *Plugin) logPanic(ctx context.Context, msg string) {
	stack := string(debug.Stack())
	if t := p.telemetry.Load(); t != nil {
		t.logger.ErrorContext(ctx, "landflow: "+msg, "stack", stack)
		return
	}
	log.Printf("landflow: %s\n%s", msg, stack)
}

// LoadOptions resolves a dynamic dropdown, inside a "plugin.load_options
// {method}" server span.
func (p *Plugin) LoadOptions(ctx context.Context, req *LoadOptionsRequest) (*LoadOptionsResponse, error) {
	if req == nil || req.NodeType == "" || req.Method == "" {
		return nil, fmt.Errorf("%w: nodeType and method are required", ErrBadRequest)
	}
	rn, err := p.find(req.NodeType)
	if err != nil {
		return nil, err
	}
	if rn.loader == nil && rn.ctxLoader == nil {
		return nil, fmt.Errorf("%w (node %q)", ErrNoOptionsLoader, rn.descriptor.Name)
	}
	if req.Parameters == nil {
		req.Parameters = map[string]any{}
	}
	if ctx == nil {
		ctx = context.Background()
	}

	tel := p.tel()
	nodeType := p.qualified(rn.descriptor.Name)
	sc := &scope{tel: tel, redact: newRedactor(req.Credentials, p.credTypes), nodeType: nodeType}
	ctx, span := tel.tracer.Start(withScope(ctx, sc), "plugin.load_options "+req.Method,
		trace.WithSpanKind(trace.SpanKindServer),
		trace.WithAttributes(
			attribute.String("landflow.plugin.id", p.info.ID),
			attribute.String("landflow.node.type", nodeType),
			attribute.String("landflow.load_options.method", req.Method),
		))
	defer span.End()

	lc := &LoadOptionsContext{
		callScope: callScope{ctx: ctx, creds: req.Credentials},
		Logger: newSinkLogger(&logSink{ctx: ctx, handler: tel.logHandler, redact: sc.redact, attrs: []slog.Attr{
			slog.String("landflow.node.type", nodeType), slog.String("landflow.load_options.method", req.Method),
		}}),
		req: req, descriptor: &rn.descriptor,
	}
	options, err := p.safeLoadOptions(rn, lc)
	outcome := "ok"
	if err != nil {
		outcome = "error"
		recordError(span, sc.redact.errString(err), err)
	}
	tel.inst.loadOptions.Add(ctx, 1, metric.WithAttributes(
		attribute.String("landflow.load_options.method", req.Method), attribute.String("landflow.outcome", outcome)))
	if err != nil {
		return nil, fmt.Errorf("%w: %s", ErrBadRequest, err.Error())
	}
	if options == nil {
		options = []PropertyOption{}
	}
	return &LoadOptionsResponse{Options: options}, nil
}

func (p *Plugin) safeLoadOptions(rn *registeredNode, lc *LoadOptionsContext) (opts []PropertyOption, err error) {
	defer func() {
		if r := recover(); r != nil {
			p.logPanic(lc.ctx, fmt.Sprintf("panic in LoadOptions of %q: %v", rn.descriptor.Name, r))
			err = fmt.Errorf("panic in LoadOptions(%q): %v", lc.Method(), r)
		}
	}()
	if rn.ctxLoader != nil {
		return rn.ctxLoader.LoadOptionsWithContext(lc)
	}
	return rn.loader.LoadOptions(lc.Method(), lc.Parameters())
}

// TestCredentials runs a credential type's Test function inside a
// "plugin.test_credentials {credential type}" server span. A type without
// Test answers ok=false; an unknown type is a wrapped ErrUnknownCredentialType.
func (p *Plugin) TestCredentials(ctx context.Context, req *TestCredentialsRequest) (*TestCredentialsResponse, error) {
	if req == nil || req.CredentialType == "" {
		return nil, fmt.Errorf("%w: credentialType is required", ErrBadRequest)
	}
	name := strings.TrimPrefix(req.CredentialType, p.info.ID+".")
	rc, ok := p.credTypes[name]
	if !ok {
		return nil, fmt.Errorf("%w %q (plugin %q declares: %s)", ErrUnknownCredentialType, req.CredentialType, p.info.ID, orDefault(strings.Join(p.credOrder, ", "), "none"))
	}
	if ctx == nil {
		ctx = context.Background()
	}
	tel := p.tel()
	sc := &scope{tel: tel, redact: newRedactor(map[string]any{name: req.Data}, p.credTypes)}
	ctx, span := tel.tracer.Start(withScope(ctx, sc), "plugin.test_credentials "+name,
		trace.WithSpanKind(trace.SpanKindServer),
		trace.WithAttributes(
			attribute.String("landflow.plugin.id", p.info.ID),
			attribute.String("landflow.credential.type", name),
		))
	defer span.End()

	resp := &TestCredentialsResponse{}
	if rc.test == nil {
		resp.Message = fmt.Sprintf("credential type %q has no connection test", name)
	} else {
		resp.OK, resp.Message = p.safeTest(ctx, rc, CredentialData(req.Data))
	}
	span.SetAttributes(attribute.Bool("landflow.credential.ok", resp.OK))
	if !resp.OK {
		span.SetStatus(codes.Error, orDefault(sc.redact.str(resp.Message), "credential test failed"))
	}
	return resp, nil
}

func (p *Plugin) safeTest(ctx context.Context, rc *registeredCredType, data CredentialData) (ok bool, msg string) {
	defer func() {
		if r := recover(); r != nil {
			p.logPanic(ctx, fmt.Sprintf("panic in credential test %q: %v", rc.descriptor.Name, r))
			ok, msg = false, fmt.Sprintf("panic in credential test: %v", r)
		}
	}()
	if data == nil {
		data = CredentialData{}
	}
	return rc.test(ctx, data)
}

// normalizeRequest replaces nil collections so node code never has to.
func normalizeRequest(req *ExecuteRequest) {
	if req.Parameters == nil {
		req.Parameters = map[string]any{}
	}
	for i := range req.Inputs {
		for j := range req.Inputs[i] {
			if req.Inputs[i][j].JSON == nil {
				req.Inputs[i][j].JSON = map[string]any{}
			}
		}
	}
}

// finalizeOutputs makes the outputs wire-safe and fills missing pairedItem:
// when an output branch has exactly as many items as input 0, item i that
// lacks pairedItem gets {item: i}.
func finalizeOutputs(outputs [][]Item, inputs [][]Item, d *NodeDescriptor) [][]Item {
	if outputs == nil {
		mains := 0
		for _, port := range d.Outputs {
			if port.Type == ConnectionMain {
				mains++
			}
		}
		outputs = make([][]Item, mains)
	}
	inputLen := -1
	if len(inputs) > 0 {
		inputLen = len(inputs[0])
	}
	for b := range outputs {
		if outputs[b] == nil {
			outputs[b] = []Item{}
		}
		fill := len(outputs[b]) == inputLen
		for i := range outputs[b] {
			if outputs[b][i].JSON == nil {
				outputs[b][i].JSON = map[string]any{}
			}
			if fill && outputs[b][i].PairedItem == nil {
				outputs[b][i].PairedItem = &PairedItem{Item: i}
			}
		}
	}
	return outputs
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

var (
	pluginIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)
	nodeNamePattern = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9_-]*$`)
	hexColorPattern = regexp.MustCompile(`^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$`)
)

var validPropertyTypes = map[PropertyType]bool{
	PropString: true, PropNumber: true, PropBoolean: true, PropOptions: true, PropMultiOptions: true,
	PropJSON: true, PropCode: true, PropCollection: true, PropFixedCollection: true, PropColor: true,
	PropDateTime: true, PropNotice: true, PropHidden: true,
}

var validConnections = map[ConnectionType]bool{
	ConnectionMain: true, ConnectionLanguageModel: true, ConnectionTool: true, ConnectionMemory: true,
}

var validLanguages = map[string]bool{
	"javascript": true, "json": true, "python": true, "sql": true, "text": true, "markdown": true,
}

func validateInfo(info PluginInfo) []string {
	var problems []string
	if !pluginIDPattern.MatchString(info.ID) {
		problems = append(problems, fmt.Sprintf("plugin id %q must be lowercase kebab-case", info.ID))
	}
	if info.Name == "" {
		problems = append(problems, "plugin name is required")
	}
	if info.Version == "" {
		problems = append(problems, "plugin version is required")
	}
	if info.Color != "" && !hexColorPattern.MatchString(info.Color) {
		problems = append(problems, fmt.Sprintf("plugin color %q must be a hex colour like #0d9488", info.Color))
	}
	return problems
}

// normalizeDescriptor fills defaults so the descriptor marshals to a valid
// manifest entry (arrays instead of null, kind/ports defaults).
func normalizeDescriptor(d NodeDescriptor) NodeDescriptor {
	if d.Kind == "" && d.TriggerSource != "" {
		d.Kind = KindTrigger
	}
	if d.Kind == "" {
		d.Kind = KindAction
	}
	if d.TriggerSource == TriggerPoll && !hasProperty(d.Properties, PollIntervalName) {
		d.Properties = append(append([]PropertyDescriptor(nil), d.Properties...), PollIntervalProperty(DefaultPollIntervalSeconds))
	}
	if len(d.Version) == 0 {
		d.Version = Version{1}
	}
	if d.Inputs == nil {
		if d.Kind == KindAction {
			d.Inputs = []PortDescriptor{MainPort()}
		} else {
			d.Inputs = []PortDescriptor{}
		}
	}
	if d.Outputs == nil {
		switch {
		case d.Kind == KindSubnode && d.Supplies != "":
			d.Outputs = []PortDescriptor{{Type: d.Supplies}}
		case d.Kind == KindSubnode:
			d.Outputs = []PortDescriptor{}
		default:
			d.Outputs = []PortDescriptor{MainPort()}
		}
	}
	if d.Properties == nil {
		d.Properties = []PropertyDescriptor{}
	}
	normalizeProperties(d.Properties)
	return d
}

func normalizeProperties(props []PropertyDescriptor) {
	for i := range props {
		normalizeProperties(props[i].Values)
		for j := range props[i].Groups {
			if props[i].Groups[j].Values == nil {
				props[i].Groups[j].Values = []PropertyDescriptor{}
			}
			normalizeProperties(props[i].Groups[j].Values)
		}
	}
}

func validateDescriptor(d NodeDescriptor, hasLoader bool) []string {
	var problems []string
	add := func(format string, args ...any) { problems = append(problems, fmt.Sprintf(format, args...)) }

	if !nodeNamePattern.MatchString(d.Name) {
		add("node name %q must be an identifier (letters, digits, _ and -)", d.Name)
	}
	if d.DisplayName == "" {
		add("displayName is required")
	}
	for _, v := range d.Version {
		if v <= 0 {
			add("version %d must be a positive integer", v)
		}
	}
	if d.DefaultVersion != 0 {
		found := false
		for _, v := range d.Version {
			found = found || v == d.DefaultVersion
		}
		if !found {
			add("defaultVersion %d is not one of version %v", d.DefaultVersion, []int(d.Version))
		}
	}
	switch d.Kind {
	case KindTrigger, KindAction, KindSubnode:
	default:
		add("kind %q must be trigger, action or subnode", d.Kind)
	}
	switch d.TriggerSource {
	case "", TriggerManual, TriggerWebhook, TriggerSchedule, TriggerChat, TriggerPoll:
	default:
		add("triggerSource %q is invalid", d.TriggerSource)
	}
	if d.TriggerSource != "" && d.Kind != KindTrigger {
		add("triggerSource %q requires kind trigger", d.TriggerSource)
	}
	if d.TriggerSource == TriggerPoll {
		for _, prop := range d.Properties {
			if prop.Name == PollIntervalName && prop.Type != PropNumber {
				add("%s must be a number property (seconds); use landflow.PollIntervalProperty", PollIntervalName)
			}
		}
	}
	seenCreds := map[string]bool{}
	for i, c := range d.Credentials {
		if c.Name == "" {
			add("credentials[%d].name is required", i)
		} else if seenCreds[c.Name] {
			add("credentials[%d] %q is listed twice", i, c.Name)
		}
		seenCreds[c.Name] = true
		problems = append(problems, validateDisplayOptions(fmt.Sprintf("credentials[%d]", i), c.DisplayOptions)...)
	}
	if d.Supplies != "" && (d.Supplies == ConnectionMain || !validConnections[d.Supplies]) {
		add("supplies %q must be ai_languageModel, ai_tool or ai_memory", d.Supplies)
	}
	for i, port := range d.Inputs {
		problems = append(problems, validatePort(fmt.Sprintf("inputs[%d]", i), port)...)
	}
	for i, port := range d.Outputs {
		problems = append(problems, validatePort(fmt.Sprintf("outputs[%d]", i), port)...)
	}
	problems = append(problems, validateProperties("properties", d.Properties, hasLoader)...)
	return problems
}

func validatePort(path string, port PortDescriptor) []string {
	var problems []string
	if !validConnections[port.Type] {
		problems = append(problems, fmt.Sprintf("%s.type %q is not a connection type", path, port.Type))
	}
	if port.MaxConnections < 0 {
		problems = append(problems, fmt.Sprintf("%s.maxConnections must be positive", path))
	}
	return problems
}

func validateProperties(path string, props []PropertyDescriptor, hasLoader bool) []string {
	var problems []string
	add := func(format string, args ...any) { problems = append(problems, fmt.Sprintf(format, args...)) }
	for i, prop := range props {
		at := fmt.Sprintf("%s[%d]", path, i)
		if prop.Name != "" {
			at = fmt.Sprintf("%s[%s]", path, prop.Name)
		} else {
			add("%s.name is required", at)
		}
		if !validPropertyTypes[prop.Type] {
			add("%s.type %q is not a property type", at, prop.Type)
		}
		for j, opt := range prop.Options {
			if !isPrimitive(opt.Value) {
				add("%s.options[%d].value must be a string, number or bool", at, j)
			}
		}
		if prop.Type == PropOptions || prop.Type == PropMultiOptions {
			if len(prop.Options) == 0 && (prop.TypeOptions == nil || prop.TypeOptions.LoadOptionsMethod == "") {
				add("%s needs options or typeOptions.loadOptionsMethod", at)
			}
		}
		if to := prop.TypeOptions; to != nil {
			if to.LoadOptionsMethod != "" && !hasLoader {
				add("%s.typeOptions.loadOptionsMethod %q set but the node does not implement OptionsLoader", at, to.LoadOptionsMethod)
			}
			if to.Language != "" && !validLanguages[to.Language] {
				add("%s.typeOptions.language %q is invalid", at, to.Language)
			}
		}
		problems = append(problems, validateDisplayOptions(at, prop.DisplayOptions)...)
		problems = append(problems, validateProperties(at+".values", prop.Values, hasLoader)...)
		for j, g := range prop.Groups {
			if g.Name == "" || g.DisplayName == "" {
				add("%s.groups[%d] needs name and displayName", at, j)
			}
			problems = append(problems, validateProperties(fmt.Sprintf("%s.groups[%s]", at, g.Name), g.Values, hasLoader)...)
		}
	}
	return problems
}

func validateDisplayOptions(at string, do *DisplayOptions) []string {
	if do == nil {
		return nil
	}
	var problems []string
	for key, values := range do.Show {
		for _, v := range values {
			if !isPrimitive(v) {
				problems = append(problems, fmt.Sprintf("%s.displayOptions.show[%s] values must be primitives", at, key))
			}
		}
	}
	for key, values := range do.Hide {
		for _, v := range values {
			if !isPrimitive(v) {
				problems = append(problems, fmt.Sprintf("%s.displayOptions.hide[%s] values must be primitives", at, key))
			}
		}
	}
	return problems
}

func validateCredentialType(d CredentialTypeDescriptor) []string {
	var problems []string
	if !nodeNamePattern.MatchString(d.Name) {
		problems = append(problems, fmt.Sprintf("name %q must be an identifier (letters, digits, _ and -)", d.Name))
	}
	if d.DisplayName == "" {
		problems = append(problems, "displayName is required")
	}
	return append(problems, validateProperties("properties", d.Properties, false)...)
}

func hasProperty(props []PropertyDescriptor, name string) bool {
	for _, p := range props {
		if p.Name == name {
			return true
		}
	}
	return false
}

func isPrimitive(v any) bool {
	switch v.(type) {
	case string, bool, float64, float32, int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64:
		return true
	}
	return false
}
