package landflow

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "github.com/landflow/landflow/sdks/go/landflowpb"
)

// GRPCServer returns a new *grpc.Server with the plugin registered.
func (p *Plugin) GRPCServer(opts ...grpc.ServerOption) *grpc.Server {
	s := grpc.NewServer(opts...)
	p.RegisterGRPC(s)
	return s
}

// RegisterGRPC registers landflow.plugin.v1.PluginService on s. Execute,
// LoadOptions and TestCredentials continue the caller's trace from the
// traceparent / tracestate / baggage metadata; Health and GetManifest are
// not traced. It is the gRPC binding over the plugin's Dispatcher; the call's
// context (its deadline, the client's cancellation) reaches node code.
func (p *Plugin) RegisterGRPC(s grpc.ServiceRegistrar) { p.Dispatcher().RegisterGRPC(s) }

// RegisterGRPC registers the gRPC face of this dispatcher on s (see Plugin.RegisterGRPC).
func (d *Dispatcher) RegisterGRPC(s grpc.ServiceRegistrar) {
	pb.RegisterPluginServiceServer(s, &grpcService{p: d.p, d: d})
}

// grpcCall is the CallOptions of every gRPC request: the deadline travels in
// the call's context already.
var grpcCall = CallOptions{Transport: "grpc"}

// grpcService adapts the transport-agnostic Dispatcher to PluginServiceServer
// by converting proto messages to and from the same structs the HTTP path uses.
type grpcService struct {
	pb.UnimplementedPluginServiceServer
	p *Plugin
	d *Dispatcher
}

func (g *grpcService) GetManifest(ctx context.Context, _ *pb.GetManifestRequest) (*pb.GetManifestResponse, error) {
	g.p.sendRegistryProof(ctx)
	m := g.p.Manifest()
	nodes := make([]*pb.DynamicValue, 0, len(m.Nodes))
	for _, d := range m.Nodes {
		dv, err := toDynamic(d)
		if err != nil {
			return nil, status.Errorf(codes.Internal, "encode node %q: %v", d.Name, err)
		}
		nodes = append(nodes, dv)
	}
	credTypes := make([]*pb.DynamicValue, 0, len(m.CredentialTypes))
	for _, d := range m.CredentialTypes {
		dv, err := toDynamic(d)
		if err != nil {
			return nil, status.Errorf(codes.Internal, "encode credential type %q: %v", d.Name, err)
		}
		credTypes = append(credTypes, dv)
	}
	composites := make([]*pb.DynamicValue, 0, len(m.Composites))
	for _, c := range m.Composites {
		dv, err := toDynamic(c)
		if err != nil {
			return nil, status.Errorf(codes.Internal, "encode composite %q: %v", c.Name, err)
		}
		composites = append(composites, dv)
	}
	return &pb.GetManifestResponse{
		Protocol: m.Protocol, Plugin: pluginInfoToProto(m.Plugin), Nodes: nodes, CredentialTypes: credTypes, Composites: composites,
		Transports: m.Transports, MaxConcurrency: int32(m.MaxConcurrency),
	}, nil
}

func (g *grpcService) Execute(ctx context.Context, in *pb.ExecuteRequest) (*pb.ExecuteResponse, error) {
	req, err := executeRequestFromProto(in)
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	resp, err := g.d.Execute(g.p.tel().extractGRPC(ctx), req, grpcCall)
	if err != nil {
		return nil, grpcStatus(err)
	}
	out, err := executeResponseToProto(resp)
	if err != nil {
		out, _ = executeResponseToProto(unserializableOutput(resp, err))
	}
	return out, nil
}

func (g *grpcService) LoadOptions(ctx context.Context, in *pb.LoadOptionsRequest) (*pb.LoadOptionsResponse, error) {
	params, err := objectFromDynamic(in.GetParameters(), "parameters")
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	creds, err := optionalObjectFromDynamic(in.GetCredentials(), "credentials")
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	resp, err := g.d.LoadOptions(g.p.tel().extractGRPC(ctx), &LoadOptionsRequest{
		NodeType: in.GetNodeType(), Method: in.GetMethod(), Parameters: params, Credentials: creds,
	}, grpcCall)
	if err != nil {
		return nil, grpcStatus(err)
	}
	dv, err := toDynamic(resp.Options)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "encode options: %v", err)
	}
	return &pb.LoadOptionsResponse{Options: dv}, nil
}

