# Clickland

Part of the [Landflow docs](../README.md); the [feature map](../README.md#feature-map) lists every feature page.

Clickland is the land family's observability system: logs, traces and metrics in ClickHouse, alerts, notes (what people
and agents learned) and views (charts, tables and traces built on demand, kept as dashboards). Landflow works with it
in four ways:

- **The `clickland` plugin** ([plugins/clickland](../../plugins/clickland/README.md)): a node for every read and write of
  Clickland's API, usable as an agent tool and over MCP, a signed alert webhook trigger and a polling trigger.
- **Clickland as an agent's knowledge base** ([agents.md](../agents.md#knowledge-bases-from-a-plugin)): a standalone
  agent searches Clickland's knowledge (notes, alert events, log patterns, services) the way it searches a vector store
  collection.
- **Flows**: Clickland alerts triaged by an AI agent into Slack, and the chat behind Clickland's "Assistant" panel.
- **Telemetry**: Landflow's own traces, metrics and logs go to Clickland's collector on the OrbStack cluster.

Clickland's API is specified in its repository (`docs/reference/api.md`); the plugin was built against that contract
and tested against a local fake of it.

## The plugin

| | |
|---|---|
| Package | `plugins/clickland` (TypeScript SDK), `pnpm plugin:clickland` |
| Ports | HTTP 7119, gRPC 7219 |
| Credential | **Clickland API (ck_…)**: Base URL (default `http://clickland-api.clickland-dev.svc.cluster.local:4710`, `http://127.0.0.1:4710` on this machine), API Key |
| Nodes | **Clickland** (Log, Trace, Service, Metric, Alert, Note, Knowledge, View), **Clickland Alert Trigger** (app webhook), **Clickland Trigger** (poll) |
| Deploy | compose service `clickland`; Kubernetes `deploy/k8s/base/plugins/clickland.yaml`, image `landflow/plugin-clickland` |

The operations, their routes and outputs, the scopes each needs and how the triggers register and verify are in the
[plugin README](../../plugins/clickland/README.md). Every read operation is named so that its MCP tool carries
`readOnlyHint` (`logs_search`, `traces_get`, `services_list`, `views_list`…), and View → Render answers with a marker
(`[[clickland:view:<id>]]`) that Clickland's console draws as a live view inline in a chat answer.
