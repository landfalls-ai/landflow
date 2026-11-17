# Build a plugin in TypeScript

You will build `hello-node`: an action with a credential and two outputs, and a poll trigger. Every code block on this
page is copied from [`examples/sdk/typescript/hello-node`](../../../examples/sdk/typescript/hello-node), whose tests
pass. Read [the overview](README.md) and [capabilities.md](capabilities.md) first for what the parts mean. The SDK's own
reference is [`packages/sdk/README.md`](../../../packages/sdk/README.md); the full example plugin is
[`plugins/text-toolkit`](../../../plugins/text-toolkit).

You need Node 22 or later and pnpm 10 (`corepack enable`), and `pnpm install` run once at the repository root.

## Where the package lives

`@landflow/sdk` is a private workspace package: `packages/sdk`, source in `packages/sdk/src`, its `exports` point at the
`.ts` files and plugins run from source with `tsx`. Plugins that ship with Landflow live in `plugins/<name>` and are
workspace members (`pnpm-workspace.yaml` has `plugins/*`), so `pnpm install` links the SDK for them.

The sample is **not** in the workspace: adding `examples/*` there would change the lockfile. So the sample maps the package
names to the sources itself (`tsconfig.json` `paths` and `vitest.config.ts` `alias`). When you copy it to
`plugins/<name>` you delete both and `pnpm install` does the rest.

| Imports | What |
|---|---|
| `@landflow/sdk` | `defineNode`, `definePlugin`, `defineCredentialType`, `defineComposite`, `pollIntervalProperty`, `NodeOperationError`, `runNode`, `runLoadOptions`, `runTestCredentials`, the signature helpers |
| `@landflow/sdk/serve` | `serve(plugin, options)` |
| `@landflow/sdk/http`, `/grpc`, `/mcp`, `/messaging`, `/dispatcher`, `/telemetry` | the faces and the core, for custom setups |
| `@landflow/protocol` | the wire types (`ExecuteRequest`, `NodeItem`, `PropertyDescriptor`, ...) and `parseManifest` |

## Layout

```
plugins/my-plugin/
  package.json        name @landflow/plugin-my-plugin, "type": "module", scripts start/test
  tsconfig.json       extends ../../tsconfig.base.json
  landflow.plugin.json  only if it ships through the marketplace
  icons/              SVG or PNG, 64 KB at most, for file: icons
  src/plugin.ts       the credential types, the nodes, definePlugin(...)
  src/main.ts         serve(plugin, ...), guarded so tests can import the plugin
  test/*.test.ts      vitest
```

`plugins/text-toolkit` splits nodes into `src/nodes/*.ts`; the sample keeps them in one file because it is small.

## The credential

`defineCredentialType<T>()` declares the form and, with `test`, the "Test connection" check. The type parameter types
`ctx.getCredentials<T>('helloApi')`.

```ts
/** What the credential form holds. `apiKey` is a password field: masked in the UI and redacted from logs. */
export interface HelloApi {
  apiKey: string;
  salutation: string;
  [key: string]: string;
}

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

## The action

One action, two outputs, a credential, a `continueOnFail` path and a logged line. The descriptor is plain data; `execute`
returns one array per output.

```ts
export const MAX_NAME_LENGTH = 50;

/** One action, two outputs: output 0 gets the greetings, output 1 the items that had nobody to greet. */
export const greet = defineNode({
  description: {
    name: 'greet',
    displayName: 'Hello: Greet',
    description: 'Greet the name in each item',
    version: 1,
    kind: 'action',
    categories: ['Examples'],
    icon: 'lucide:hand',
    subtitle: '{{name}}',
    idempotent: true, // the same input gives the same output, so a broker may deliver a call twice
    usableAsTool: true, // an agent may call it, and it becomes an MCP tool
    inputs: [{ type: 'main' }],
    outputs: [
      { type: 'main', displayName: 'Greeted' },
      { type: 'main', displayName: 'Skipped' },
    ],
    credentials: [{ name: 'helloApi', required: true }],
    properties: [
      { name: 'name', displayName: 'Name', type: 'string', default: '', description: 'Who to greet. An empty name goes to Skipped.' },
      { name: 'shout', displayName: 'Shout', type: 'boolean', default: false },
    ],
  },
  async execute(ctx) {
    const { salutation } = ctx.getCredentials<HelloApi>('helloApi');
    const greeted = [];
    const skipped = [];
    for (const [i, item] of ctx.getInputData().entries()) {
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
    }
    ctx.logger.info('greeted', { greeted: greeted.length, skipped: skipped.length });
    return [greeted, skipped];
  },
});
```

<sub>From `examples/sdk/typescript/hello-node/src/plugin.ts`.</sub>

Points to copy:

- `getNodeParameter<T>(name, i)` reads the parameter for item `i`; it already has expressions resolved and the property's
  default applied.
- `getCredentials<T>('helloApi')` throws a `NodeOperationError` that names the type when the host sent none; pass
  `{ optional: true }` for a credential declared `required: false`.
- `throw new NodeOperationError(message, { itemIndex, description })` fails the step with a reason the user can read.
- `ctx.logger.info(message, attrs)` is returned to the host as a node log and written to the process log with trace ids.

## The trigger

```ts
/** The stand-in for the service a real trigger polls. Tests push to it. */
export const requests: Array<{ id: number; name: string }> = [];

