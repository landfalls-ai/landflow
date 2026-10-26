package landflow

import (
	"context"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "github.com/landflow/landflow/sdks/go/landflowpb"
)

// gRPC binding of the app webhook trigger RPCs (WebhookMethod, ReceiveWebhook;
// docs/protocol.md §12). The client-side directions are exported for Go
// hosts, probes and tests.

func (g *grpcService) WebhookMethod(ctx context.Context, in *pb.WebhookMethodRequest) (*pb.WebhookMethodResponse, error) {
	req, err := WebhookMethodRequestFromProto(in)
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	resp, err := g.d.WebhookMethod(g.p.tel().extractGRPC(ctx), req, grpcCall)
	if err != nil {
		return nil, grpcStatus(err)
	}
	out, err := WebhookMethodResponseToProto(resp)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "encode response: %v", err)
	}
	return out, nil
}

func (g *grpcService) ReceiveWebhook(ctx context.Context, in *pb.ReceiveWebhookRequest) (*pb.ReceiveWebhookResponse, error) {
	req, err := WebhookRequestFromProto(in)
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	resp, err := g.d.ReceiveWebhook(g.p.tel().extractGRPC(ctx), req, grpcCall)
	if err != nil {
		return nil, grpcStatus(err)
	}
	out, err := WebhookResponseToProto(resp)
	if err != nil {
		out, _ = WebhookResponseToProto(&WebhookResponse{Logs: resp.Logs, Error: &NodeErrorPayload{Message: "webhook output is not JSON-serializable: " + err.Error()}})
	}
	return out, nil
}

func nodeRefFromProto(n *pb.NodeRef) NodeRef {
	ref := NodeRef{ID: n.GetId(), Name: n.GetName(), Type: n.GetType(), TypeVersion: int(n.GetTypeVersion())}
	if ref.TypeVersion == 0 {
		ref.TypeVersion = 1
	}
	return ref
}

func nodeRefToProto(n NodeRef) *pb.NodeRef {
	return &pb.NodeRef{Id: n.ID, Name: n.Name, Type: n.Type, TypeVersion: int32(n.TypeVersion)}
}

type webhookEnvelope struct {
	parameters, credentials, staticData map[string]any
}

func webhookEnvelopeFromProto(params, creds, static *pb.DynamicValue) (webhookEnvelope, error) {
	var env webhookEnvelope
	var err error
	if env.parameters, err = objectFromDynamic(params, "parameters"); err != nil {
		return env, err
	}
	if env.credentials, err = optionalObjectFromDynamic(creds, "credentials"); err != nil {
		return env, err
	}
	env.staticData, err = objectFromDynamic(static, "static_data")
	return env, err
}

func webhookEnvelopeToProto(params, creds, static map[string]any) (p, c, s *pb.DynamicValue, err error) {
	if params == nil {
		params = map[string]any{}
	}
	if static == nil {
		static = map[string]any{}
	}
	if p, err = toDynamic(params); err != nil {
		return
	}
	if creds != nil {
		if c, err = toDynamic(creds); err != nil {
			return
		}
	}
	s, err = toDynamic(static)
	return
}

func logsToProto(logs []LogEntry) []*pb.LogEntry {
	out := make([]*pb.LogEntry, 0, len(logs))
	for _, l := range logs {
		out = append(out, &pb.LogEntry{Level: string(l.Level), Message: l.Message})
	}
	return out
}

func logsFromProto(logs []*pb.LogEntry) []LogEntry {
	var out []LogEntry
	for _, l := range logs {
		out = append(out, LogEntry{Level: LogLevel(l.GetLevel()), Message: l.GetMessage()})
	}
	return out
}

func nodeErrorToProto(e *NodeErrorPayload) *pb.NodeError {
	if e == nil {
		return nil
	}
	out := &pb.NodeError{Message: e.Message, Description: e.Description, ItemIndex: -1}
	if e.ItemIndex != nil {
		out.ItemIndex = int32(*e.ItemIndex)
	}
	return out
}

func nodeErrorFromProto(e *pb.NodeError) *NodeErrorPayload {
	if e == nil || e.GetMessage() == "" {
		return nil
	}
	return &NodeErrorPayload{Message: e.GetMessage(), Description: e.GetDescription()}
}

// WebhookMethodRequestFromProto converts a proto WebhookMethodRequest.
func WebhookMethodRequestFromProto(in *pb.WebhookMethodRequest) (*WebhookMethodRequest, error) {
	env, err := webhookEnvelopeFromProto(in.GetParameters(), in.GetCredentials(), in.GetStaticData())
	if err != nil {
		return nil, err
	}
	return &WebhookMethodRequest{
		Protocol: in.GetProtocol(), Method: WebhookMethodName(in.GetMethod()), WorkflowID: in.GetWorkflowId(), Node: nodeRefFromProto(in.GetNode()),
		Parameters: env.parameters, Credentials: env.credentials, WebhookURL: in.GetWebhookUrl(), StaticData: env.staticData,
	}, nil
}