func (g *grpcService) TestCredentials(ctx context.Context, in *pb.TestCredentialsRequest) (*pb.TestCredentialsResponse, error) {
	data, err := objectFromDynamic(in.GetData(), "data")
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	resp, err := g.d.TestCredentials(g.p.tel().extractGRPC(ctx), &TestCredentialsRequest{CredentialType: in.GetCredentialType(), Data: data}, grpcCall)
	if err != nil {
		return nil, grpcStatus(err)
	}
	return &pb.TestCredentialsResponse{Ok: resp.OK, Message: resp.Message}, nil
}

func (g *grpcService) Health(ctx context.Context, _ *pb.HealthRequest) (*pb.HealthResponse, error) {
	h := g.p.Health()
	return &pb.HealthResponse{Status: h.Status, UptimeMs: h.UptimeMs, PluginId: h.PluginID, Version: h.Version}, nil
}

func grpcStatus(err error) error {
	switch {
	case errors.Is(err, ErrUnknownNode), errors.Is(err, ErrUnknownCredentialType):
		return status.Error(codes.NotFound, err.Error())
	case errors.Is(err, ErrNoOptionsLoader):
		return status.Error(codes.Unimplemented, err.Error())
	case errors.Is(err, ErrBadRequest):
		return status.Error(codes.InvalidArgument, err.Error())
	case errors.Is(err, ErrOverloaded):
		return status.Error(codes.ResourceExhausted, err.Error())
	case errors.Is(err, context.DeadlineExceeded):
		return status.Error(codes.DeadlineExceeded, err.Error())
	case errors.Is(err, context.Canceled):
		return status.Error(codes.Canceled, err.Error())
	default:
		return status.Error(codes.Internal, err.Error())
	}
}

// ---------------------------------------------------------------------------
// Conversions. The client-side directions (request → proto, proto → response)
// are exported for Go hosts, probes and tests.
// ---------------------------------------------------------------------------

func pluginInfoToProto(info PluginInfo) *pb.PluginInfo {
	out := &pb.PluginInfo{
		Id: info.ID, Name: info.Name, Version: info.Version, Description: info.Description,
		Language: info.Language, Icon: info.Icon, Author: info.Author, Homepage: info.Homepage, Color: info.Color,
	}
	if info.SDK != nil {
		out.SdkName, out.SdkVersion = info.SDK.Name, info.SDK.Version
	}
	return out
}

// PluginInfoFromProto converts the proto PluginInfo to the JSON struct.
func PluginInfoFromProto(in *pb.PluginInfo) PluginInfo {
	out := PluginInfo{
		ID: in.GetId(), Name: in.GetName(), Version: in.GetVersion(), Description: in.GetDescription(),
		Language: in.GetLanguage(), Icon: in.GetIcon(), Author: in.GetAuthor(), Homepage: in.GetHomepage(), Color: in.GetColor(),
	}
	if in.GetSdkName() != "" {
		out.SDK = &SDKInfo{Name: in.GetSdkName(), Version: in.GetSdkVersion()}
	}
	return out
}

func executeRequestFromProto(in *pb.ExecuteRequest) (*ExecuteRequest, error) {
	req := &ExecuteRequest{
		Protocol:    in.GetProtocol(),
		ExecutionID: in.GetExecutionId(),
		WorkflowID:  in.GetWorkflowId(),
		Mode:        ExecutionMode(in.GetMode()),
	}
	if n := in.GetNode(); n != nil {
		req.Node = NodeRef{ID: n.GetId(), Name: n.GetName(), Type: n.GetType(), TypeVersion: int(n.GetTypeVersion())}
	}
	var err error
	if req.Parameters, err = objectFromDynamic(in.GetParameters(), "parameters"); err != nil {
		return nil, err
	}
	req.ItemParameters = make([]map[string]any, len(in.GetItemParameters()))
	for i, dv := range in.GetItemParameters() {
		if req.ItemParameters[i], err = objectFromDynamic(dv, fmt.Sprintf("itemParameters[%d]", i)); err != nil {
			return nil, err
		}
	}
	req.Inputs = make([][]Item, len(in.GetInputs()))
	for b, branch := range in.GetInputs() {
		if req.Inputs[b], err = itemsFromProto(branch.GetItems(), fmt.Sprintf("inputs[%d]", b)); err != nil {
			return nil, err
		}
	}
	if req.Credentials, err = optionalObjectFromDynamic(in.GetCredentials(), "credentials"); err != nil {
		return nil, err
	}
	if req.PollState, err = optionalObjectFromDynamic(in.GetPollState(), "pollState"); err != nil {
		return nil, err
	}
	req.ContinueOnFail = in.GetContinueOnFail()
	req.IdempotencyKey = in.GetIdempotencyKey()
	if ba := in.GetBinaryAccess(); ba != nil && ba.GetUrl() != "" {
		req.BinaryAccess = &BinaryAccess{URL: ba.GetUrl(), Token: ba.GetToken()}
	}
	return req, nil
}

