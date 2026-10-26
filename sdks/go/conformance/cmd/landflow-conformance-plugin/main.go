// landflow-conformance-plugin serves the Go conformance plugin as a process, for live checks of every face:
//
//	go run ./conformance/cmd/landflow-conformance-plugin -http 7468 -grpc 7469
//	LANDFLOW_MCP_TOKEN=t go run ./conformance/cmd/landflow-conformance-plugin -http 7468
//	go run ./conformance/cmd/landflow-conformance-plugin --mcp-stdio
//
// The registry announce is off unless LANDFLOW_REGISTRY_URL is set.
package main

import (
	"context"
	"flag"
	"log"
	"os"

	landflow "github.com/landflow/landflow/sdks/go"
	"github.com/landflow/landflow/sdks/go/conformance"
)

func main() {
	httpPort := flag.Int("http", 0, "HTTP port (0 = any free port; LANDFLOW_HTTP_PORT overrides)")
	grpcPort := flag.Int("grpc", 0, "gRPC port (0 = off; LANDFLOW_GRPC_PORT overrides)")
	flag.Bool("mcp-stdio", false, "speak MCP on stdin/stdout and nothing else")
	flag.Parse()
	if os.Getenv("LANDFLOW_REGISTRY_URL") == "" {
		_ = os.Setenv("LANDFLOW_REGISTRY_URL", "off")
	}
	opts := []landflow.ServeOption{landflow.WithGRPC(*grpcPort)}
	if *httpPort > 0 || os.Getenv("LANDFLOW_HTTP_PORT") != "" {
		opts = append(opts, landflow.WithHTTP(*httpPort))
	}
	if err := landflow.Serve(context.Background(), conformance.New(nil), opts...); err != nil {
		log.Fatal(err)
	}
}
