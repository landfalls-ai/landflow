# @landflow/sdk (TypeScript)

Write Landflow nodes in TypeScript, serve them over HTTP and/or gRPC, and announce them to the host.
The wire contract is [docs/protocol.md](../../docs/protocol.md); telemetry names are
[docs/observability.md](../../docs/observability.md). The example plugin is
[`plugins/text-toolkit`](../../plugins/text-toolkit).

| Import | What |
|---|---|
| `@landflow/sdk` | `defineNode`, `definePlugin`, `defineCredentialType`, `pollIntervalProperty`, `NodeOperationError`, context types, `runNode` / `runLoadOptions` / `runTestCredentials` (in-process), `createLogger`, redaction helpers |
| `@landflow/sdk/serve` | `serve(plugin, { http, grpc })`: telemetry + transports + announce |
| `@landflow/sdk/http` | `createFetchHandler(plugin, { telemetry? })`, `serveHttp` |
| `@landflow/sdk/grpc` | `createPluginService(plugin, { telemetry? })`, `serveGrpc` |
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