/** A poll trigger: the host calls it every `pollInterval` seconds with the state the last call returned. */
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

`requests` stands in for the service a real trigger would call with `ctx.http(url)`, which is traced and redacts the
credential from `url.full`. `pollIntervalProperty(30)` adds the required `pollInterval` property (default 30 s, minimum
10); `definePlugin` throws without it.

## The plugin and `main.ts`

```ts
export const plugin = definePlugin({
  info: { id: 'hello-node', name: 'Hello Node', version: '0.1.0', description: 'A small example plugin', icon: 'lucide:hand', color: '#16a34a', author: 'Landflow examples' },
  nodes: [greet, newRequest],
  credentialTypes: [helloApi],
});
```

<sub>From `examples/sdk/typescript/hello-node/src/plugin.ts`.</sub>

`definePlugin` validates the whole plugin at startup and throws with a message that names the node: a credential type a
node uses but the plugin did not declare, a bad colour, a duplicate node name, a poll trigger without `pollInterval`.

```ts
import { serve } from '@landflow/sdk/serve';
import { plugin } from './plugin';

if (import.meta.url === `file://${process.argv[1]}`) {
  await serve(plugin, {
    http: 7191,
    grpc: 7291,
    // Loopback in dev (the MCP face then needs no token); in a container LANDFLOW_ADVERTISE_HOST is set and every face listens on 0.0.0.0.
    host: process.env.LANDFLOW_HOST ?? (process.env.LANDFLOW_ADVERTISE_HOST ? '0.0.0.0' : '127.0.0.1'),
    maxConcurrency: 8,
    mcp: { token: process.env.LANDFLOW_MCP_TOKEN },
  });
}
```

<sub>From `examples/sdk/typescript/hello-node/src/main.ts`.</sub>

The `import.meta.url` guard lets the tests `import { plugin }` without starting servers. `serve` builds the telemetry, one
dispatcher, the HTTP face (with MCP at `/mcp`) and the gRPC face, announces each endpoint with its heartbeat, and
withdraws on `SIGINT` and `SIGTERM`. Ports can be overridden with `LANDFLOW_HTTP_PORT` and `LANDFLOW_GRPC_PORT`.

## Run it

From the repository root, after `pnpm install`:

```bash
# serve with no host, then look at it from a second shell (tsx comes from plugins/text-toolkit)
LANDFLOW_REGISTRY_URL=off pnpm --filter @landflow/plugin-text-toolkit exec tsx \
  --tsconfig ../../examples/sdk/typescript/hello-node/tsconfig.json ../../examples/sdk/typescript/hello-node/src/main.ts

curl -s localhost:7191/.well-known/landflow          # protocol, plugin id, endpoints
curl -s localhost:7191/landflow/v1/manifest          # nodes, credential types
curl -s localhost:7191/landflow/v1/health
curl -s -XPOST localhost:7191/landflow/v1/test-credentials -H 'content-type: application/json' \
  -d '{"credentialType":"helloApi","data":{"apiKey":"hello-1"}}'
curl -s -XPOST localhost:7191/landflow/v1/execute -H 'content-type: application/json' -d '{
  "protocol":"landflow.plugin/v1","executionId":"e","mode":"manual",
  "node":{"id":"n","name":"n","type":"hello-node.greet","typeVersion":1},
  "parameters":{"name":"Ada"},"itemParameters":[{"name":"Ada"}],"inputs":[[{"json":{}}]],
  "credentials":{"helloApi":{"apiKey":"hello-1","salutation":"Hello"}}}'
