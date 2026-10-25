package landflow

import (
	"context"
	"encoding/json"
	"net"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"

	pb "github.com/landflow/landflow/sdks/go/landflowpb"
)

func bufconnClient(t *testing.T, p *Plugin) pb.PluginServiceClient {
	t.Helper()
	lis := bufconn.Listen(1 << 20)
	srv := p.GRPCServer()
	go func() { _ = srv.Serve(lis) }()
	t.Cleanup(srv.Stop)
	conn, err := grpc.NewClient("passthrough:///bufnet",
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) { return lis.DialContext(ctx) }),
		grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return pb.NewPluginServiceClient(conn)
}

func TestGRPCRoundTrip(t *testing.T) {
	client := bufconnClient(t, testPlugin())
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// GetManifest: nodes are NodeDescriptor JSON.
	m, err := client.GetManifest(ctx, &pb.GetManifestRequest{HostVersion: "test"})
	if err != nil {
		t.Fatal(err)
	}
	if m.GetProtocol() != ProtocolVersion || m.GetPlugin().GetId() != "test-plugin" || m.GetPlugin().GetSdkName() != SDKName || m.GetPlugin().GetLanguage() != "go" {
		t.Errorf("manifest envelope: %v", m)
	}
	if len(m.GetNodes()) != 2 {
		t.Fatalf("nodes = %d", len(m.GetNodes()))
	}
	var d NodeDescriptor
	if err := json.Unmarshal(m.GetNodes()[0].GetJson(), &d); err != nil || d.Name != "upper" || len(d.Properties) != 3 {
		t.Errorf("node 0 = %+v (%v)", d, err)
	}
	if info := PluginInfoFromProto(m.GetPlugin()); info.SDK == nil || info.SDK.Version != SDKVersion {
		t.Errorf("PluginInfoFromProto = %+v", info)
	}

	// Execute: same semantics as HTTP, including pairedItem filling.
	req := execReq("test-plugin.upper", map[string]any{"suffix": "!"}, map[string]any{"value": "a"}, map[string]any{"value": "b", "n": 2.0})
	req.ItemParameters[1] = map[string]any{"suffix": "?"}
	req.Credentials = map[string]any{"k": "v"}
	req.ContinueOnFail = true
	in, err := ExecuteRequestToProto(req)
	if err != nil {
		t.Fatal(err)
	}
	if back, err := executeRequestFromProto(in); err != nil || !back.ContinueOnFail {
		t.Errorf("continueOnFail lost in conversion: %+v (%v)", back, err)
	}
	out, err := client.Execute(ctx, in)
	if err != nil {
		t.Fatal(err)
	}
	if out.GetError() != nil {
		t.Fatalf("unexpected error: %v", out.GetError())
	}
	resp, err := ExecuteResponseFromProto(out)
	if err != nil {
		t.Fatal(err)
	}
	got := resp.Outputs[0]
	if got[0].JSON["value"] != "A!" || got[1].JSON["value"] != "B?" || got[1].JSON["n"] != 2.0 {
		t.Errorf("outputs = %+v", got)
	}
	if got[1].PairedItem == nil || got[1].PairedItem.Item != 1 {
		t.Errorf("pairedItem = %+v", got[1].PairedItem)
	}
	if len(resp.Logs) != 1 || resp.Logs[0].Level != LevelInfo {
		t.Errorf("logs = %+v", resp.Logs)
	}

	// Item-specific node error → item_index; generic → -1.
	bad, _ := ExecuteRequestToProto(execReq("test-plugin.upper", nil, map[string]any{"value": 1.0}))
	out, err = client.Execute(ctx, bad)
	if err != nil || out.GetError().GetItemIndex() != 0 || out.GetError().GetDescription() != "check the input" {
		t.Errorf("item error: %v %v", out.GetError(), err)
	}
	panicReq, _ := ExecuteRequestToProto(execReq("test-plugin.behave", map[string]any{"do": "panic"}))
	out, err = client.Execute(ctx, panicReq)
	if err != nil || out.GetError().GetItemIndex() != -1 || out.GetError().GetMessage() == "" {
		t.Errorf("panic error: %v %v", out.GetError(), err)
	}
	if r, _ := ExecuteResponseFromProto(out); r.Error == nil || r.Error.ItemIndex != nil {
		t.Errorf("item_index -1 must map to nil: %+v", r.Error)
	}

	// Unknown node → NotFound; bad DynamicValue → InvalidArgument.
	ghost, _ := ExecuteRequestToProto(execReq("test-plugin.ghost", nil))
	if _, err := client.Execute(ctx, ghost); status.Code(err) != codes.NotFound {
		t.Errorf("unknown node code = %v", status.Code(err))
	}
	if _, err := client.Execute(ctx, &pb.ExecuteRequest{Node: &pb.NodeRef{Type: "test-plugin.upper"}, Parameters: &pb.DynamicValue{Json: []byte("[1]")}}); status.Code(err) != codes.InvalidArgument {
		t.Errorf("bad params code = %v", status.Code(err))
	}

	// LoadOptions (local node name).
	lo, err := client.LoadOptions(ctx, &pb.LoadOptionsRequest{NodeType: "upper", Method: "modes"})
	if err != nil {
		t.Fatal(err)
	}
	var opts []PropertyOption
	if err := json.Unmarshal(lo.GetOptions().GetJson(), &opts); err != nil || len(opts) != 2 || opts[1].Value != "lower" {
		t.Errorf("options = %+v (%v)", opts, err)
	}
	if _, err := client.LoadOptions(ctx, &pb.LoadOptionsRequest{NodeType: "ghost", Method: "x"}); status.Code(err) != codes.NotFound {
		t.Errorf("load options unknown node = %v", status.Code(err))
	}
	if _, err := client.LoadOptions(ctx, &pb.LoadOptionsRequest{NodeType: "behave", Method: "x"}); status.Code(err) != codes.Unimplemented {
		t.Errorf("load options no loader = %v", status.Code(err))
	}

	// Health.
	h, err := client.Health(ctx, &pb.HealthRequest{})
	if err != nil || h.GetStatus() != "ok" || h.GetPluginId() != "test-plugin" || h.GetVersion() != "1.2.3" {
		t.Errorf("health = %v %v", h, err)
	}
}
