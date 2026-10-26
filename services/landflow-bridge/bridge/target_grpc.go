package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	landflow "github.com/landflow/landflow/sdks/go"
	pb "github.com/landflow/landflow/sdks/go/landflowpb"
	"github.com/landflow/landflow/sdks/go/transport"
)

// maxGRPCMessageBytes matches the HTTP face's body limit (item batches can be large).
const maxGRPCMessageBytes = 64 << 20

// grpcTarget forwards calls over landflow.plugin.v1.PluginService, converting the JSON bodies with the SDK's
// client-side conversions. The call's ctx carries the deadline (the gRPC deadline) and the host's cancel.
type grpcTarget struct {
	url    string
	conn   *grpc.ClientConn
	client pb.PluginServiceClient
}

func newGRPCTarget(u *url.URL) (*grpcTarget, error) {
	conn, err := grpc.NewClient(u.Host,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithDefaultCallOptions(grpc.MaxCallRecvMsgSize(maxGRPCMessageBytes), grpc.MaxCallSendMsgSize(maxGRPCMessageBytes)),
	)
	if err != nil {
		return nil, err
	}
	return &grpcTarget{url: u.String(), conn: conn, client: pb.NewPluginServiceClient(conn)}, nil
}

func (t *grpcTarget) URL() string  { return t.url }
func (t *grpcTarget) Close() error { return t.conn.Close() }

func (t *grpcTarget) Manifest(ctx context.Context) (json.RawMessage, error) {
	resp, err := t.client.GetManifest(ctx, &pb.GetManifestRequest{HostVersion: "landflow-bridge"})
	if err != nil {
		return nil, grpcError(ctx, err)
	}
	doc := manifestDoc{
		Protocol: resp.GetProtocol(), Plugin: landflow.PluginInfoFromProto(resp.GetPlugin()),
		Transports: resp.GetTransports(), MaxConcurrency: int(resp.GetMaxConcurrency()), Nodes: []json.RawMessage{},
	}
	for _, dv := range resp.GetNodes() {
		doc.Nodes = append(doc.Nodes, json.RawMessage(dv.GetJson()))
	}
	for _, dv := range resp.GetCredentialTypes() {
		doc.CredentialTypes = append(doc.CredentialTypes, json.RawMessage(dv.GetJson()))
	}
	return json.Marshal(doc)
}

