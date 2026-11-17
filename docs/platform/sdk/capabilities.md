# What a plugin can do

Everything a node plugin can use, with a short sample and what each SDK supports. The three SDKs are close to equal;
the table says where they are not. Part of [Writing node plugins](README.md).

**Reading the table.** `yes` means the SDK has it and a test or a bundled plugin uses it. `in-process only` means the
host's built-in nodes can do it but a plugin process cannot. `no` means nothing exists. The columns are the SDK code
on this branch, checked in `packages/sdk/src`, `sdks/python/landflow_sdk` and `sdks/go`.

| Capability | TypeScript | Python | Go | Section |
|---|---|---|---|---|
| Action nodes (items in, items out) | yes | yes | yes | [Actions](#actions-and-outputs) |
| Several outputs (branches) | yes | yes | yes | [Actions](#actions-and-outputs) |
| Poll trigger | yes | yes | yes | [Triggers](#triggers) |
| App webhook trigger (register, verify, run) | yes | yes | yes | [Triggers](#triggers) |
| `webhook`, `schedule`, `chat`, `manual` trigger sources | descriptor accepts them; `webhook` and `schedule` are never started for a plugin, `manual` and `chat` start only by hand | same | same | [Triggers](#triggers) |
| 13 parameter types, `displayOptions`, `typeOptions` | yes | yes | yes | [Parameters](#parameters) |
| Dynamic dropdowns (`loadOptions`) | yes, with credentials | yes, with credentials | yes, with credentials | [Parameters](#parameters) |
| Credential types, "Test connection" | yes | yes | yes | [Credentials](#credentials) |
| OAuth2 credentials (`extends: ['oAuth2Api']`) | yes | yes | yes | [Credentials](#credentials) |
| Secret redaction in logs, spans and errors | yes | yes | yes | [Credentials](#credentials) |
| Binary data (files on items) | yes | yes | yes | [Binary data](#binary-data) |
| Typed errors with item index and hint | `NodeOperationError` | `NodeOperationError` | `ItemError`, `NodeError` | [Errors](#errors-retries-and-continue-on-fail) |
| Continue on fail | `ctx.continueOnFail()` | `ctx.continue_on_fail()` | `ctx.ContinueOnFail()`, `ctx.ErrorItem` | [Errors](#errors-retries-and-continue-on-fail) |
| Retries, timeouts | host setting, not SDK code | same | same | [Errors](#errors-retries-and-continue-on-fail) |
| Idempotency key, `idempotent` flag | yes | yes | yes | [Errors](#errors-retries-and-continue-on-fail) |
| Pagination helpers | no | no | no | [Pagination](#pagination) |
| Usable as an agent tool (`usableAsTool`) | yes | yes | yes | [AI, tools and sub-nodes](#ai-tools-and-sub-nodes) |
| Report a model call (`ctx.model`, `meterAiUsage`) | yes | yes | yes | [AI, tools and sub-nodes](#ai-tools-and-sub-nodes) |
| Sub-nodes (model, memory, tool supplied to an AI node) | in-process only | in-process only | in-process only | [AI, tools and sub-nodes](#ai-tools-and-sub-nodes) |
| Wait, node state, streaming chunks, progress | in-process only | in-process only | in-process only | [What a plugin cannot do](#what-a-plugin-cannot-do) |
| MCP face (`/mcp`, stdio) | built in | `[mcp]` extra | built in | [MCP](#mcp-faces) |
| Brokers (Kafka, AMQP, NATS, JetStream, Valkey) | yes | yes, extras | yes, nested modules | [Transports](README.md#transports) |
| Brokers (MQTT, AMQP 1.0, SQS, Pub/Sub, Pulsar, Service Bus) | native drivers | through `landflow-bridge` | through `landflow-bridge` | [Transports](README.md#transports) |
| Icons and brand colour (`file:` SVG/PNG) | `iconDir` | `icon_dir` | `IconFS` | [Branding](#branding-and-icons) |
| Node versions (`version`, `defaultVersion`) | yes | yes | yes, `V(1, 2)` | [Versioning](#versioning) |
| Composite types, `capabilities` tags | `defineComposite` | `composites=` | `PluginInfo.Composites` | [Composites](#composites-and-capability-tags) |
| `artifact()` and `check()` records for the Run Trace | yes | yes | yes | [Records](#records-for-the-run-trace) |
| Cancellation and deadline | `ctx.signal`, `ctx.deadline` | `ctx.cancel`, `ctx.deadline` | `ctx` is a `context.Context` | [Records](#records-for-the-run-trace) |
| Traced `http`, spans, metrics, logs | yes | yes | yes | [Observability](#observability) |
| Signature helpers (GitHub, Stripe, Slack, HMAC) | yes | yes | yes | [Triggers](#triggers) |
| GitHub App JWT (`rs256Sign`) | yes | yes | yes | [Credentials](#credentials) |
| Activity items for the second brain | yes | yes | yes | [Activity items](#activity-items) |
| Marketplace entry, bundled flows | yes | yes | yes | [Marketplace](#marketplace-format-and-bundled-flows) |

The code samples below are copied from the working examples in `examples/sdk/` and from the bundled plugins. Each
shows one language; the other two do the same with the names in the table.

## Actions and outputs

An action takes items in and returns items out. `ctx.getInputData()` gives the items on the main input,
`ctx.getNodeParameter(name, i)` the parameter for item `i` (the host has already resolved expressions), and the return
value is one array of items per output. A flat array is one output. A node with two outputs lists two ports, and returns
two arrays: nothing in the first and something in the second is how a node branches.

```ts
    outputs: [
      { type: 'main', displayName: 'Greeted' },
      { type: 'main', displayName: 'Skipped' },
    ],
```

<sub>From `examples/sdk/typescript/hello-node/src/plugin.ts`.</sub>

```ts
    return [greeted, skipped];
```

<sub>From `examples/sdk/typescript/hello-node/src/plugin.ts`.</sub>

- **Python**: `return [greeted, skipped]`; a flat list is one output. **Go**: `return [][]landflow.Item{greeted, skipped}, nil`;
  returning `nil` gives one empty branch per `main` output.
- Items are `{ json, binary?, pairedItem? }`. The SDKs fill `pairedItem` when an output has as many items as input 0, so
  expressions such as `$('Node').item` keep working. Set it yourself when you add or drop items.
- Do not change the input item in place; copy it (`{ ...item.json, x }`, `{**item["json"], "x": x}`, a copied map in Go).
- Write `kind` explicitly in TypeScript and Python; Go defaults it to `action` (or `trigger` when `triggerSource` is set).
  Mark a node that only reads `idempotent: true` (see [Errors](#errors-retries-and-continue-on-fail)).
- `subtitle: '{{name}}'` puts a parameter under the node's title on the canvas.

## Triggers

A trigger starts a workflow run. A plugin has two ways to do it:

| Source | Descriptor | Who calls whom | Samples |
|---|---|---|---|
| **Poll** | `kind: 'trigger'`, `triggerSource: 'poll'`, a `pollInterval` property (minimum 10 s) | the host calls `Execute` with `mode: 'poll'` every interval, passing the state the last call returned | `newRequest` in all three examples |
| **App webhook** | `triggerSource: 'appWebhook'`, plus `webhookMethods` | the host asks the node to register a webhook at the service when the workflow is published, and to remove it when it is unpublished; the service then calls the host's URL, and the host calls the node's `webhook()` | `plugins/attio/src/nodes/attio-trigger.ts`, `plugins/productivity/productivity/github.py` |

The other sources (`manual`, `webhook`, `schedule`, `chat`) are valid in a descriptor, but they name the entry points of the
host's own nodes (the Webhook, Schedule and Chat triggers): the host schedules `poll` triggers and registers
`appWebhook` triggers for plugin nodes (`apps/web/src/lib/server/poller.ts`,
`apps/web/src/lib/server/plugins/registry.ts:872`), and starts nothing else on its own. A `webhook` or `schedule` plugin
trigger is never started. A `manual` or `chat` one runs only by hand: Execute, the run API and the MCP tools pick the
first `manual` trigger, the editor chat the `chat` one (`findTrigger()`, `apps/web/src/lib/server/runner/run.ts:346`).
Write a plugin trigger as one of the two above.

**Poll.** The first poll (`ctx.isFirstPoll()`) records a baseline and returns nothing, so activating a workflow does not
replay history. Later polls return only what is new and set the next state. A manual run (the editor's Execute) returns
the latest few items and no state. The SDK enforces the rules: it drops items on a first poll, never returns state in
manual mode, and returns no state when the node throws, so the host retries from the same point
([protocol §8](../../protocol.md#8-polling-triggers)).

```ts
export const newRequest = defineNode({
  description: {
    name: 'newRequest',
    displayName: 'Hello: New Request',
    description: 'Starts the workflow for each new greeting request',
    version: 1,
    kind: 'trigger',
    triggerSource: 'poll',
    inputs: [],
    outputs: [{ type: 'main' }],
    credentials: [{ name: 'helloApi', required: true }],
    properties: [pollIntervalProperty(30)],
  },
  async execute(ctx) {
    ctx.getCredentials<HelloApi>('helloApi');
    const newest = Math.max(0, ...requests.map((r) => r.id));
    if (ctx.mode === 'manual') return requests.slice(-3).map((r) => ({ json: { ...r } })); // "Execute" in the editor: a few recent items, no state
    if (ctx.isFirstPoll()) {
      ctx.setPollState({ lastId: newest }); // baseline: remember where we are and emit nothing
      return [];
    }
    const lastId = ctx.getPollState<{ lastId: number }>()?.lastId ?? 0;
    ctx.setPollState({ lastId: Math.max(lastId, newest) });
    return requests.filter((r) => r.id > lastId).map((r) => ({ json: { ...r } }));
  },
});
```

<sub>From `examples/sdk/typescript/hello-node/src/plugin.ts`.</sub>

Python: `ctx.get_poll_state()`, `ctx.set_poll_state(dict)`, `ctx.is_first_poll()`, `poll_interval_property(30)`. Go:
`ctx.PollState()`, `ctx.SetPollState(map)`, `ctx.IsFirstPoll()`, `landflow.PollIntervalProperty(30)` (added for you when
you leave it out).

**App webhook.** The node implements `checkExists`, `create` and `delete` (the host's registration calls) and
`webhook` (a delivery). `getStaticData()` is what the host keeps per workflow and node: store the hook id and the signing
secret there. Verify the signature before you trust the body, return an `idempotencyKey` (the delivery id) so a
redelivery starts no second run, and return `response: { status: 401 }` for a bad signature. Items-less results start no
run. Signature helpers in every SDK: GitHub, Stripe, Slack and plain HMAC-SHA256, all constant-time
([protocol §12](../../protocol.md#12-app-webhook-triggers)).

```ts
    async delete(ctx) {
      const { webhookId } = ctx.getStaticData<TriggerStatic>();
      if (webhookId) await attioCall(ctx.http, credentialsOf(ctx), 'DELETE', `/webhooks/${webhookId}`, { allow: [404] });
      ctx.setStaticData({});
      return true;
    },
  },
  async webhook(ctx) {
    const stored = ctx.getStaticData<TriggerStatic>();
    const secret = stored.secret?.trim();
    // Attio-Signature: hex HMAC-SHA256 of the raw body, keyed with the webhook secret. X-Attio-Signature is the legacy name.
    const signature = ctx.getHeader('attio-signature') ?? ctx.getHeader('x-attio-signature');
    if (!secret || !verifyHmacSha256({ secret, payload: ctx.getRawBody(), signature })) {
      ctx.logger.warn(secret ? 'rejected a call with a missing or invalid Attio signature' : 'rejected a call: no Attio webhook secret is stored (publish the workflow again)');
      return { response: { status: 401, json: { error: 'invalid signature' } } };
    }
    const body = asObject(ctx.getBody<JsonObject>());
    const events = asArray(body?.events).map(asObject).filter((e): e is JsonObject => Boolean(e));
    if (!events.length) return ignored('no events');
    const wanted = new Set(asArray(ctx.getNodeParameter<unknown[]>('events', [...SUPPORTED_EVENTS])).map(String));
    const objects = String(ctx.getNodeParameter('objects', 'companies,people,deals') ?? '').split(/[,\s]+/).filter(Boolean);
    const options = activityOptions(asObject(ctx.getNodeParameter<JsonObject>('options', {})));
    const lookup = new AttioLookup(ctx.http, attioCredentials(ctx, ctx.getNodeParameter('authentication', 'accessToken')), cacheOf(stored.lookups), (m) => ctx.logger.warn(m));
    const items: JsonObject[] = [];
    for (const event of events) {
      if (!wanted.has(String(event.event_type))) continue;
      const item = await ctx.span('attio.event', { 'attio.event_type': String(event.event_type) }, () => eventItem(lookup, event, options, objects));
      if (item) items.push(item);
    }
    if (lookup.changed) ctx.setStaticData({ ...ctx.getStaticData<TriggerStatic>(), lookups: lookup.cache });
    if (!items.length) return ignored('filtered out');
    // Attio redelivers (at least once, up to 10 times) with the same Idempotency-Key header, which keeps it to one run.
    const key = ctx.getHeader('idempotency-key') ?? hmacSha256('attio', ctx.getRawBody());
    return { items, idempotencyKey: key };
```

<sub>From `plugins/attio/src/nodes/attio-trigger.ts`.</sub>

Python names: `webhook_check_exists`, `webhook_create`, `webhook_delete`, `webhook`, `ctx.get_static_data()`,
`ctx.set_static_data()`, `ctx.get_webhook_url()`, `verify_github_signature`:

```python
    def webhook(self, ctx):
        static = ctx.get_static_data()
        secret = str(static.get("webhookSecret") or "")
        if not verify_github_signature(secret, ctx.get_raw_body(), ctx.get_header("X-Hub-Signature-256")):
            ctx.logger.warn("rejected a delivery with a missing or invalid X-Hub-Signature-256")
            return {"response": {"status": 401, "json": {"error": "invalid signature"}}}
        event = ctx.get_header("X-GitHub-Event") or "unknown"
        delivery = ctx.get_header("X-GitHub-Delivery")
        body = ctx.get_body()
        if event == "ping":  # sent once when the hook is created
            return {"response": {"status": 200, "json": {"ok": True, "hookId": (body or {}).get("hook_id") if isinstance(body, dict) else None}}}
        events = static.get("webhookEvents") or ["*"]
        if "*" not in events and event not in events:
            return {"response": {"status": 202, "json": {"ignored": event}}}
        headers = {name: ctx.get_header(name) for name in DELIVERY_HEADERS if ctx.get_header(name) is not None}
        item = {
            "event": event,
            "action": body.get("action") if isinstance(body, dict) else None,
            "deliveryId": delivery,
            "body": body,
            "headers": headers,
        }
        count_new_items(ctx, "githubWebhook", 1)
        return {"items": [item], **({"idempotencyKey": delivery} if delivery else {})}
```

<sub>From `plugins/productivity/productivity/github.py`.</sub>

Go implements `landflow.WebhookNode` (`WebhookCreate`, `WebhookDelete`, `Webhook`) and optionally `WebhookChecker`
(`sdks/go/webhooks.go:41`). The registration needs the host's public URL (`LANDFLOW_PUBLIC_URL`), and a service that
only accepts https needs a tunnel in development.

## Parameters

A node's `properties` are its form. The editor draws it, so you write no UI.

| Type | Use |
|---|---|
| `string`, `number`, `boolean` | the basics; `typeOptions` adds `password`, `rows`, `minValue`, `maxValue`, `numberPrecision`, `multipleValues` |
| `options`, `multiOptions` | a fixed list `{ name, value, description }`, or a dynamic one |
| `json`, `code` | structured or script text; `typeOptions.language` names the language |
| `collection`, `fixedCollection` | an optional group of fields; a repeatable group |
| `color`, `dateTime` | pickers |
| `notice` | a line of text in the form, no value |
| `hidden` | a value the user does not see (a fixed URL in a credential type) |

- **Show and hide.** `displayOptions: { show: { resource: ['issue'], operation: ['create'] } }` shows a property only
  for those values (n8n's rule). Inside a collection a plain key is a sibling and `/key` a top-level parameter.
- **Resource and operation.** One node with a `resource` and an `operation` option is how the integration plugins group
  many calls in one node; each operation becomes an MCP tool ([protocol §15.1](../../protocol.md#15-mcp)).
- **Dynamic dropdowns.** `typeOptions.loadOptionsMethod: 'getTeams'` makes the editor call `POST /landflow/v1/load-options`
  with the current parameters and the node's credentials, and show what comes back as `[{ name, value, description? }]`.
  The method is `methods.loadOptions.getTeams(ctx)` in TypeScript, `load_options(method, parameters[, ctx])` in Python
  (a third argument gives a `LoadOptionsContext` with credentials) and `LoadOptions` or `LoadOptionsWithContext` in Go.

```ts
  methods: {
    loadOptions: {
      async getTeams(ctx): Promise<PropertyOption[]> {
        const credentials = pickCredentials(ctx);
        const data = await graphql<{ teams: { nodes: Array<{ id: string; key: string; name: string }> } }>({ http: ctx.http }, credentials, '{ teams(first: 100) { nodes { id key name } } }');
        return data.teams.nodes.map((t) => ({ name: `${t.name} (${t.key})`, value: t.id })).sort((a, b) => a.name.localeCompare(b.name));
      },
    },
  },
```

<sub>From `plugins/linear/src/nodes/linear.ts`.</sub>

Python (`plugins/py-insights/insights/keywords.py`):

```python
    def load_options(self, method: str, parameters: dict[str, Any]) -> list[dict[str, Any]]:
        if method == "languages":
            return [
                {
                    "name": LANGUAGE_NAMES[code],
                    "value": code,
                    "description": f"{len(STOPWORDS[code])} stopwords" if STOPWORDS[code] else "No stopword removal",
                }
                for code in LANGUAGE_NAMES
            ]
        return super().load_options(method, parameters)
```

<sub>From `plugins/py-insights/insights/keywords.py`.</sub>

Go (`plugins/go-crypto/hash.go`):

```go
// LoadOptions serves typeOptions.loadOptionsMethod = "algorithms".
func (HashNode) LoadOptions(method string, _ map[string]any) ([]landflow.PropertyOption, error) {
	switch method {
	case "algorithms":
		return append([]landflow.PropertyOption(nil), hashAlgorithms...), nil
	}
	return nil, fmt.Errorf("unknown loadOptions method %q (supported: algorithms)", method)
}
```

<sub>From `plugins/go-crypto/hash.go`.</sub>

- **Defaults.** The value comes from `itemParameters[i]`, then `parameters`, then the property's `default`. Give every
  property a default of the right type: `false`, `0` and `''` are kept (Go pointers `landflow.Ptr(1.0)` mark numbers
  that may be 0).
- **Validation.** The SDK checks descriptors at startup: identifier names, property types, option lists, port types, a
  poll trigger's `pollInterval`, and that a credential a node names is declared. TypeScript throws from `definePlugin`,
  Python raises `DescriptorError` listing every problem, Go panics from `NewPlugin` (use `BuildPlugin` for an error).

## Credentials

A **credential type** is a form the host stores encrypted. A node lists the types it uses in `credentials`, and the host
sends the decrypted values with each call, keyed by the type's local name. Workflow JSON holds only a reference.

```ts
export const helloApi = defineCredentialType<HelloApi>({
  name: 'helloApi',
  displayName: 'Hello API',
  documentationUrl: 'https://example.com/hello-api',
  properties: [
    { name: 'apiKey', displayName: 'API key', type: 'string', required: true, typeOptions: { password: true } },
    { name: 'salutation', displayName: 'Salutation', type: 'string', default: 'Hello' },
  ],
  // A real plugin makes one cheap authenticated call here with `ctx.http` (Slack `auth.test`, Telegram `getMe`).
  // The sample checks the key's shape so it needs no network.
  async test({ apiKey }) {
    return apiKey.startsWith('hello-') ? { ok: true, message: 'Key accepted' } : { ok: false, message: 'The key must start with "hello-"' };
  },
});
```

<sub>From `examples/sdk/typescript/hello-node/src/plugin.ts`.</sub>

- **Test connection.** A `test` function makes the type "testable". It makes one cheap authenticated call (Slack
  `auth.test`, Telegram `getMe`, `SELECT 1`) with the traced `ctx.http` and returns `{ ok, message }`. A throwing test is
  `ok: false` with the message. An undeclared type is HTTP 404. TypeScript: `test(data, ctx)`; Python: `test(data, ctx)`
  returning `(ok, message)`; Go: `Test: func(ctx, data) (bool, string)`.
- **Password fields.** `typeOptions: { password: true }` masks the field in the UI and never returns it from the API.
- **Base URL.** Give every integration an overridable base URL or host so it can point at a proxy or a test double.
- **Redaction.** While a call runs, the SDK scrubs the values of password fields and of fields named like a secret
  (`token`, `secret`, `password`, `authorization`, `api key`, `cookie`) from logs, node logs, error messages, span attributes
  and URLs, raw and URL-encoded. Values under four characters are not scrubbed. For a type your plugin does not declare,
  every string counts as a secret.
- **OAuth2.** A type that lists `extends: ['oAuth2Api']` gets the host's **Connect** button (authorization code with PKCE,
  or client credentials). Fix a provider's URLs with `hidden` properties that have defaults. The plugin receives a fresh
  `accessToken` on every call, never the refresh token, and when the API answers 401 the node should fail with a message
  that says so: the host renews the token and runs the node once more ([protocol §7](../../protocol.md#oauth2-credentials-extends)).

```ts
  extends: ['oAuth2Api'],
  properties: [
    hidden('grantType', 'Grant Type', 'authorizationCode'),
    hidden('authUrl', 'Authorization URL', 'https://app.attio.com/authorize'),
    hidden('accessTokenUrl', 'Access Token URL', 'https://app.attio.com/oauth/token'),
    hidden('authentication', 'Client Authentication', 'body'),
    hidden('scope', 'Scope', ''),
    baseUrlProperty,
  ],
  test: testCredentials,
```

<sub>From `plugins/attio/src/api.ts`.</sub>

- **Token or OAuth2 on one node.** List both types with `displayOptions.show.authentication`, add an `authentication`
  options property, and read whichever the parameter names (`plugins/attio/src/api.ts` `attioCredentials`).
- **GitHub App tokens.** `githubAppJwt(appId, privateKeyPem)` (TypeScript), `landflow_sdk.jwt.github_app_jwt` (Python) and
  `landflow.GitHubAppJWT` (Go) sign the app JWT; Go also has `NewGitHubAppTokens` for installation tokens.

## Binary data

Files live on `item.binary` under a property name (`data` for one file). The item carries a reference
`{ id, mimeType, fileName, fileSize }`; the bytes stay in the host's binary store, and a file up to 64 KiB may travel
inline as base64 ([protocol §11](../../protocol.md#11-binary-data)). Read with the helper for your language, and write
with `prepareBinaryData`: the SDK stores bytes through the request's `binaryAccess` URL and returns the reference to put
on the output item. A node that builds new items without copying `binary` drops the files.

| | Read | Write |
|---|---|---|
| TypeScript | `ctx.helpers.assertBinaryData(i, name)`, `getBinaryDataBuffer`, `getBinaryStream` | `await ctx.helpers.prepareBinaryData(bytes, fileName, mimeType)` |
| Python | `ctx.assert_binary_data(i, name)`, `get_binary_bytes`, `open_binary_stream` | `ctx.prepare_binary_data(data, file_name, mime_type)` |
| Go | `ctx.BinaryRef`, `ctx.BinaryBytes`, `ctx.BinaryReader` | `ctx.PrepareBinary(data, name, mime)`, `ctx.PrepareBinaryStream(reader, ...)` |

```ts
      const property = String(ctx.getNodeParameter('binaryPropertyName', i, 'data') || 'data').trim();
      const ref = await ctx.helpers.prepareBinaryData(Buffer.from(text, 'utf8'), fileName, mimeType);
      // The item's other files stay; the new one replaces a file of the same name.
      out.push({ json, binary: { ...item.binary, [property]: ref } });
```

<sub>From `plugins/text-toolkit/src/nodes/template.ts`.</sub>

Python (`plugins/py-insights/insights/files.py`):

```python
def read_bytes(ctx: Any, i: int) -> tuple[bytes, dict[str, Any], str]:
    """``(bytes, ref, property name)`` of input item ``i``'s binary file named by the ``binaryPropertyName`` parameter."""
    name = str(ctx.get_node_parameter("binaryPropertyName", i, "data") or "data").strip() or "data"
    ref = ctx.assert_binary_data(i, name)
    size = ref.get("fileSize")
    if isinstance(size, int) and size > MAX_FILE_BYTES:
        raise NodeOperationError(f"Binary file '{name}' is {size} bytes; the limit is {MAX_FILE_BYTES // (1024 * 1024)} MB", item_index=i)
    return ctx.get_binary_bytes(i, name), ref, name
```

<sub>From `plugins/py-insights/insights/files.py`.</sub>

Go (`plugins/databases/dbbinary.go`):

```go
		data, err := ctx.BinaryBytes(i, bc.property)
		if err != nil {
			return landflow.ItemError(i, "Column %q: %v", col, err).
				WithDescription("“Columns From Binary Files” maps columns to binary properties of the input item; check the previous node's Binary output.")
		}
		values[col] = data
```

<sub>From `plugins/databases/dbbinary.go`.</sub>

## Errors, retries and continue on fail

- **Fail with a reason.** Throw `NodeOperationError(message, { itemIndex, description })` (TypeScript, Python
  `NodeOperationError(message, description=, item_index=)`), or return `landflow.ItemError(i, "...")` (Go, with
  `.WithDescription(...)`). The host shows the message and the hint, and the response carries the item index. Any other
  exception becomes `{ message }`; a Go panic is recovered. A failed node is HTTP 200 with `error` set, never a 500.
- **Continue on fail.** When the node's setting is "continue on error" the host sends `continueOnFail: true`. The node
  then catches the failing item, emits `{ json: { error }, pairedItem: { item: i } }` and goes on. In Go,
  `ctx.ErrorItem(i, err)` builds that item with credential values masked. The sample sends it to the second output.

```ts
      try {
        const name = ctx.getNodeParameter<string>('name', i).trim();
        if (name.length > MAX_NAME_LENGTH) {
          throw new NodeOperationError(`The name is longer than ${MAX_NAME_LENGTH} characters`, { itemIndex: i });
        }
        if (name === '') {
          skipped.push({ json: { ...item.json, reason: 'empty name' } });
          continue;
        }
        const text = `${salutation}, ${name}!`;
        greeted.push({ json: { ...item.json, greeting: ctx.getNodeParameter<boolean>('shout', i) ? text.toUpperCase() : text } });
      } catch (error) {
        if (!ctx.continueOnFail()) throw error; // the node is not set to continue: the step fails
        skipped.push({ json: { ...item.json, error: (error as Error).message }, pairedItem: { item: i } });
      }
```

<sub>From `examples/sdk/typescript/hello-node/src/plugin.ts`.</sub>

- **Retries and timeouts are the host's.** A node's settings `retryOnFail`, `maxTries`, `waitBetweenTriesMs`,
  `retryBackoff` and `timeoutSeconds` (`packages/engine/src/types.ts:40`) re-run the call; a workflow can also retry the
  whole run ([features/engine.md](../../features/engine.md)). A plugin needs no retry loop for its own failures: it fails
  with a message, and when the API answered 401 the message says so, which also triggers the OAuth token refresh.
- **Idempotency.** The key (`ctx.getIdempotencyKey()` in TypeScript, `ctx.idempotency_key` in Python,
  `ctx.IdempotencyKey()` in Go) is `<executionId>:<nodeId>:<runIndex>`, the same across retries of one step: pass it to
  APIs that take an idempotency key. Mark a node `idempotent: true` when running it twice has the effect of once, which
  lets a broker deliver it at least once and gives its MCP tool `idempotentHint`.

## Pagination

No SDK has a pagination helper. A plugin pages by itself and, for a big result, either returns every item or lets the
user set a limit. The integration plugins keep their own small helpers (`paginate` in
`plugins/productivity/productivity`; the cursor loops in `plugins/linear/src/nodes/linear.ts` and `plugins/clickland/src/client.ts`):
copy the pattern, and cap pages and items so one run cannot loop forever.

## AI, tools and sub-nodes

- **As an agent tool.** `usableAsTool: true` lets an AI Agent attach the node on its `ai_tool` port. The host derives a
  JSON Schema for the arguments from the primitive properties; `toolInputSchema` overrides it and `toolDescription` is what
  the model reads. A node that hands work to another agent sets `delegates: true`, and the engine adds a required `reason`
  argument that it records in the run's trace.
- **Report a model call.** A plugin that calls a model itself reports each call with `ctx.model({ ... })` (TypeScript,
  Python `ctx.model(...)`, Go `ctx.Model(landflow.ModelCall{...})`). The host counts the tokens in AI usage, prices
  them and shows a `model` step under the node in the Run Trace. With `meterAiUsage: true` on the descriptor the host also
  refuses the call once an AI usage cap is reached (`plugins/ai-sdk` does this).
- **Sub-nodes.** The protocol has connection types `ai_languageModel`, `ai_tool`, `ai_memory`, `ai_embedding`,
  `ai_retriever` and `ai_reranker`, `kind: 'subnode'` and `supplies`. Supplying and consuming a sub-node (`supplyData`,
  `ctx.getInputConnectionData`) happens in the host's process, so a plugin on the other end of HTTP, gRPC or a broker
  cannot be a sub-node nor read one. A composite slot may still **accept** a sub-node node by `supplies`.

## MCP faces

Every action node's operations are MCP tools, with no code: the SDK serves Streamable HTTP at `/mcp` on the HTTP port
(stateless; 2026-07-28 and 2025-era clients) and stdio with `--mcp-stdio`. `mcp: false` on a node, a `resource` option or
an `operation` option opts out; `outputSchema`, `toolAnnotations` and `idempotent` shape the tool. Off loopback the face
needs `LANDFLOW_MCP_TOKEN`. Credentials for a stand-alone plugin come from `LANDFLOW_MCP_CREDENTIALS`. Python needs
`pip install 'landflow-sdk[mcp]'`. Try it on a sample:

```bash
curl -s localhost:7192/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The host adds the plugin to its gateway automatically ([protocol §15](../../protocol.md#15-mcp),
[mcp-gateway.md](../../mcp-gateway.md)).

## Branding and icons

`icon` takes `lucide:<name>`, `emoji:<char>`, an `https:` URL, a `data:` URL, or `file:icons/x.svg`, which the SDK reads and
inlines (SVG or PNG, at most 64 KB; draw glyphs as paths, not text). A node that stands for an app wears the app's real
mark, not a drawn stand-in ([plugins.md](../../plugins.md#branding-and-real-marks): sources, licences and
`scripts/brand-icon.mjs`). `color` is a hex colour for the plugin's segment and
its nodes. Where relative `file:` paths resolve: TypeScript `definePlugin({ iconDir })`, Python the module's folder or
`Plugin(icon_dir=)`, Go `PluginInfo.IconFS` (an `embed.FS`). See [protocol §6](../../protocol.md#6-icons-and-brand-colour).

## Versioning

- **The plugin** has a semver `version` in its info. The host re-pulls the manifest when it changes, or when the process
  restarts with a new `instanceId`.
- **A node** has `version` (a number or a list, `[1, 2]`) and an optional `defaultVersion`. A workflow node pins one in
  `typeVersion`, so you can change a node's parameters in version 2 without breaking saved workflows: keep serving
  version 1 and branch on the node's `typeVersion` (`ctx.getNode()` in TypeScript, `ctx.node` in Python, `ctx.Node()` in Go).
- **Never rename** a node or a parameter in place: saved workflows refer to them by name.

## Composites and capability tags

A node may carry `capabilities: ['ioc.enrich']`, stable dotted tags that a **composite type** slot can ask for. A composite
is a canvas frame with named slots, ports and rules, shipped by the plugin: `defineComposite` (TypeScript),
`Plugin(composites=[...])` (Python), `PluginInfo.Composites` (Go). The SDK validates them at startup. See
[composites.md](../../composites.md); the example is `plugins/triage/src/composites/ai-triage.ts`:

```ts
export const AiTriage = defineComposite({
  name: 'aiTriage',
  displayName: 'AI triage',
  description:
    'A model gives a verdict on the alert and Triage Decision opens a war room, attaches to one or asks on-call. Fails open: if enrichment or the model fails, the alert still reaches the decision.',
  version: 1,
  icon: 'lucide:brain-circuit',
  color: '#0d9488',
  inputs: [{ name: 'alert', displayName: 'Alert' }],
  outputs: [
    { name: 'open', displayName: 'Open', slot: 'decision', index: 0 },
    { name: 'attach', displayName: 'Attach', slot: 'decision', index: 1 },
    { name: 'ask', displayName: 'Ask', slot: 'decision', index: 2 },
  ],
  slots: [
    { name: 'extract', displayName: 'Extract IOCs', description: 'Pulls indicators out of the alert for enrichment', accepts: { capability: 'ioc.extract' }, min: 0, max: 1 },
    { name: 'enrich', displayName: 'Enrichment', description: 'Threat intel on the indicators', accepts: { capability: ['ioc.enrich', 'ioc.lookup'] }, min: 0 },
    { name: 'reasoner', displayName: 'Reasoner', description: 'An AI node that reads the alert and returns a verdict', accepts: { kind: 'action', category: 'AI', input: 'ai_languageModel' }, max: 1 },
    { name: 'model', displayName: 'AI model', description: 'The chat model the reasoner uses', accepts: { supplies: 'ai_languageModel' }, max: 1 },
    { name: 'decision', displayName: 'Decision', description: 'Turns the verdict into Open, Attach or Ask', accepts: { type: 'triage.triageDecision' }, max: 1, locked: true },
  ],
  rules: [
```

<sub>From `plugins/triage/src/composites/ai-triage.ts`.</sub>

## Records for the Run Trace

`ctx.artifact({ name, kind, url, mimeType, text })` reports something the node made (a pull request, a file, a ticket) and
`ctx.check({ name, status, message, subject, evidence })` something it checked (`pass`, `fail`, `warn`, `skip`). They go back
in `ExecuteResponse.records` with the time, credential values masked, and show with the node's step in the trace
([run-trace.md](../../run-trace.md)). **Cancellation:** the host sends a deadline and cancels when the caller goes. TypeScript
exposes `ctx.signal` and `ctx.deadline` (pass the signal to anything that waits; `ctx.http` already does), Python
`ctx.cancel` (`ctx.cancel.check()`, `ctx.deadline`), Go makes `ctx` a `context.Context`.

## Observability

Every call is traced and counted with no code: a server span `plugin.execute <type>` continuing the host's trace, the
metrics `landflow.plugin.executions`, `.execute.duration`, `.items`, JSON logs with trace ids, and `GET /metrics`
(Prometheus). Your code adds child spans (`ctx.span`), custom counters, histograms and gauges (`ctx.metrics`), and a
traced HTTP client (`ctx.http`; Go `landflow.HTTPClient(ctx)`) that injects `traceparent`. OTLP export turns on with
`OTEL_EXPORTER_OTLP_ENDPOINT`. Names and variables: [observability.md](../../observability.md).

## Activity items

A trigger or a "list changed since" operation that feeds the second brain returns normalised activity items
(`activityItem(...)` in TypeScript, `activity_item(...)` in Python, the matching Go helper in `sdks/go/activity.go`), so every
integration yields the same shape ([protocol §16](../../protocol.md#16-activity-items)).

## What a plugin cannot do

These are in-process features of the host's own nodes. A plugin on the other end of a wire has no access to them:
`putExecutionToWait` (suspend a run for a webhook, a form or a timer), `getNodeState`, `getNodeOutputs` (`$('Node')`),
`sendChunk` (streaming an answer), `sendProgress`, `getInputConnectionData` and `supplyData` (sub-nodes). A plugin that
needs a human step returns its result and lets the workflow use the host's Wait, Form or Approval nodes after it. See
[limitations.md](../../limitations.md) for what else is missing.

## Marketplace format and bundled flows

A plugin directory becomes installable from a Claude Code marketplace with two files. `landflow.plugin.json` says how
the host runs it; the marketplace entry says what it is.

```json
{
  "id": "triage",
  "runtime": "node",
  "start": ["tsx", "src/main.ts"]
}
```

<sub>From `plugins/triage/landflow.plugin.json`.</sub>

| Field | |
|---|---|
| `id` | the id the plugin announces |
| `runtime` | `node` (default), `python`, `go` or `binary` |
| `install` | optional argv run once after download (`go build -o ...`, `pip install ...`) |
| `start` | argv that serves the plugin; the host sets `LANDFLOW_HTTP_PORT`, `LANDFLOW_GRPC_PORT` and `LANDFLOW_REGISTRY_URL` |
| `transports` | `http` (default) and/or `grpc` |
| `env` | extra non-secret `UPPER_CASE` variables |

```json
    {
      "name": "triage",
      "source": "./plugins/triage",
      "description": "Alert triage that decides whether an alert deserves a war room: normalize Alertmanager, Grafana, Datadog, CloudWatch, Sentry and Wazuh alerts, extract IOCs, parse reported emails, rules people approve, and a fail-open triage decision. Flows: alert and phishing triage into Landfall, and a daily digest.",
      "version": "0.1.0",
      "author": { "name": "Landflow" },
      "category": "security",
      "keywords": ["triage", "alerts", "soc", "incident", "ioc", "phishing", "landfall"],
      "flows": ["./flows/alert-triage-to-landfall.json", "./flows/phishing-report-triage.json", "./flows/triage-digest.json"]
    },
```

<sub>From `.claude-plugin/marketplace.json`.</sub>

An entry has `name`, `source` (`./plugins/<name>`), `description`, `version`, `author`, `category`, `keywords`, and `flows`:
paths to flow files that installing adds to Templates. A flow is the JSON a template's **Export** produces
(`{ "kind": "landflow/template", "version": 1, "template": {...} }`); `plugins/triage/flows/triage-digest.json` is a complete
one. Flows name the plugin's node types, so after a node change `apps/web/test/plugin-flows.test.ts` checks every flow
against the recorded manifests and this marketplace file ([development.md](../../development.md)). The rules for what the host
downloads, runs and supervises are in [marketplace.md](../../marketplace.md#landflow-node-plugins); installing runs code on
the machine, so the host asks first.