func itemsFromProto(items []*pb.Item, path string) ([]Item, error) {
	out := make([]Item, len(items))
	for i, it := range items {
		obj, err := objectFromDynamic(it.GetJson(), fmt.Sprintf("%s[%d].json", path, i))
		if err != nil {
			return nil, err
		}
		out[i].JSON = obj
		if bin := it.GetBinary(); bin != nil && len(bin.GetJson()) > 0 {
			var files map[string]BinaryRef
			if err := json.Unmarshal(bin.GetJson(), &files); err != nil {
				return nil, fmt.Errorf("%s[%d].binary: DynamicValue must hold an object of binary refs: %v", path, i, err)
			}
			if len(files) > 0 {
				out[i].Binary = files
			}
		}
		if pi := it.GetPairedItem(); pi != nil {
			out[i].PairedItem = &PairedItem{Item: int(pi.GetItem()), Input: int(pi.GetInput())}
		}
	}
	return out, nil
}

func itemsToProto(items []Item) ([]*pb.Item, error) {
	out := make([]*pb.Item, len(items))
	for i, it := range items {
		obj := it.JSON
		if obj == nil {
			obj = map[string]any{}
		}
		dv, err := toDynamic(obj)
		if err != nil {
			return nil, fmt.Errorf("item %d: %w", i, err)
		}
		out[i] = &pb.Item{Json: dv}
		if len(it.Binary) > 0 {
			if out[i].Binary, err = toDynamic(it.Binary); err != nil {
				return nil, fmt.Errorf("item %d binary: %w", i, err)
			}
		}
		if it.PairedItem != nil {
			out[i].PairedItem = &pb.PairedItem{Item: int32(it.PairedItem.Item), Input: int32(it.PairedItem.Input)}
		}
	}
	return out, nil
}

func executeResponseToProto(resp *ExecuteResponse) (*pb.ExecuteResponse, error) {
	out := &pb.ExecuteResponse{Outputs: make([]*pb.Branch, len(resp.Outputs))}
	for b, branch := range resp.Outputs {
		items, err := itemsToProto(branch)
		if err != nil {
			return nil, err
		}
		out.Outputs[b] = &pb.Branch{Items: items}
	}
	for _, l := range resp.Logs {
		out.Logs = append(out.Logs, &pb.LogEntry{Level: string(l.Level), Message: l.Message})
	}
	if e := resp.Error; e != nil {
		idx := int32(-1)
		if e.ItemIndex != nil {
			idx = int32(*e.ItemIndex)
		}
		out.Error = &pb.NodeError{Message: e.Message, Description: e.Description, ItemIndex: idx}
	}
	if resp.PollState != nil {
		dv, err := toDynamic(resp.PollState)
		if err != nil {
			return nil, fmt.Errorf("pollState: %w", err)
		}
		out.PollState = dv
	}
	return out, nil
}