// WebhookMethodRequestToProto converts a WebhookMethodRequest to proto.
func WebhookMethodRequestToProto(req *WebhookMethodRequest) (*pb.WebhookMethodRequest, error) {
	params, creds, static, err := webhookEnvelopeToProto(req.Parameters, req.Credentials, req.StaticData)
	if err != nil {
		return nil, err
	}
	return &pb.WebhookMethodRequest{
		Protocol: req.Protocol, Method: string(req.Method), WorkflowId: req.WorkflowID, Node: nodeRefToProto(req.Node),
		Parameters: params, Credentials: creds, WebhookUrl: req.WebhookURL, StaticData: static,
	}, nil
}

// WebhookMethodResponseToProto converts a WebhookMethodResponse to proto.
func WebhookMethodResponseToProto(resp *WebhookMethodResponse) (*pb.WebhookMethodResponse, error) {
	out := &pb.WebhookMethodResponse{Exists: resp.Exists, Logs: logsToProto(resp.Logs), Error: nodeErrorToProto(resp.Error)}
	if resp.StaticData != nil {
		dv, err := toDynamic(resp.StaticData)
		if err != nil {
			return nil, err
		}
		out.StaticData = dv
	}
	return out, nil
}

// WebhookMethodResponseFromProto converts a proto WebhookMethodResponse.
func WebhookMethodResponseFromProto(in *pb.WebhookMethodResponse) (*WebhookMethodResponse, error) {
	resp := &WebhookMethodResponse{Exists: in.GetExists(), Logs: logsFromProto(in.GetLogs()), Error: nodeErrorFromProto(in.GetError())}
	if dv := in.GetStaticData(); dv != nil && len(dv.GetJson()) > 0 {
		var err error
		if resp.StaticData, err = objectFromDynamic(dv, "static_data"); err != nil {
			return nil, err
		}
	}
	return resp, nil
}

// WebhookRequestFromProto converts a proto ReceiveWebhookRequest.
func WebhookRequestFromProto(in *pb.ReceiveWebhookRequest) (*WebhookRequest, error) {
	env, err := webhookEnvelopeFromProto(in.GetParameters(), in.GetCredentials(), in.GetStaticData())
	if err != nil {
		return nil, err
	}
	incoming := in.GetRequest()
	return &WebhookRequest{
		Protocol: in.GetProtocol(), WorkflowID: in.GetWorkflowId(), Node: nodeRefFromProto(in.GetNode()),
		Parameters: env.parameters, Credentials: env.credentials, WebhookURL: in.GetWebhookUrl(), StaticData: env.staticData,
		Request: IncomingWebhookRequest{
			Method: incoming.GetMethod(), Path: incoming.GetPath(), Headers: incoming.GetHeaders(), Query: incoming.GetQuery(), Body: incoming.GetBody(),
		},
	}, nil
}

// WebhookRequestToProto converts a WebhookRequest to proto.
func WebhookRequestToProto(req *WebhookRequest) (*pb.ReceiveWebhookRequest, error) {
	params, creds, static, err := webhookEnvelopeToProto(req.Parameters, req.Credentials, req.StaticData)
	if err != nil {
		return nil, err
	}
	return &pb.ReceiveWebhookRequest{
		Protocol: req.Protocol, WorkflowId: req.WorkflowID, Node: nodeRefToProto(req.Node),
		Parameters: params, Credentials: creds, WebhookUrl: req.WebhookURL, StaticData: static,
		Request: &pb.IncomingWebhookRequest{
			Method: req.Request.Method, Path: req.Request.Path, Headers: req.Request.Headers, Query: req.Request.Query, Body: req.Request.Body,
		},
	}, nil
}

// WebhookResponseToProto converts a WebhookResponse to proto.
func WebhookResponseToProto(resp *WebhookResponse) (*pb.ReceiveWebhookResponse, error) {
	items, err := itemsToProto(resp.Items)
	if err != nil {
		return nil, err
	}
	out := &pb.ReceiveWebhookResponse{Items: items, IdempotencyKey: resp.IdempotencyKey, Logs: logsToProto(resp.Logs), Error: nodeErrorToProto(resp.Error)}
	if r := resp.Response; r != nil {
		out.Response = &pb.WebhookReply{Status: int32(r.Status), Headers: r.Headers, Body: []byte(r.Body)}
	}
	if resp.StaticData != nil {
		if out.StaticData, err = toDynamic(resp.StaticData); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// WebhookResponseFromProto converts a proto ReceiveWebhookResponse.
func WebhookResponseFromProto(in *pb.ReceiveWebhookResponse) (*WebhookResponse, error) {
	items, err := itemsFromProto(in.GetItems(), "items")
	if err != nil {
		return nil, err
	}
	resp := &WebhookResponse{IdempotencyKey: in.GetIdempotencyKey(), Logs: logsFromProto(in.GetLogs()), Error: nodeErrorFromProto(in.GetError())}
	if len(items) > 0 {
		resp.Items = items
	}
	if r := in.GetResponse(); r != nil {
		resp.Response = &WebhookReply{Status: int(r.GetStatus()), Headers: r.GetHeaders(), Body: string(r.GetBody())}
	}
	if dv := in.GetStaticData(); dv != nil && len(dv.GetJson()) > 0 {
		if resp.StaticData, err = objectFromDynamic(dv, "static_data"); err != nil {
			return nil, err
		}
	}
	return resp, nil
}
