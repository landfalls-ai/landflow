// Command go-crypto is the example Landflow plugin built with the Go SDK. It
// serves HTTP on :7103 and gRPC on :7203 and announces itself to the host.
//
//	go run .                              # announce to http://127.0.0.1:3000
//	LANDFLOW_REGISTRY_URL=off go run .    # standalone
package main

import (
	"context"
	"embed"
	"log"

	landflow "github.com/landflow/landflow/sdks/go"
)

// icons holds the plugin and node icons; "file:icons/…" icons are inlined from it as data: URLs.
//
//go:embed icons
var icons embed.FS

func newPlugin() *landflow.Plugin {
	return landflow.NewPlugin(landflow.PluginInfo{
		ID:          "go-crypto",
		Name:        "Crypto Toolkit",
		Version:     "0.1.0",
		Description: "Hashing, UUIDs, Base64 and JWT decoding: the example plugin for the Landflow Go SDK.",
		Icon:        "file:icons/crypto-toolkit.svg",
		Color:       "#0d9488",
		Author:      "Landflow",
		IconFS:      icons,
	},
		HashNode{},
		UUIDNode{},
		Base64Node{},
		JWTDecodeNode{},
	)
}

func main() {
	err := landflow.Serve(context.Background(), newPlugin(), landflow.ServeOptions{
		HTTPPort: 7103,
		GRPCPort: 7203,
	})
	if err != nil {
		log.Fatal(err)
	}
}
