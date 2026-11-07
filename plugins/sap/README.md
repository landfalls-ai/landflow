# SAP

SAP S/4HANA Cloud over OData V2 and V4: a metadata-driven **SAP OData** node, five preset nodes (Business Partner, Sales
Order, Purchase Order, Product, Supplier Invoice), **SAP Trigger (Poll)** and **SAP Event Trigger**. Usable as an agent
tool. The feature page is [docs/sap.md](../../docs/sap.md); the spec is [docs/specs/20-sap-plugin.md](../../docs/specs/20-sap-plugin.md).

```sh
pnpm plugin:sap                              # HTTP :7116 (MCP at /mcp), gRPC :7216
pnpm fake-s4                                 # fake S/4HANA on loopback, PORT, /__fake/* control routes
pnpm --filter @landflow/plugin-sap test      # 106 tests against the fake; no SAP system is called
```

## SAP OData

| Input | Meaning |
|---|---|
| `authentication` | the credential type: basic, OAuth2 (PKCE), client credentials, sandbox API key |
| `service`, `customPath`, `odataVersion` | one of the five services, or a custom path with V2 or V4 |
| `entitySet` | picked from `$metadata` (cached, `LANDFLOW_SAP_METADATA_TTL_SECONDS`) |
| `operation` | `get`, `list`, `create`, `update`, `delete` |
| `keys` | JSON of the key properties, e.g. `{"SalesOrder": "4500000001"}` |
| `filter`, `select`, `expand`, `orderby` | OData query options; `returnAll` follows next links up to Max Records |
| `body` | JSON fields for Create and Update; checked against `$metadata`, ISO dates become SAP dates |
| `allowWrites`, `allowDeletes` | both off by default |

Options: Max Records (100, ceiling 1000), Dry Run (auto: on as a tool), Max Writes per Run (5), Redact Personal Data,
Redact Fields, Add List Summary Item, Send If-Match: *, Keep SAP Dates, Timeout. Each item carries `__etag` and `__keys`.

## Triggers

SAP Trigger (Poll): service, entity set, Change Timestamp Property, Extra Filter, Poll Interval (60 s minimum), Max Records
per Poll, Overlap. SAP Event Trigger: Event Types pattern, secret from an `sapEventApi` credential (16 characters or more,
header name configurable). Details in [docs/sap.md](../../docs/sap.md#triggers).

## Packaging

Compose profile `sap` (`COMPOSE_BAKE=false docker compose -f deploy/compose.yml --profile sap up -d --build --wait`),
Kubernetes component `deploy/k8s/components/sap` (image `landflow/plugin-sap:dev`). The host's scan ports include
7116 and 7216. Variables: `LANDFLOW_SAP_ALLOWED_HOSTS`, `LANDFLOW_SAP_METADATA_TTL_SECONDS`.
