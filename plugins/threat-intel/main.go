// Command threat-intel is Landflow's threat intelligence plugin: VirusTotal,
// AbuseIPDB, GreyNoise, urlscan.io, Shodan, AlienVault OTX and MISP lookups,
// plus IOC Enrich, which asks every configured service about an alert's IOCs
// and returns one verdict. Every operation is a read. It serves HTTP on :7110
// and gRPC on :7210 and announces itself to the host.
//
//	go run .                              # announce to http://127.0.0.1:3000
//	LANDFLOW_REGISTRY_URL=off go run .    # standalone
//
// Every service call goes through landflow.HTTPClient, so it is a client span
// in the workflow's trace. A credential's baseUrl points a service at a proxy
// or a test double.
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
		ID:          "threat-intel",
		Name:        "Threat Intel",
		Version:     "0.1.0",
		Description: "Look up IPs, domains, URLs and file hashes in VirusTotal, AbuseIPDB, GreyNoise, urlscan.io, Shodan, AlienVault OTX and MISP, or enrich them all at once with IOC Enrich.",
		Icon:        "file:icons/threat-intel.svg",
		Color:       "#0F766E",
		Author:      "Landflow",
		IconFS:      icons,
		CredentialTypes: []landflow.CredentialType{
			virusTotalCredential, abuseIpDbCredential, greyNoiseCredential, urlscanCredential,
			shodanCredential, otxCredential, mispCredential,
		},
	},
		virusTotalNode(),
		abuseIpDbNode(),
		greyNoiseNode(),
		urlscanNode(),
		shodanNode(),
		otxNode(),
		mispNode(),
		IOCEnrichNode{},
	)
}

func main() {
	err := landflow.Serve(context.Background(), newPlugin(), landflow.ServeOptions{
		HTTPPort: 7110,
		GRPCPort: 7210,
		// Threat-intel APIs meter by key (free tiers are small), so a handful of calls in flight is plenty; IOC Enrich
		// fans out further inside one call, bounded by its own Concurrency option.
		// LANDFLOW_MAX_CONCURRENCY overrides it.
		MaxConcurrency: 10,
	})
	if err != nil {
		log.Fatal(err)
	}
}
