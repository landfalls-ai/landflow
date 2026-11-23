// Command google-workspace is Landflow's Google Workspace plugin: Google
// Sheets (+ trigger), Gmail (+ trigger), Google Drive, Google Calendar and
// Google Docs. It serves HTTP on :7106 and gRPC on :7206 and announces itself
// to the host.
//
//	go run .                              # announce to http://127.0.0.1:3000
//	LANDFLOW_REGISTRY_URL=off go run .    # standalone
//
// Every Google call goes through landflow.HTTPClient, so it is a client span
// in the workflow's trace. A credential's baseUrl points all of them at a
// proxy or a test double (see internal/fakegoogle and cmd/fakegoogle).
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
		ID:          "google",
		Name:        "Google Workspace",
		Version:     "0.1.0",
		Description: "Google Sheets, Gmail, Drive, Calendar, Docs and the Workspace directory, with polling triggers for new rows, new emails, Drive changes and calendar changes.",
		Icon:        "file:icons/google-workspace.svg",
		Color:       "#4285F4",
		Author:      "Landflow",
		Homepage:    "https://developers.google.com/workspace",
		IconFS:      icons,
		CredentialTypes: []landflow.CredentialType{
			serviceAccountCredential,
			oauth2Credential,
		},
	},
		SheetsNode{},
		SheetsTriggerNode{},
		GmailNode{},
		GmailTriggerNode{},
		DriveNode{},
		DriveTriggerNode{},
		CalendarNode{},
		CalendarTriggerNode{},
		DocsNode{},
		DirectoryNode{},
	)
}

func main() {
	err := landflow.Serve(context.Background(), newPlugin(), landflow.ServeOptions{
		HTTPPort: 7106,
		GRPCPort: 7206,
		// Google API quotas are per user and per minute (Sheets, Gmail, Drive and Calendar answer 429 above them), so 10 calls in flight keep one instance well under them.
		// LANDFLOW_MAX_CONCURRENCY overrides it.
		MaxConcurrency: 10,
	})
	if err != nil {
		log.Fatal(err)
	}
}
