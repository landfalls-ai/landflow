# Landflow protocol conformance kit

Transport-neutral fixtures that every SDK face (HTTP, gRPC, messaging, MCP) and every broker driver must pass. The
fixtures say *what* is sent and *what must happen*; a **runner** per SDK × face (and per driver) knows *how* to send it
over its binding. Runners come in later waves; this directory holds the fixtures, their format and a TypeScript loader
(`import { loadConformanceSuites } from '@landflow/protocol/conformance'`).

```
conformance/
  README.md               this file
  index.ts                the loader and the fixture types
  plugin-manifest.json    the conformance plugin every runner embeds (its nodes are below)
  manifests/*.json        synthetic manifests for the MCP tool-mapping fixture
  fixtures/*.json         one suite per file (format below)
scripts/gen-conformance.ts   regenerates fixtures/mcp-tools.json from manifests/*.json (`pnpm --filter @landflow/protocol gen:conformance`)
```

## The conformance plugin

Every runner embeds a plugin with id `landflow-conformance` whose manifest is `plugin-manifest.json`. Its nodes have
fixed behaviour so a fixture can predict the reply:

| Node | Parameters | Behaviour |
|---|---|---|
| `echo` (idempotent) | `message` string | Emits each input item with `echo: <message>` added to its JSON; without items, one item `{ echo }`. |
| `sleep` | `ms` integer | Waits `ms` while watching the call's abort signal; emits `{ sleptMs: ms }`. When aborted it stops at once and fails with the message `canceled`. |
| `fail` | `message` string, `itemIndex` integer (optional) | Fails with `error: { message, itemIndex? }` and no outputs. |
| `payload` (idempotent) | `bytes` integer | Emits one item `{ data: "x" * bytes }`, so a reply can be made as large as the fixture wants. |
| `counter` | `key` string | Increments an in-process counter for `key` and emits `{ key, count }`: how a runner sees whether a call ran once or twice. |
| `tick` (trigger, `triggerSource: manual`) | – | Exists only so the MCP mapping has a trigger to leave out. |
| `hidden` (action, `mcp: false`) | `field` string | Exists only to be left out of the MCP tools. |

The `mcp-tools.json` fixture uses the manifests under `manifests/` instead; they cover resources, operations, option
opt-outs, collections, dynamic options, output schemas and annotation overrides (`crm-suite`, `twilio`, `utilities`),
and `edge-cases` the rest of the mapping: hints, code languages, json, number bounds, option value types, hide
conditions, nested dynamic options, null and false defaults, duplicate property names, operations split by auth
method, annotation overrides at both levels, resource-only tools, opt-outs at every level and `defaultVersion`. The
TypeScript, Go (`sdks/go/mcpface`) and Python (`landflow_sdk.mcp_tools`) mappings all reproduce it exactly.

## Fixture format

Every file is one suite:

```jsonc
{
  "kit": "landflow.conformance/v1",
  "suite": "deadlines",                       // file name without .json
  "description": "…",
  "applies": ["messaging", "mcp"],            // optional: faces the suite is for (default: every face)
  "cases": [ /* Case */ ]
}
```

A **case** is a call and what must happen:

```jsonc
{
  "id": "deadline-during-run",                // unique in the suite; runners report "<suite>/<id>"
  "description": "…",
  "applies": ["messaging"],                   // optional, as above
  "call": {
    "method": "execute",                      // execute | loadOptions | testCredentials | health | getManifest
    "node": "sleep",                          // execute: the conformance plugin's node (local name)
    "parameters": { "ms": 5000 },
    "items": [ { "json": {} } ],              // the single main input; default one empty item
    "deadlineMs": 200,                        // relative to the moment the runner sends; absent = the runner's default (30 s)
    "cancelAfterMs": 100,                     // the runner cancels the call this long after sending it
    "idempotencyKey": "k1",                   // sent as ExecuteRequest.idempotencyKey
    "repeat": 2,                              // send the same call this many times, one after another
    "padBytes": 1048576,                      // make `parameters.message` this long before sending (size limits)
    "tamper": "signature",                    // messaging only: break this before sending: signature | ciphertext | manifestHash
    "loadOptions": { "method": "colors" },    // loadOptions: the method; `testCredentials`: { "credentialType", "data" }
    "credentials": { "conformanceApi": { "token": "t" } }
  },
  "expect": {
    "outcome": "transport-error",             // or a list of acceptable outcomes; see below
    "code": "deadline_exceeded",              // transport-error: the error code (list below)
    "outputs": [[ { "json": { "echo": "hi" } } ]],  // reply: each listed item's JSON is a subset of the real one
    "errorMessage": "boom",                   // node-error: a substring of error.message
    "ran": false,                             // whether the node ran (the runner knows from the plugin's counters or hooks)
    "signalAborted": true,                    // the node saw its abort signal
    "withinMs": 1000,                         // the outcome arrived this soon after sending
    "deliveryMode": "at-most-once",           // messaging: the mode the core chose for the call
    "count": 1,                               // counter node: the count the (last) reply carries
    "note": "…"                               // free text for the runner's report
  }
}
```

