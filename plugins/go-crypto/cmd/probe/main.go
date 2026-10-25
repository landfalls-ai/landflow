// Command probe is a tiny gRPC client that checks a running plugin:
// GetManifest, Execute(hash) and Health.
//
//	go run ./cmd/probe -addr 127.0.0.1:7203
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	landflow "github.com/landflow/landflow/sdks/go"
	pb "github.com/landflow/landflow/sdks/go/landflowpb"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:7203", "plugin gRPC address")
	value := flag.String("value", "hello", "value to hash")
	flag.Parse()
	log.SetFlags(0)

	conn, err := grpc.NewClient(*addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		log.Fatal(err)
	}
	defer conn.Close()
	client := pb.NewPluginServiceClient(conn)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	manifest, err := client.GetManifest(ctx, &pb.GetManifestRequest{HostVersion: "probe"})
	if err != nil {
		log.Fatalf("GetManifest: %v", err)
	}
	info := manifest.GetPlugin()
	fmt.Printf("GetManifest: protocol=%s plugin=%s %q v%s language=%s sdk=%s/%s\n",
		manifest.GetProtocol(), info.GetId(), info.GetName(), info.GetVersion(), info.GetLanguage(), info.GetSdkName(), info.GetSdkVersion())
	for _, dv := range manifest.GetNodes() {
		var d landflow.NodeDescriptor
		if err := json.Unmarshal(dv.GetJson(), &d); err != nil {
			log.Fatalf("node descriptor is not valid JSON: %v", err)
		}
		fmt.Printf("  node %-10s %-11q tool=%-5v props=%d\n", d.Name, d.DisplayName, d.UsableAsTool, len(d.Properties))
	}

	req, err := landflow.ExecuteRequestToProto(&landflow.ExecuteRequest{
		Protocol:    landflow.ProtocolVersion,
		ExecutionID: "ex_probe",
		WorkflowID:  "wf_probe",
		Mode:        landflow.ModeManual,
		Node:        landflow.NodeRef{ID: "n1", Name: "Hash", Type: info.GetId() + ".hash", TypeVersion: 1},
		Parameters:  map[string]any{"algorithm": "sha256", "field": "value"},
		ItemParameters: []map[string]any{
			{"algorithm": "sha256", "field": "value"},
		},
		Inputs: [][]landflow.Item{{{JSON: map[string]any{"value": *value}}}},
	})
	if err != nil {
		log.Fatal(err)
	}
	out, err := client.Execute(ctx, req)
	if err != nil {
		log.Fatalf("Execute: %v", err)
	}
	resp, err := landflow.ExecuteResponseFromProto(out)
	if err != nil {
		log.Fatal(err)
	}
	if resp.Error != nil {
		log.Fatalf("Execute returned node error: %+v", resp.Error)
	}
	item := resp.Outputs[0][0]
	fmt.Printf("Execute(hash): sha256(%q) = %v pairedItem=%+v logs=%v\n", *value, item.JSON["hash"], *item.PairedItem, resp.Logs)

	health, err := client.Health(ctx, &pb.HealthRequest{})
	if err != nil {
		log.Fatalf("Health: %v", err)
	}
	fmt.Printf("Health: status=%s pluginId=%s version=%s uptimeMs=%d\n",
		health.GetStatus(), health.GetPluginId(), health.GetVersion(), health.GetUptimeMs())
	if health.GetStatus() != "ok" {
		os.Exit(1)
	}
}