```

The last call answers `{"outputs":[[{"json":{"greeting":"Hello, Ada!"},...}],[]],...}`: output 0 has the greeting and
output 1 is empty. Stop the process with Ctrl-C. In your own plugin under `plugins/<name>`, `pnpm --filter
@landflow/plugin-<name> start` runs `tsx src/main.ts`, and the root script `pnpm plugin:<name>` is a shortcut you add to
the root `package.json` like the others.

## Register it with a dev host

Start the host (`pnpm dev`, port 3000) and the plugin **without** `LANDFLOW_REGISTRY_URL=off`. The plugin announces to
`http://127.0.0.1:3000`, the host pulls the manifest and validates it, and the nodes show in the editor under **Plugins**
and the node creator. If the plugin stops, it goes offline after about 30 s. The scan also finds a plugin on ports
7100-7299 with no announce at all. After a code change, restart the plugin: its new `instanceId` makes the host read the
manifest again, so no version bump and no Refresh are needed.

To check without touching `apps/web/.data`, run a scratch host with its own data directory
([development.md, "Checking a change live"](../../development.md#checking-a-change-live)) and point the plugin at it with
`LANDFLOW_REGISTRY_URL=http://localhost:3100`. That is how the three samples were checked: all three announced as
`hello-node`, the registry listed the nodes `greet` and `newRequest`, and every HTTP and gRPC endpoint showed `online`.
Add your credential in **Credentials**, with the type `hello-node.helloApi` and a key that starts with `hello-`, and press
**Test connection**.

## Test it

The SDK's helpers run a node in-process, with no server and no network:

| Helper | Runs |
|---|---|
| `runNode(node, request, extras?)` | `execute`, returns the `ExecuteResponse` (`outputs`, `error`, `pollState`, `logs`) |
| `runLoadOptions(node, method, parameters, credentials?)` | a `loadOptions` method |
| `runTestCredentials(plugin, { credentialType, data })` | a credential `test` |
| `runWebhook`, `runWebhookMethod` | an app webhook trigger |
| `createFetchHandler(plugin)` | the real HTTP face, for a test that goes through `fetch` |
| `createTelemetry({ spanExporters, logWriter })` | in-memory spans and logs, to assert on them |

Build the request the host would send, call `runNode`, read the response:

```ts
const credentials = { helloApi: { apiKey: 'hello-123', salutation: 'Hello' } };
const extras = { credentialTypes: plugin.credentialTypes, pluginId: 'hello-node' };

/** The request the host sends. A test builds the same shape and calls runNode, with no server and no network. */
function request(type: string, parameters: JsonObject, items: JsonObject[], more: Partial<ExecuteRequest> = {}): ExecuteRequest {
  return {
    protocol: 'landflow.plugin/v1',
    executionId: 'ex_test',
    mode: 'manual',
    node: { id: 'n1', name: 'Node', type: `hello-node.${type}`, typeVersion: 1 },
    parameters,
    itemParameters: items.map(() => parameters),
    inputs: [items.map((json) => ({ json }))],
    credentials,
    ...more,
  };
}
```

<sub>From `examples/sdk/typescript/hello-node/test/hello.test.ts`.</sub>

```ts
describe('newRequest (poll trigger)', () => {
  it('records a baseline first, then returns only what is new, and keeps the state', async () => {
    requests.push({ id: 1, name: 'old' });
    const first = await runNode(newRequest, request('newRequest', {}, [], { mode: 'poll', inputs: [] }), extras);
    expect(first.outputs[0] ?? []).toEqual([]);
    expect(first.pollState).toEqual({ lastId: 1 });

    requests.push({ id: 2, name: 'new' });
    const second = await runNode(newRequest, request('newRequest', {}, [], { mode: 'poll', inputs: [], pollState: first.pollState }), extras);
    expect(second.outputs[0].map((i) => i.json)).toEqual([{ id: 2, name: 'new' }]);
    expect(second.pollState).toEqual({ lastId: 2 });
  });

  it('shows recent items in manual mode without state', async () => {
    const response = await runNode(newRequest, request('newRequest', {}, [], { mode: 'manual', inputs: [] }), extras);
    expect(response.outputs[0].length).toBeGreaterThan(0);
    expect(response.pollState).toBeUndefined();
  });
});
```

<sub>From `examples/sdk/typescript/hello-node/test/hello.test.ts`.</sub>

Run them from the repository root:

```bash
pnpm --filter @landflow/sdk exec vitest run --root ../../examples/sdk/typescript/hello-node
node_modules/.bin/tsc -p examples/sdk/typescript/hello-node/tsconfig.json
```

Inside a workspace plugin the commands are `pnpm --filter @landflow/plugin-<name> test` and `typecheck`; `pnpm test` runs
every package. Pass `credentialTypes` and `pluginId` in `extras` so the SDK can redact like the real server. Assert on the
response, not on the log.

## Package it

1. **Move it into the workspace.** Copy the folder to `plugins/<name>`, set the package name to `@landflow/plugin-<name>`,
   delete the example's `paths`, `typeRoots` and `vitest.config.ts`, and run `pnpm install`. That changes
   `pnpm-lock.yaml`: commit it.
2. **Image.** `deploy/docker/node-plugin.Dockerfile` builds any TypeScript plugin. It installs the plugin and its workspace
   dependencies with `pnpm install --frozen-lockfile --prod --filter "@landflow/plugin-${PLUGIN}..."`, copies
   `packages/protocol`, `packages/sdk`, `packages/transports` and `plugins/${PLUGIN}`, and runs `tsx src/main.ts`
   as the `node` user on Alpine, with a health check on `/landflow/v1/health`. So the folder name must equal `PLUGIN`, the
   package must be `@landflow/plugin-<PLUGIN>` and the entry must be `src/main.ts`.

   ```bash
   docker build -f deploy/docker/node-plugin.Dockerfile \
     --build-arg PLUGIN=<name> --build-arg HTTP_PORT=<7xxx> --build-arg GRPC_PORT=<7yyy> \
     -t landflow/plugin-<name>:dev .
   ```

   Build locally only and never push (the rules are in [CLAUDE.md](../../../CLAUDE.md)): compose builds with
   `COMPOSE_BAKE=false`, and an image for the OrbStack cluster with
   `docker --context orbstack buildx build --builder orbstack --load`.
3. **Compose.** Copy the `text-toolkit` block in `deploy/compose.yml`, change the names, the ports and
   `LANDFLOW_ADVERTISE_HOST`, and add the service name to `LANDFLOW_SCAN_HOSTS` on the host.
4. **Kubernetes.** Copy `deploy/k8s/base/plugins/text-toolkit.yaml` (a Deployment and a Service labelled
   `landflow.dev/plugin=true`, with the gRPC port in an annotation), list it in `deploy/k8s/base/kustomization.yaml`, and add
   the image tag to the overlay. The host discovers it by the label. The pod listens on `0.0.0.0`, so keep
   `LANDFLOW_MCP=off` or give it a token.
5. Docs: a row in `docs/history.md`, the plugin's own README, and `docs/limitations.md` if it is not finished
   ([CLAUDE.md](../../../CLAUDE.md)).

## Add it to the marketplace

For people who install it from a marketplace instead of running the process themselves, add
`plugins/<name>/landflow.plugin.json` (`{ "id": "<name>", "runtime": "node", "start": ["tsx", "src/main.ts"] }`), an entry in
`.claude-plugin/marketplace.json` (see [the entry format](capabilities.md#marketplace-format-and-bundled-flows)), and any
flows under `plugins/<name>/flows/`. Installing downloads the folder, links `@landflow/sdk` and `@landflow/protocol` to
the host's own copies, runs `npm install` for other dependencies and supervises the process
([marketplace.md](../../marketplace.md#landflow-node-plugins)).

## Outside this repository

`@landflow/sdk` and `@landflow/protocol` are not on npm. The supported route is to build inside a checkout of
`https://github.com/landfalls-ai/landflow` as `plugins/<name>`. To keep the plugin in another repository you must vendor
the packages yourself: clone the repository next to yours and list `../landflow/packages/*` in your own
`pnpm-workspace.yaml`, so `workspace:*` resolves. This was not tried here. A plugin installed through the marketplace
needs none of this: the host links the SDK for it.

## Traps

- **Do not import from `@landflow/sdk` in the browser or the host.** It is plugin code; it pulls in gRPC and OpenTelemetry.
- **Do not keep per-run state on module variables.** Calls run concurrently (`maxConcurrency`). The sample's `requests` array
  is a stand-in and only for tests.
- **Return items, not rows.** Each item is `{ json }`; a plain object array is accepted but loses `pairedItem` and `binary`.
- **Copy before you change.** `{ ...item.json, x }`, never `item.json.x = ...`.
- **A poll trigger must set a baseline** on the first poll and return nothing, or activating the workflow replays history.
- **Do not log secrets**: redaction catches the credential values, not a token you derive from them.
- **A new node in a bundled plugin** needs its manifest re-recorded for the tests (`packages/protocol/scripts/record-manifests.mjs`,
  [development.md](../../development.md)).
