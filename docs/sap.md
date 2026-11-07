# SAP S/4HANA Cloud

A plugin (`plugins/sap`, plugin id `sap`) that reads and, when told to, writes SAP S/4HANA Cloud data over OData V2 and V4,
and starts flows when records change. Part of the [Landflow docs](README.md); the spec is
[specs/20-sap-plugin.md](specs/20-sap-plugin.md), the node reference is in the
[plugin's README](../plugins/sap/README.md).

```sh
pnpm plugin:sap                                        # HTTP :7116 (MCP at /mcp), gRPC :7216
pnpm fake-s4                                           # the fake S/4HANA server on loopback (PORT)
pnpm --filter @landflow/plugin-sap test                # against the fake; no SAP system is called
```

## Nodes

| Node | What it does |
|---|---|
| SAP OData | Get, List, Create, Update, Delete on any entity set of a service, with key, filter, select, expand and order choices read from `$metadata` |
| SAP Business Partner, Sales Order, Purchase Order, Product, Supplier Invoice | the same node with the service and entity sets fixed, and curated list filters (customer, status, dates) |
| SAP Trigger (Poll) | starts a flow for each record created or changed since the last poll |
| SAP Event Trigger | starts a flow on a CloudEvent posted to its webhook |

The five services are `API_BUSINESS_PARTNER`, `API_SALES_ORDER_SRV`, `API_PURCHASEORDER_PROCESS_SRV`,
`API_PRODUCT_SRV` and `API_SUPPLIERINVOICE_PROCESS_SRV`. Any other service is a custom path (checked: it must sit under
`/sap/opu/odata` or `/sap/opu/odata4`), with V2 or V4 chosen.

## Credentials

`sapS4hanaBasicApi` (communication user), `sapS4hanaOAuth2Api` (authorization code with PKCE, through the platform's OAuth
type), `sapS4hanaOAuth2ClientApi` (client credentials), `sapSandboxApi` (the API Business Hub `APIKey`) and `sapEventApi`
(the event webhook secret). Each has Test connection (one `$top=1` read). Optional `allowedServices` narrows what a flow
using the credential can reach. Only https is accepted; http works for a host named exactly in `LANDFLOW_SAP_ALLOWED_HOSTS`
(for the fake). Redirects are not followed.

## Safety

- **Writes are off.** Create, Update and Delete need Allow Writes (Delete also Allow Deletes). As an agent tool the node
  runs as a dry run unless Dry Run is set to off.
- **Approvals.** Mark the tool in the AI Agent node (`requireApproval: selected`, `approvalTools`): the agent waits for a
  person, and nothing is sent to SAP before.
- **Max Writes per Run** (default 5, 0 means none), counted per execution.
- **CSRF and ETag.** A write fetches a CSRF token and the session cookie, refetches once on a CSRF 403, and sends
  `If-Match` with the ETag it read first (428 and 412 come back as readable errors). Writes are never retried on a 5xx or a
  timeout.
- **Reads.** Max Records (default 100, ceiling 1000), 429 `Retry-After` honoured, one retry on a 5xx.
- **Redaction.** Redact Personal Data and Redact Fields blank values before they leave the node, so before a model sees them.
- **Tool mode** rejects any argument outside the node's schema and lists only key fields unless `select` is given.

## Triggers

**Poll.** Every 60 seconds or more it reads the records whose change timestamp is at or after the cursor minus an overlap
(default 60 s; a date without a time gets a day). The first poll sets a baseline and emits nothing. A seen set (up to 5000)
keeps overlap repeats silent; a record that changes again is emitted again. More changes than Max Records per Poll wait for
the next poll, oldest first. Deletions are not seen. Execute in the editor shows the five newest records and stores
nothing. Changing the service, entity set, property or filter starts a new baseline.

**Event.** Publish the flow; the webhook is `/api/webhook/app/<workflow>/<node>`. It reads CloudEvents in structured,
binary and batch form, checks the secret from the header named in the credential with a constant-time compare (401 if
wrong, 400 for a body that is not CloudEvents, 405 for other methods), and filters by event type pattern. The output is
`id`, `type`, `entity`, `action`, `keys`, `data`; the delivery key is `source|id`, so a redelivery does not run twice.
SAP's own event enablement (Event Mesh, Advanced Event Mesh) must be set up in SAP to post to this URL; Landflow does not
connect to a broker for this.

## Variables

| Variable | Meaning |
|---|---|
| `LANDFLOW_SAP_ALLOWED_HOSTS` | hosts the plugin may call (comma separated; `.suffix` matches subdomains); empty: any https host |
| `LANDFLOW_SAP_METADATA_TTL_SECONDS` | how long a service's `$metadata` is cached (default 3600) |

## What was and was not checked

Built and tested against the fake S/4HANA server (`plugins/sap/test/fake-s4.ts`) and live in a scratch host: a flow listing
sales orders, an agent whose Create Sales Order waited for approval and wrote only after it (5 to 6 orders), the poll
trigger firing exactly once after a change, and the event trigger refusing a wrong secret and running on the right one.
**Phase 0 was skipped (it needs an SAP account), so every item in the spec's UNVERIFIED list is still unverified**: field
names, event type strings, and OAuth and error shapes of a real tenant are as the spec recorded them. SAML (phase 5) and a
real system (phase 6) are not built.
