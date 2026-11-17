// Command hello-node serves the plugin and announces it to the Landflow host (LANDFLOW_REGISTRY_URL, default
// http://127.0.0.1:3000).
//
//	LANDFLOW_REGISTRY_URL=off go run .     # stand-alone, no host
//
// HTTP on :7193 (the MCP face is at /mcp), gRPC on :7293. LANDFLOW_HTTP_PORT and LANDFLOW_GRPC_PORT override the ports.
package main

import (
	"context"
	"log"

	landflow "github.com/landflow/landflow/sdks/go"
)

func main() {
	err := landflow.Serve(context.Background(), newPlugin(), landflow.ServeOptions{
		HTTPPort: 7193, GRPCPort: 7293, MaxConcurrency: 8,
	})
	if err != nil {
		log.Fatal(err)
	}
}
