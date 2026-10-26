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

	// Broker faces: LANDFLOW_TRANSPORTS=http,grpc,nats (with LANDFLOW_NATS_URL) serves the plugin over that broker too.
	_ "github.com/landflow/landflow/sdks/go/transport/amqp"
	_ "github.com/landflow/landflow/sdks/go/transport/kafka"
	_ "github.com/landflow/landflow/sdks/go/transport/nats"
	_ "github.com/landflow/landflow/sdks/go/transport/valkey"
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
		// The pools hold at most 10 connections per credential (tunePool, redis PoolSize), so more concurrent calls would only wait for a connection.
		// LANDFLOW_MAX_CONCURRENCY overrides it.
		MaxConcurrency: 10,
	})
	if err != nil {
		pools.shutdown()
		log.Fatal(err)
	}
}