// ExecuteResponseFromProto converts a proto ExecuteResponse to the JSON struct
// (item_index -1 becomes a nil ItemIndex; an empty message means success).
func ExecuteResponseFromProto(in *pb.ExecuteResponse) (*ExecuteResponse, error) {
	resp := &ExecuteResponse{Outputs: make([][]Item, len(in.GetOutputs()))}
	for b, branch := range in.GetOutputs() {
		items, err := itemsFromProto(branch.GetItems(), fmt.Sprintf("outputs[%d]", b))
		if err != nil {
			return nil, err
		}
		resp.Outputs[b] = items
	}
	for _, l := range in.GetLogs() {
		resp.Logs = append(resp.Logs, LogEntry{Level: LogLevel(l.GetLevel()), Message: l.GetMessage()})
	}
	if e := in.GetError(); e != nil && e.GetMessage() != "" {
		resp.Error = &NodeErrorPayload{Message: e.GetMessage(), Description: e.GetDescription()}
		if e.GetItemIndex() >= 0 {
			idx := int(e.GetItemIndex())
			resp.Error.ItemIndex = &idx
		}
	}
	var err error
	if resp.PollState, err = optionalObjectFromDynamic(in.GetPollState(), "pollState"); err != nil {
		return nil, err
	}
	return resp, nil
}

// ExecuteRequestToProto converts the JSON request struct to proto.
func ExecuteRequestToProto(req *ExecuteRequest) (*pb.ExecuteRequest, error) {
	out := &pb.ExecuteRequest{
		Protocol: req.Protocol, ExecutionId: req.ExecutionID, WorkflowId: req.WorkflowID, Mode: string(req.Mode),
		Node: &pb.NodeRef{Id: req.Node.ID, Name: req.Node.Name, Type: req.Node.Type, TypeVersion: int32(req.Node.TypeVersion)},
	}
	params := req.Parameters
	if params == nil {
		params = map[string]any{}
	}
	var err error
	if out.Parameters, err = toDynamic(params); err != nil {
		return nil, err
	}
	for _, ip := range req.ItemParameters {
		if ip == nil {
			ip = map[string]any{}
		}
		dv, err := toDynamic(ip)
		if err != nil {
			return nil, err
		}
		out.ItemParameters = append(out.ItemParameters, dv)
	}
	for _, branch := range req.Inputs {
		items, err := itemsToProto(branch)
		if err != nil {
			return nil, err
		}
		out.Inputs = append(out.Inputs, &pb.Branch{Items: items})
	}
	if req.Credentials != nil {
		if out.Credentials, err = toDynamic(req.Credentials); err != nil {
			return nil, err
		}
	}
	if req.PollState != nil {
		if out.PollState, err = toDynamic(req.PollState); err != nil {
			return nil, err
		}
	}
	out.ContinueOnFail = req.ContinueOnFail
	out.IdempotencyKey = req.IdempotencyKey // empty is not sent (proto3 default)
	if req.BinaryAccess != nil {
		out.BinaryAccess = &pb.BinaryAccess{Url: req.BinaryAccess.URL, Token: req.BinaryAccess.Token}
	}
	return out, nil
}

// Dynamic encodes v as a DynamicValue (UTF-8 JSON bytes).
func Dynamic(v any) (*pb.DynamicValue, error) { return toDynamic(v) }

func toDynamic(v any) (*pb.DynamicValue, error) {
	data, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return &pb.DynamicValue{Json: data}, nil
}

// objectFromDynamic decodes a DynamicValue holding a JSON object. A missing or
// empty value (or JSON null) yields an empty map.
func objectFromDynamic(dv *pb.DynamicValue, path string) (map[string]any, error) {
	out := map[string]any{}
	if dv == nil || len(dv.GetJson()) == 0 {
		return out, nil
	}
	var v map[string]any
	if err := json.Unmarshal(dv.GetJson(), &v); err != nil {
		return nil, fmt.Errorf("%s: DynamicValue must hold a JSON object: %v", path, err)
	}
	if v == nil {
		return out, nil
	}
	return v, nil
}

// optionalObjectFromDynamic is objectFromDynamic for optional fields: a
// missing value or JSON null yields nil (credentials absent, first poll).
func optionalObjectFromDynamic(dv *pb.DynamicValue, path string) (map[string]any, error) {
	if dv == nil || len(dv.GetJson()) == 0 {
		return nil, nil
	}
	var v map[string]any
	if err := json.Unmarshal(dv.GetJson(), &v); err != nil {
		return nil, fmt.Errorf("%s: DynamicValue must hold a JSON object: %v", path, err)
	}
	return v, nil
}
