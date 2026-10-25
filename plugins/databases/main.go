// Command databases is Landflow's database plugin: Postgres, MySQL, SQLite
// and Redis nodes, plus "New Row" poll triggers for Postgres and SQLite. It
// serves HTTP on :7107 and gRPC on :7207 and announces itself to the host.
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
		ID:          "databases",
		Name:        "Databases",
		Version:     "0.1.0",
		Description: "Postgres, MySQL, SQLite and Redis nodes, with new-row poll triggers for Postgres and SQLite.",
		Icon:        "file:icons/databases.svg",
		Color:       "#475569",
		Author:      "Landflow",
		IconFS:      icons,
		CredentialTypes: []landflow.CredentialType{
			postgresCredential, mysqlCredential, redisCredential, sqliteCredential,
		},
	},
		postgresNode,
		mysqlNode,
		sqliteNode,
		redisNode{},
		postgresTrigger,
		sqliteTrigger,
	)
}

func main() {
	defer pools.shutdown() // close every cached connection pool on the way out
	err := landflow.Serve(context.Background(), newPlugin(), landflow.ServeOptions{
		HTTPPort: 7107,
		GRPCPort: 7207,
	})
	if err != nil {
		pools.shutdown()
		log.Fatal(err)
	}
}