**Outcomes**

| Outcome | Meaning |
|---|---|
| `reply` | the plugin answered; `ExecuteResponse.error` is absent |
| `node-error` | the plugin answered with `error` set (HTTP 200, a normal reply over a broker) |
| `transport-error` | the call failed before or around the plugin: the binding reports an error with a `code` |
| `no-reply` | nothing comes back and the runner's own timeout fires (only for cases that test that nothing leaks) |

**Transport error codes.** The first group is the envelope's `lferror` vocabulary (docs/protocol.md §14.6): a messaging
runner compares them literally, and HTTP, gRPC and MCP runners map their own signals to them. The second group is what
the caller detects itself.

| Code | When | HTTP | gRPC | MCP |
|---|---|---|---|---|
| `expired` | the deadline (`lfdeadline`, HTTP/gRPC deadline) passed before a reply; also what the caller sees when the consumer silently dropped the event (bad signature, bad ciphertext) | client timeout | `DEADLINE_EXCEEDED` | request timed out |
| `cancelled` | the caller cancelled (abort, cancel event, closed stream, `notifications/cancelled`) | request aborted | `CANCELLED` | stream closed |
| `too_large` | over the driver's `maxMessageBytes` (request: refused before publishing; reply: the plugin answers this code) | 413 | `RESOURCE_EXHAUSTED` | – |
| `not_found` | no such node type, load-options method or credential type | 404 | `NOT_FOUND` | unknown tool (-32602) |
| `bad_request` | the request does not validate | 400 | `INVALID_ARGUMENT` | invalid params (-32602) |
| `internal` | the plugin's dispatcher threw (a bug in the plugin server, not a node error) | 500 | `INTERNAL` | internal error (-32603) |
| `unavailable` | the plugin is draining or refused the call before running it | 503 | `UNAVAILABLE` | – |
| `manifest_mismatch` | the consumer's manifest hash differs from `lfmanifest` (the call was put back once, then answered) | – | – | – |
| `unauthenticated` | a bad or missing registry secret, gateway secret or MCP token | 401 | `UNAUTHENTICATED` | 401 |
| `unroutable` | the broker reported at once that no consumer could take the publish | – | – | – |
| `no_consumers` | every announced instance stopped heartbeating, or the channel shows zero consumers; nothing was published | connection refused | `UNAVAILABLE` | – |
| `not_connected` | the broker connection was not open; nothing was published | – | – | – |
| `connection_lost` | the connection carrying the reply ended while the call was in flight; the call may have run | – | – | – |

## Suites

| File | What it checks |
|---|---|
| `mcp-tools.json` | manifest in → tool definitions out, exactly (generated from `manifests/*.json`; regenerate after changing the mapping) |
| `deadlines.json` | met, already expired, expiring mid-call |
| `cancellation.json` | cancel mid-call, cancel after the reply, the signal reaches the node |
| `errors.json` | node errors, unknown node, malformed request, bad signature, manifest mismatch |
| `size-limits.json` | small, at the limit, over the limit (claim check or `payload_too_large`) |
| `delivery-modes.json` | which mode the core picks per node and method, and repeats with an idempotency key |

A runner may skip a case whose `applies` does not name its face, and reports skipped cases as such. Everything else
must pass.
