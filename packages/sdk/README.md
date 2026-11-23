# @landflow/sdk (TypeScript)

Write Landflow nodes in TypeScript, serve them over HTTP and/or gRPC, and announce them to the host.
The wire contract is [docs/protocol.md](../../docs/protocol.md); telemetry names are
[docs/observability.md](../../docs/observability.md). The example plugin is
[`plugins/text-toolkit`](../../plugins/text-toolkit).

| Import | What |
|---|---|
| `@landflow/sdk` | `defineNode`, `definePlugin`, `defineCredentialType`, `pollIntervalProperty`, `NodeOperationError`, context types, `runNode` / `runLoadOptions` / `runTestCredentials` (in-process), `createLogger`, redaction helpers |
| `@landflow/sdk/serve` | `serve(plugin, { http, grpc, bindings?, maxConcurrency? })`: telemetry + one dispatcher + the faces + announce (each announce carries `INSTANCE_ID` from `@landflow/sdk/announce`, random per process, so a restart re-pulls the manifest) |
| `@landflow/sdk/http` | `createFetchHandler(plugin, { telemetry?, dispatcher? })`, `serveHttp`, `httpBinding({ port })` |
| `@landflow/sdk/grpc` | `createPluginService(plugin, { telemetry?, dispatcher? })`, `serveGrpc`, `grpcBinding({ port })` |
| `@landflow/sdk/binding` | `TransportBinding`, `BindingContext`, `BindingInfo`: one face of the plugin (see [Transports and bindings](#transports-and-bindings)) |
| `@landflow/sdk/dispatcher` | `createDispatcher(plugin, { maxConcurrency? })`, `DispatchError`: the transport-neutral entry point every face calls |
| `@landflow/sdk/telemetry` | `createTelemetry(options)` (tests, custom bootstraps) |

## A complete plugin

A credential type with a connection test, an action that uses it (child span, custom metric, traced
HTTP call), and a poll trigger. Fake values only.

```ts
import { defineCredentialType, defineNode, definePlugin, NodeOperationError, pollIntervalProperty } from '@landflow/sdk';
import { serve } from '@landflow/sdk/serve';

interface TelegramApi { accessToken: string; baseUrl: string; [key: string]: string }

const telegramApi = defineCredentialType<TelegramApi>({
  name: 'telegramApi',
  displayName: 'Telegram API',
  documentationUrl: 'https://core.telegram.org/bots#how-do-i-create-a-bot',
  properties: [
    { name: 'accessToken', displayName: 'Bot token', type: 'string', required: true, typeOptions: { password: true } },
    { name: 'baseUrl', displayName: 'API base URL', type: 'string', default: 'https://api.telegram.org' },
  ],
  // Present → the manifest says `testable: true` and the UI offers "Test connection".
  async test({ accessToken, baseUrl }, ctx) {
    const res = await ctx.http(`${baseUrl}/bot${accessToken}/getMe`);
    if (!res.ok) return { ok: false, message: `Telegram answered HTTP ${res.status}` };
    const { result } = (await res.json()) as { result: { username: string } };
    return { ok: true, message: `Authenticated as @${result.username}` };
  },
});

const sendMessage = defineNode({
  description: {
    name: 'sendMessage', displayName: 'Telegram: Send Message', description: 'Send a text message', version: 1, kind: 'action',
    inputs: [{ type: 'main' }], outputs: [{ type: 'main' }],
    credentials: [{ name: 'telegramApi', required: true }],
    properties: [
      { name: 'chatId', displayName: 'Chat ID', type: 'string', required: true },
      { name: 'text', displayName: 'Text', type: 'string', typeOptions: { rows: 3 } },
    ],
  },
  async execute(ctx) {
    const { accessToken, baseUrl } = ctx.getCredentials<TelegramApi>('telegramApi');
    const sent = ctx.metrics.counter('telegram.messages.sent', { description: 'Messages sent' });
    const out = [];
    for (const [i, item] of ctx.getInputData().entries()) {
      const chatId = ctx.getNodeParameter<string>('chatId', i);
      const body = await ctx.span('telegram.send', { 'telegram.chat_type': chatId.startsWith('-') ? 'group' : 'private' }, async (span) => {
        const res = await ctx.http(`${baseUrl}/bot${accessToken}/sendMessage`, {   // client span + traceparent; token redacted from url.full
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: ctx.getNodeParameter('text', i) }),
        });
        const json = (await res.json()) as { ok: boolean; description?: string; result?: { message_id: number } };
        if (!json.ok) throw new NodeOperationError(`Telegram: ${json.description}`, { itemIndex: i });
        span.setAttribute('telegram.message_id', json.result!.message_id);
        return json.result!;
      });
      sent.add(1, { 'telegram.chat_type': chatId.startsWith('-') ? 'group' : 'private' });
      ctx.logger.info('telegram sendMessage ok', { 'telegram.message_id': body.message_id });
      out.push({ json: { ...item.json, messageId: body.message_id } });
    }
    return out;
  },
});

const newMessage = defineNode({
  description: {
    name: 'newMessage', displayName: 'Telegram: New Message', description: 'Starts the workflow on new messages', version: 1,
    kind: 'trigger', triggerSource: 'poll',
    inputs: [], outputs: [{ type: 'main' }],
    credentials: [{ name: 'telegramApi', required: true }],
    properties: [pollIntervalProperty(30)],
  },
  async execute(ctx) {
    const { accessToken, baseUrl } = ctx.getCredentials<TelegramApi>('telegramApi');
    const offset = ctx.getPollState<{ offset: number }>()?.offset;
    const res = await ctx.http(`${baseUrl}/bot${accessToken}/getUpdates${offset && ctx.mode === 'poll' ? `?offset=${offset}` : ''}`);
    const { result } = (await res.json()) as { result: { update_id: number; message?: object }[] };
    if (ctx.mode === 'manual') return result.slice(-3).map((u) => ({ json: u as never }));   // recent items, state untouched
    const last = result.at(-1)?.update_id;
    ctx.setPollState({ offset: last !== undefined ? last + 1 : (offset ?? 0) });
    if (ctx.isFirstPoll()) return [];                                                            // baseline only
    return result.map((u) => ({ json: u as never }));
  },
});

export const plugin = definePlugin({
  info: { id: 'telegram', name: 'Telegram', version: '0.1.0', color: '#229ED9' },
  nodes: [sendMessage, newMessage],
  credentialTypes: [telegramApi],
});

if (import.meta.url === `file://${process.argv[1]}`) await serve(plugin, { http: 7110, grpc: 7210 });
```

## The execute context

Everything from before still works (`getNodeParameter`, `getInputData`, `helpers.httpRequest`,
`logger.info(msg)`, `getCredentials()`); the additions are marked ★.

| Member | |
|---|---|
| `getInputData(i?)`, `getInputCount()`, `getNodeParameter(name, i?, fallback?)` | items and resolved parameters |
| `getMode()` / ★ `mode` | `'manual' \| 'trigger' \| 'webhook' \| 'tool' \| 'chat' \| 'poll'` |
| ★ `continueOnFail()` | the node is set to continue on error: catch a failing item, push `{ json: { error }, pairedItem: { item: i } }`, go on |
| ★ `getIdempotencyKey()` | `<executionId>:<nodeId>:<runIndex>`, the same across retries of this step; pass it to APIs that take an idempotency key (`undefined` from older hosts) |
| ★ `getCredentials<T>(name)` | that credential type's data; throws a `NodeOperationError` when the host sent none |
| ★ `getCredentials<T>(name, { optional: true })` | same, `undefined` when absent (for `required: false`) |
| `getCredentials<T>()` | the only credential sent (or `undefined`); throws if several were sent |
| ★ `artifact({ name, kind?, url?, mimeType?, text?, data? })` / `check({ name, status, message?, subject?, evidence? })` | report what the node made (a pull request, a file, a ticket) or checked (`status`: `pass` `fail` `warn` `skip`) for the run's trace. In-process they reach the engine live (`onRecord`); a remote plugin returns them in `ExecuteResponse.records`, stamped with the time and with credential values masked ([protocol §3](../../docs/protocol.md#3-messages-json-shapes)) |
| ★ `getPollState<T>()` / `setPollState(state)` / `isFirstPoll()` | poll triggers, see below |
| ★ `span(name, attrs?, fn, { kind }?)` | child span; `fn(span)` gets the OTel `Span`; a throw sets error status + `exception` event and is rethrown. `kind: 'client'` for a call over a protocol `http` doesn't cover (SMTP, a database driver) |
| ★ `metrics.counter(name, opts?).add(v, attrs?)` | custom counter |
| ★ `metrics.histogram(name, { unit, buckets? }).record(v, attrs?)` | `unit: 'ms'` gets the Landflow duration buckets |
| ★ `metrics.gauge(name, opts?).set(v, attrs?)` | last value |
| ★ `http(url, init?)` | `fetch` with an `HTTP {METHOD}` client span, `traceparent`/`tracestate`/`baggage` injected, `http.client.request.duration` |
| `helpers.httpRequest(options)` | now traced the same way |
| `logger.debug/info/warn/error(msg, attrs?)` | returned to the host as node logs **and** written to the process log with trace ids (★ `attrs`) |

The LoadOptions context (`methods.loadOptions[name](ctx)`) has `getCurrentParameters()`,
`getNodeParameter(name, fallback?)`, `getCredentials(...)`, `http`, `span`, `logger`, `helpers.httpRequest`.
The credential test context has `credentialType`, `http`, `span`, `logger`, `helpers.httpRequest`.

## Credentials

- Declare types in `definePlugin({ credentialTypes })`, typed with `defineCredentialType<T>()`.
  `buildManifest` puts the descriptors in `PluginManifest.credentialTypes` without the `test` function and
  with `testable: true` when there is one. Names are identifiers (`/^[a-zA-Z][a-zA-Z0-9_-]*$/`).
- Nodes list what they use in `description.credentials: [{ name, required? }]`. `definePlugin` throws when
  a node references an undeclared type.
- The host sends the decrypted values keyed by type name on Execute and LoadOptions. Give every integration
  an overridable `baseUrl` (or host/port) so it can point at a proxy or a test double.
- **TestCredentials** is served on `POST /landflow/v1/test-credentials` and gRPC `TestCredentials`. A type without
  `test` answers `{ ok: false, message }`, a test that throws gives `{ ok: false, message: error.message }`, and an
  unknown type is HTTP 404 / gRPC `NOT_FOUND`. In-process: `runTestCredentials(plugin, { credentialType, data })`.
- **Redaction**: while a call runs, the values of `typeOptions.password` fields and of fields named like a
  secret (`/(token|secret|password|authorization|api[-_]?key|cookie)/i`) are scrubbed from every log line,
  node log, error message and span attribute/event, raw and URL-encoded, so a token in a URL path shows up
  as `[REDACTED]`. Values shorter than 4 characters are not scrubbed. For a credential type the plugin
  doesn't declare, every string value counts as a secret. Attribute and log keys matching the pattern are
  always redacted.

## Polling triggers

A node with `kind: 'trigger', triggerSource: 'poll'` must have a number property `pollInterval`
(`pollIntervalProperty(defaultSeconds = 60)`, minimum 10; `definePlugin` checks). The host calls Execute
with `mode: 'poll'`, no inputs and the previous `pollState`:

| Situation | Node should | The SDK enforces |
|---|---|---|
| first poll (`ctx.isFirstPoll()`) | record a baseline with `setPollState`, return `[]` | drops any items (with a warning in the node logs). If the node set no state it returns `{ baselineAt: <iso> }` so the next poll is not "first" again |
| later polls | return only new items, `setPollState(next)` | echoes the previous state if `setPollState` was not called |
| `mode: 'manual'` (Execute in the editor) | return the most recent few events, ignore state | never returns `pollState` |
| node throws | – | no `pollState` in the response, so the host keeps the old one |

## App webhook triggers

A node with `kind: 'trigger', triggerSource: 'appWebhook'` registers a webhook at the service when its workflow is
published and removes it when it is unpublished ([protocol §12](../../docs/protocol.md#12-app-webhook-triggers)).
It needs `webhookMethods.create`, `webhookMethods.delete` and `webhook()` (`definePlugin` checks):

```ts
import { verifyGitHubSignature, type INodeType } from '@landflow/sdk';

const repoEvents: INodeType = {
  description: { name: 'repoEvents', displayName: 'Repo Events', kind: 'trigger', triggerSource: 'appWebhook', /* … */ },
  webhookMethods: {
    async checkExists(ctx) { return Boolean(await getHook(ctx, ctx.getStaticData().webhookId)) },
    async create(ctx) {
      const secret = randomBytes(32).toString('hex');
      const hook = await createHook(ctx, ctx.getWebhookUrl(), secret);
      ctx.setStaticData({ webhookId: hook.id, webhookSecret: secret });
    },
    async delete(ctx) { await deleteHook(ctx, ctx.getStaticData().webhookId); ctx.setStaticData({}) },
  },
  async webhook(ctx) {
    const { webhookSecret } = ctx.getStaticData<{ webhookSecret: string }>();
    if (!verifyGitHubSignature(webhookSecret, ctx.getRawBody(), ctx.getHeader('x-hub-signature-256'))) return { response: { status: 401 } };
    return { items: [{ json: ctx.getBody() }], idempotencyKey: ctx.getHeader('x-github-delivery') };
  },
  async execute() { return [[]] }, // a manual run has no event to show
};
```

- `getStaticData()` is what the host keeps for this workflow and node (change it in place or `setStaticData()`); it
  goes back with the response only when it changed.
- `webhook()` returns `items` (none: no run), a `response` (`status`, `headers`, `body` or `json`; default 200) and
  an `idempotencyKey` so a redelivery starts no second run. Thrown errors come back as `error`, never as a crash.
- Signature helpers: `verifyGitHubSignature`, `verifyStripeSignature(secret, body, header, { toleranceSeconds })`,
  `verifySlackSignature(secret, body, timestamp, signature)`, `verifyHmacSha256({ secret, payload, signature, prefix,
  encoding })`, the matching `githubSignature` / `stripeSignature` / `slackSignature` for tests, and `safeEqual`. All
  compare in constant time; Stripe and Slack refuse timestamps older than 5 minutes.
- JWTs: `rs256Sign(privateKeyPem, payload, headers?)` and `githubAppJwt(appId, privateKeyPem, now?)` (`iss` = app id, `iat` = now − 60 s, `exp` = now + 540 s) sign with
  `node:crypto` (PKCS#1 or PKCS#8 PEM) for services that authenticate the client with a token, GitHub Apps first. Python has the same
  (`landflow_sdk.jwt`) and Go (`landflow.GitHubAppJWT`).
- Activity items ([protocol §16](../../docs/protocol.md#16-activity-items)): `activityItem({ source, sourceId, occurredAt,
  kind, title, summary, url, actorEmail, teamHint, initiativeHint, customerHint, raw, cursor })` returns the normalised
  item a trigger or List Changed Since operation outputs (summary clipped to 600, `raw` trimmed, time as ISO UTC), and
  `ACTIVITY_ITEM_SCHEMA` is its `outputSchema`. Go and Python build the same item from the same input.

## Transports and bindings

A plugin has one core and several faces ([docs/transports.md](../../docs/transports.md)). The **dispatcher** runs the
node with spans, metrics, redaction and credentials, and adds what a wire cannot: a **deadline** (epoch ms; a call that
is already late is refused with `deadline_exceeded` and never runs, otherwise `ctx.deadline` says when to stop and
`ctx.signal` aborts when it passes), **cancellation** (`ctx.signal` aborts when the caller goes away, also aborting
`ctx.http` and the binary helpers) and the **concurrency limit** (`maxConcurrency` calls run at once; the next ones wait
in order, still honouring their deadline; when as many are waiting as may run, further calls are refused with
`capacity`, HTTP 429 / gRPC `RESOURCE_EXHAUSTED`, so the host can send them elsewhere knowing they never ran).
`dispatcher.stats()` gives `inFlight` and `queued`.

A **binding** owns one wire and calls the dispatcher. HTTP (`httpBinding`) reads the deadline from the
`x-landflow-deadline` header and cancels when the connection closes; gRPC (`grpcBinding`) uses the call's own deadline and
cancellation. Any other face is a `TransportBinding` passed in `bindings`:

```ts
import { serve } from '@landflow/sdk/serve';
import type { TransportBinding } from '@landflow/sdk';

const face: TransportBinding = {
  kind: 'fake',
  async start(context) {
    // context.dispatcher, context.manifest (hints included), context.telemetry, context.logger, context.hints,
    // context.advertiseHost, context.announce(endpoints) / context.withdraw(endpoints) for endpoints learnt later
    const response = await context.dispatcher.execute(request, { transport: 'fake', deadline: Date.now() + 30_000, signal, parent });
    return { endpoints: ['fake://conn-1/my-plugin'], description: 'fake connected' };
  },
  async stop() { /* stop taking calls, await context.dispatcher.drain(), close */ },
};
await serve(plugin, { http: 7101, grpc: 7201, bindings: [face], maxConcurrency: 8 });
```

`serve()` starts every face given, unless `LANDFLOW_TRANSPORTS` (a comma list, e.g. `http,grpc,kafka`) picks a subset; a
kind named there that nothing provides is an error. The manifest and every announce carry the hints `transports` (the
faces that started, `mcp` included when the MCP face is on) and `maxConcurrency` (`LANDFLOW_MAX_CONCURRENCY` overrides the
option).

### Brokers (the messaging face)

A plugin is reachable through any broker `@landflow/transports` has a driver for ([docs/transports.md](../../docs/transports.md)
"Generic messaging", protocol §14), with no inbound port. Give `serve()` a `BrokerTarget` from the driver module, or
nothing but environment variables:

```ts
import { kafka } from '@landflow/transports/kafka';
await serve(plugin, { http: 7101, brokers: [kafka({ brokers: ['127.0.0.1:59092'] })] });
```

```sh
LANDFLOW_TRANSPORTS=http,kafka LANDFLOW_KAFKA_URL=kafka://127.0.0.1:59092 LANDFLOW_TRANSPORT_SECRET=… node main.js
```

`LANDFLOW_<KIND>_URL` (plus `LANDFLOW_<KIND>_USERNAME`, `_PASSWORD`, `_TLS=true`, `_PREFIX` when the broker needs them)
loads the driver module for the kind on first use and builds the connection `env-<kind>`. Each broker is one binding
(`messagingBinding(target)` from `@landflow/sdk/messaging`) wrapping the messaging core's `MessagingServer` around the
dispatcher: the CloudEvents envelope, end-to-end encryption and signing (`LANDFLOW_TRANSPORT_SECRET`, falling back to
`LANDFLOW_REGISTRY_SECRET`; `serve()` refuses to start without one), at most once by default and at least once for
`idempotent` nodes, deadlines, cancel events, the `maxConcurrency` prefetch, and an announce with a registry proof on the
broker's registry channel every 10 s (the host learns the plugin from it, so brokered endpoints are not part of the HTTP
announce). Refused calls become `lferror` codes (`not_found`, `bad_request`, `expired`, `cancelled`, `unavailable`); server
spans carry `messaging.system`, `messaging.destination.name` and `messaging.operation.type`. `stop()` withdraws, waits
for the calls in flight and closes the connection.

### MCP (every plugin is also an MCP server)

Every action node's operations are MCP tools (`mcpToolsFromManifest()` in `@landflow/protocol`, protocol §15.1: `mcp:
false` opts out, `outputSchema` and `toolAnnotations` are honoured), served with no code in the plugin:

- **Streamable HTTP at `/mcp`** on the HTTP port, on by default, stateless, for both the 2026-07-28 revision
  (`server/discover`, per-request `_meta` envelope) and 2025-era clients (`initialize`). Listed as `endpoints.mcp` in
  `/.well-known/landflow`. `LANDFLOW_MCP=off` (or `mcp: false`) turns it off.
- **Token.** Callers send `Authorization: Bearer $LANDFLOW_MCP_TOKEN` (`mcp: { token }`); a missing or wrong one is `401`
  with `WWW-Authenticate: Bearer`. No token is needed when the server listens on loopback only (`host: '127.0.0.1'`).
  Without a token on a non-loopback host the MCP face stays off and `serve()` logs an error line saying so; the other
  faces still serve.
- **stdio** with `--mcp-stdio` or `LANDFLOW_MCP=stdio`: MCP on stdin/stdout and nothing else (no HTTP, gRPC, brokers or
  announce; logs on stderr), so a desktop agent can start the plugin directly.
- **Credentials** come from `LANDFLOW_MCP_CREDENTIALS`: a JSON file path or inline JSON, `{ "<credentialType>": { …fields } }`
  by local type name (`mcp: { credentials }` in code). A tool whose node needs a credential that is not configured answers
  `isError: true` naming the missing type and its fields. When a tool has dynamic options and a credential is configured, a
  read-only `list_options` tool resolves them (`{ tool, parameter, arguments? }`).
- **Results**: the node's first output as `structuredContent: { items }` plus a short text; a node error is `isError: true`
  with its message. Closing the request's stream cancels the call. Spans are the usual `plugin.execute …` with
  `rpc.system: mcp` and `mcp.tool.name`.

`createMcpFace()` in `@landflow/sdk/mcp` builds the face over any dispatcher (its `tools`, a server factory for the MCP
SDK's transport entries, and the token-checking `fetch`); `serve()` returns it as `result.mcp`.

## Observability

`serve()` calls `createTelemetry()` and installs the result as the process default and the OpenTelemetry
globals. Configuration is the standard OTel environment plus the `LANDFLOW_*` variables in
observability.md §1:

- Resource: `service.name` (`OTEL_SERVICE_NAME`, default `landflow-plugin-<pluginId>`), `service.version`,
  `service.namespace=landflow`, `landflow.plugin.id`, `landflow.plugin.language`, `telemetry.sdk.*` and
  `OTEL_RESOURCE_ATTRIBUTES`.
- OTLP exporters are created only when `OTEL_EXPORTER_OTLP_ENDPOINT` (or the `_TRACES_` / `_METRICS_` variants)
  is set. The TypeScript SDK sends **OTLP/HTTP JSON** (`/v1/traces`, `/v1/metrics`), with metrics every
  `OTEL_METRIC_EXPORT_INTERVAL` ms. `OTEL_TRACES_SAMPLER(_ARG)` is honoured. `OTEL_SDK_DISABLED=true` makes spans and
  metrics no-ops; logs keep the caller's trace id.
- Server spans: `plugin.execute {type}`, `plugin.load_options {method}` and `plugin.test_credentials {type}`, children
  of the host's `traceparent` (HTTP headers or gRPC metadata), with the spec attributes plus `rpc.system`,
  `rpc.service` and `rpc.method`. Health, manifest, well-known and `/metrics` get no spans.
- Automatic metrics: `landflow.plugin.executions`, `landflow.plugin.execute.duration` (ms),
  `landflow.plugin.items`, `landflow.plugin.load_options`, `http.client.request.duration` (s).
- Custom metrics: names must match `^[a-z][a-z0-9_.]{0,100}$` (an invalid name throws, so it shows up in the
  first test run). `landflow.plugin.id`, `landflow.node.type` and `landflow.workflow.id` are added, string values are
  truncated to 100 characters, and from the 1001st attribute set on, measurements fold into `otel.metric.overflow=true`.
- `GET /metrics` on the HTTP port serves Prometheus text (`LANDFLOW_METRICS_PROMETHEUS`, default on). Names are
  the OTel name with `.` → `_` plus a unit suffix and `_total` for counters:
  `landflow_plugin_execute_duration_milliseconds`, `telegram_messages_sent_total`.
- Process log: one JSON line per event (`LANDFLOW_LOG_FORMAT=pretty` for humans, `LANDFLOW_LOG_LEVEL`) with
  `trace_id`/`span_id` of the active span, plus a `span.end` line per finished span (`LANDFLOW_LOG_SPANS`).

**In-process nodes** (the host's built-ins via `runNode`) use the global OTel tracer/meter, so their spans
and metrics join whatever the host registered. Their process log stays silent; the host gets node logs through
`ExecuteResponse.logs` / `onLog`. `ContextExtras` accepts `telemetry`, `credentialTypes` and `pluginId`.

**Testing** without globals or stdout:

```ts
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { createTelemetry } from '@landflow/sdk/telemetry';
import { createFetchHandler } from '@landflow/sdk/http';

const exporter = new InMemorySpanExporter();
const lines: string[] = [];
const telemetry = await createTelemetry({ pluginId: 'telegram', env: {}, spanExporters: [exporter], logWriter: (l) => lines.push(l) });
const handle = createFetchHandler(plugin, { telemetry });          // or serveGrpc(plugin, { port, telemetry })
// … exporter.getFinishedSpans(), await telemetry.scrapeMetrics(), lines.map(JSON.parse)
```

`createTelemetry` also takes `spanProcessors`, `metricReaders` and `registerGlobal`. See `test/telemetry.test.ts`
and `test/credentials-poll.test.ts` for complete examples over both transports.

```sh
pnpm --filter @landflow/sdk test
pnpm --filter @landflow/sdk typecheck
```