func (t *grpcTarget) Call(ctx context.Context, method transport.Method, body json.RawMessage, deadline time.Time) (json.RawMessage, error) {
	if !deadline.IsZero() {
		var cancel context.CancelFunc
		ctx, cancel = context.WithDeadline(ctx, deadline)
		defer cancel()
	}
	var (
		result any
		err    error
	)
	switch method {
	case transport.MethodGetManifest:
		return t.Manifest(ctx)
	case transport.MethodHealth:
		var resp *pb.HealthResponse
		if resp, err = t.client.Health(ctx, &pb.HealthRequest{}); err == nil {
			result = landflow.HealthResponse{Status: resp.GetStatus(), UptimeMs: resp.GetUptimeMs(), PluginID: resp.GetPluginId(), Version: resp.GetVersion()}
		}
	case transport.MethodExecute:
		var req landflow.ExecuteRequest
		if err := decodeInto(body, &req); err != nil {
			return nil, err
		}
		msg, convErr := landflow.ExecuteRequestToProto(&req)
		if convErr != nil {
			return nil, dispatchErr(transport.CodeBadRequest, "request does not convert: %v", convErr)
		}
		var resp *pb.ExecuteResponse
		if resp, err = t.client.Execute(ctx, msg); err == nil {
			result, err = landflow.ExecuteResponseFromProto(resp)
		}
	case transport.MethodLoadOptions:
		var req landflow.LoadOptionsRequest
		if err := decodeInto(body, &req); err != nil {
			return nil, err
		}
		msg := &pb.LoadOptionsRequest{NodeType: req.NodeType, Method: req.Method}
		params := req.Parameters
		if params == nil {
			params = map[string]any{}
		}
		if msg.Parameters, err = landflow.Dynamic(params); err != nil {
			return nil, dispatchErr(transport.CodeBadRequest, "parameters do not encode: %v", err)
		}
		if req.Credentials != nil {
			if msg.Credentials, err = landflow.Dynamic(req.Credentials); err != nil {
				return nil, dispatchErr(transport.CodeBadRequest, "credentials do not encode: %v", err)
			}
		}
		var resp *pb.LoadOptionsResponse
		if resp, err = t.client.LoadOptions(ctx, msg); err == nil {
			options := json.RawMessage(resp.GetOptions().GetJson())
			if len(options) == 0 {
				options = json.RawMessage("[]")
			}
			result = map[string]json.RawMessage{"options": options}
		}
	case transport.MethodTestCredentials:
		var req landflow.TestCredentialsRequest
		if err := decodeInto(body, &req); err != nil {
			return nil, err
		}
		data := req.Data
		if data == nil {
			data = map[string]any{}
		}
		dv, convErr := landflow.Dynamic(data)
		if convErr != nil {
			return nil, dispatchErr(transport.CodeBadRequest, "data does not encode: %v", convErr)
		}
		var resp *pb.TestCredentialsResponse
		if resp, err = t.client.TestCredentials(ctx, &pb.TestCredentialsRequest{CredentialType: req.CredentialType, Data: dv}); err == nil {
			result = landflow.TestCredentialsResponse{OK: resp.GetOk(), Message: resp.GetMessage()}
		}
	case transport.MethodWebhookMethod:
		var req landflow.WebhookMethodRequest
		if err := decodeInto(body, &req); err != nil {
			return nil, err
		}
		msg, convErr := landflow.WebhookMethodRequestToProto(&req)
		if convErr != nil {
			return nil, dispatchErr(transport.CodeBadRequest, "request does not convert: %v", convErr)
		}
		var resp *pb.WebhookMethodResponse
		if resp, err = t.client.WebhookMethod(ctx, msg); err == nil {
			result, err = landflow.WebhookMethodResponseFromProto(resp)
		}
	case transport.MethodReceiveWebhook:
		var req landflow.WebhookRequest
		if err := decodeInto(body, &req); err != nil {
			return nil, err
		}
		msg, convErr := landflow.WebhookRequestToProto(&req)
		if convErr != nil {
			return nil, dispatchErr(transport.CodeBadRequest, "request does not convert: %v", convErr)
		}
		var resp *pb.ReceiveWebhookResponse
		if resp, err = t.client.ReceiveWebhook(ctx, msg); err == nil {
			result, err = landflow.WebhookResponseFromProto(resp)
		}
	default:
		return nil, dispatchErr(transport.CodeNotFound, "unknown method %q", method)
	}
	if err != nil {
		return nil, grpcError(ctx, err)
	}
	out, err := json.Marshal(result)
	if err != nil {
		return nil, dispatchErr(transport.CodeInternal, "response does not encode: %v", err)
	}
	return out, nil
}

// grpcError maps a gRPC status onto the lferror vocabulary (docs/protocol.md §14.6; the kit's table in
// packages/protocol/conformance/README.md). A finished ctx wins: the host's deadline or cancel is what happened.
func grpcError(ctx context.Context, err error) error {
	if e := ctxErr(ctx); e != nil {
		return e
	}
	var de *transport.DispatchError
	if errors.As(err, &de) {
		return de
	}
	st, ok := status.FromError(err)
	if !ok {
		return dispatchErr(transport.CodeInternal, "%v", err)
	}
	msg := st.Message()
	switch st.Code() {
	case codes.NotFound, codes.Unimplemented:
		return dispatchErr(transport.CodeNotFound, "%s", msg)
	case codes.InvalidArgument:
		return dispatchErr(transport.CodeBadRequest, "%s", msg)
	case codes.ResourceExhausted:
		return dispatchErr(transport.CodeCapacity, "%s", msg)
	case codes.DeadlineExceeded:
		return dispatchErr(transport.CodeExpired, "%s", msg)
	case codes.Canceled:
		return dispatchErr(transport.CodeCancelled, "%s", msg)
	case codes.Unavailable:
		return dispatchErr(transport.CodeUnavailable, "plugin unreachable over gRPC: %s", msg)
	case codes.Unauthenticated, codes.PermissionDenied:
		return dispatchErr(transport.CodeUnavailable, "plugin refused the call: %s", msg)
	default:
		return dispatchErr(transport.CodeInternal, "%s", msg)
	}
}
