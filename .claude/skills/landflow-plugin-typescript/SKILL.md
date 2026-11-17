---
name: landflow-plugin-typescript
description: Build a Landflow node plugin in TypeScript with @landflow/sdk. Use when asked to "write a Landflow node", "add an integration/plugin for X", "a node that ...", "add a trigger/credential/webhook to a plugin", or to scaffold, run, test, register, containerize or add a TypeScript plugin to the Landflow marketplace.
---

# Build a Landflow plugin in TypeScript

You turn a request ("a node that ...") into a working plugin: descriptor, `execute`, credential, optional trigger, tests,
a local run that a host can discover, a Dockerfile route and a marketplace entry. Work in small steps and run each check.

## 0. Where am I?

Run `ls docs/platform/sdk examples/sdk/typescript/hello-node packages/sdk/src 2>&1 | head`.

- **Those folders exist (inside the Landflow repository).** Read the local files named below. Build in `plugins/<name>/`.
- **They do not (your own repository).** Use GitHub. Fetch what you need with `WebFetch` or `gh api`:
  `https://raw.githubusercontent.com/landfalls-ai/landflow/main/<path>` for raw files, or browse
  `https://github.com/landfalls-ai/landflow/blob/main/<path>`. `@landflow/sdk` is **not on npm**: see step 9.

Read first (local path, same path on GitHub):

1. `docs/platform/sdk/typescript.md`: the walk-through of the whole job, with code copied from the sample.
2. `docs/platform/sdk/capabilities.md`: pick the features the request needs (outputs, trigger kind, binary data, OAuth, MCP).
3. `examples/sdk/typescript/hello-node/src/plugin.ts`, `src/main.ts` and `test/hello.test.ts`: the template to copy.
4. `packages/sdk/README.md`: the context API; `docs/protocol.md` only when a field is unclear.
5. The closest shipped plugin to the request: `plugins/text-toolkit` (pure transforms, binary files), `plugins/linear`
   (an API integration with OAuth2, load-options, a webhook trigger), `plugins/github`, `plugins/messaging`.

## 1. Decide the shape (write it down before coding)

Answer these from the request, then tell the user in two lines:

- Plugin id (lowercase, dashes, e.g. `acme-crm`) and folder `plugins/<id>`; node names (lowerCamelCase, local).
- Per node: `action` or `trigger` (`poll` or `appWebhook`; **no** other trigger sources for a plugin), inputs, how many
  outputs, the parameters (type, default, `displayOptions`), `idempotent` (true for a read), `usableAsTool`.
- Credential type: fields, which are `password`, an overridable `baseUrl`, a cheap `test` call. OAuth2: `extends: ['oAuth2Api']`.
- Anything the plugin **cannot** do from a separate process: wait/resume, sub-nodes (model, memory), streaming. If the request
  needs it, say so and propose using the host's own nodes around the plugin (limitations: `docs/limitations.md`).

## 2. Scaffold

Inside the repo:

```bash
mkdir -p plugins/<id>/src plugins/<id>/test && cp examples/sdk/typescript/hello-node/{package.json,tsconfig.json} plugins/<id>/
cp examples/sdk/typescript/hello-node/src/*.ts plugins/<id>/src/ && cp examples/sdk/typescript/hello-node/test/*.ts plugins/<id>/test/
```

Then in `plugins/<id>`: set `package.json` `name` to `@landflow/plugin-<id>`; in `tsconfig.json` keep only
`"extends": "../../tsconfig.base.json"`, `"compilerOptions": { "types": ["node"] }` and `"include": ["src", "test"]` (delete
`typeRoots`, `baseUrl`, `paths`); do **not** copy `vitest.config.ts` (it exists only because the sample is outside the
workspace); rename `hello-node` everywhere; pick two free ports (`grep -rnE "http: [0-9]+" plugins/*/src/main.ts`; 7101-7120 and the
samples' 7191-7193 are taken, so use the next free HTTP port and the gRPC port 100 above it) and run `pnpm install` (this changes `pnpm-lock.yaml`: keep it).
Add `"plugin:<id>": "pnpm --filter @landflow/plugin-<id> start"` to the root `package.json` scripts if the repo does that for
siblings.

## 3. Write the node

- Descriptor fields: `name`, `displayName`, `description`, `version: 1`, `kind`, `categories`, `icon: 'lucide:<name>'`,
  `inputs`, `outputs` (one entry per output, with `displayName`), `credentials`, `properties`, `idempotent`.
- `execute(ctx)`: loop `ctx.getInputData().entries()`, read `ctx.getNodeParameter<T>(name, i)`, call APIs with `ctx.http`
  (traced, redacts credentials), return `[out0, out1, ...]`. Copy items (`{ ...item.json, x }`); keep `pairedItem` when you add items.
- Errors: `throw new NodeOperationError(message, { itemIndex: i, description: 'what to do' })`. Support
  `ctx.continueOnFail()` by pushing `{ json: { error }, pairedItem: { item: i } }` and going on.
- Parameters with a dynamic list: `typeOptions: { loadOptionsMethod: 'getX' }` and `methods.loadOptions.getX(ctx)`.
- Binary files: `ctx.helpers.assertBinaryData`, `getBinaryDataBuffer`, `prepareBinaryData` (capabilities.md, "Binary data").
- No per-run state in module variables; never log secrets.

## 4. Credential

`defineCredentialType<T>({ name, displayName, documentationUrl, properties, test })`. Put the secret in a field with
`typeOptions: { password: true }`, add `baseUrl`, make `test` one cheap authenticated call and return `{ ok, message }`. List it in
`definePlugin({ credentialTypes })` and in each node's `credentials`. Never put a real token in code, tests or docs: tests use
fake values, and a real key is entered in the UI.

## 5. Trigger (only if asked)

Poll: `kind: 'trigger'`, `triggerSource: 'poll'`, `properties: [pollIntervalProperty(60)]`, `inputs: []`; on the first poll
(`ctx.isFirstPoll()`) set a baseline with `ctx.setPollState(...)` and return `[]`; later return only new items and set the
state; in `ctx.mode === 'manual'` return the latest few and no state. App webhook: `triggerSource: 'appWebhook'`,
`webhookMethods: { checkExists, create, delete }` and `webhook(ctx)`; verify the signature (`verifyGitHubSignature`,
`verifyHmacSha256`, ...), return `{ items, idempotencyKey }`, store the hook id and secret in `ctx.setStaticData`. Template:
`plugins/attio/src/nodes/attio-trigger.ts`.

## 6. Test (write them with the node, not after)

Copy the shape of `test/hello.test.ts`: `request(...)` builds the `ExecuteRequest`, `runNode(node, request, { credentialTypes: plugin.credentialTypes, pluginId })`
returns the response. Cover: each output, an error with the item index, continue-on-fail, a missing credential, the credential `test`
(`runTestCredentials`), the poll baseline and the next poll, and the manifest (outputs, `pollInterval`). Stub network calls
with `extras.fetch`, or a local `http.createServer`, never the real service.

```bash
pnpm --filter @landflow/plugin-<id> test && pnpm --filter @landflow/plugin-<id> typecheck
```

## 7. Run, discover, register

```bash
LANDFLOW_REGISTRY_URL=off pnpm --filter @landflow/plugin-<id> start      # in the background
curl -s localhost:<http>/.well-known/landflow; curl -s localhost:<http>/landflow/v1/manifest
curl -s -XPOST localhost:<http>/landflow/v1/execute -H 'content-type: application/json' -d '<an ExecuteRequest>'
```

Check the manifest lists your nodes and credential types and an execute answers. Then register with a host: start it
(`pnpm dev`, or a scratch host with its own `LANDFLOW_DATA_DIR` as in `docs/development.md` "Checking a change live") and start
the plugin without `LANDFLOW_REGISTRY_URL=off`; the nodes appear under Plugins. Stop only the processes you started, by pid.
Never touch `apps/web/.data` or other people's containers.

## 8. Package (only when asked)

- Image: `deploy/docker/node-plugin.Dockerfile --build-arg PLUGIN=<id> HTTP_PORT=... GRPC_PORT=...`. The folder must equal
  `PLUGIN`, the package `@landflow/plugin-<id>` and the entry `src/main.ts`. Local only: build with `COMPOSE_BAKE=false`; for
  the OrbStack cluster `docker --context orbstack buildx build --builder orbstack --load`; never push an image.
- Compose: copy the `text-toolkit` block in `deploy/compose.yml`; add the service to `LANDFLOW_SCAN_HOSTS`.
  Kubernetes: copy `deploy/k8s/base/plugins/text-toolkit.yaml` and list it in `deploy/k8s/base/kustomization.yaml`.
- Marketplace: `plugins/<id>/landflow.plugin.json` (`{ "id": "<id>", "runtime": "node", "start": ["tsx", "src/main.ts"] }`), an
  entry in `.claude-plugin/marketplace.json`, flows in `plugins/<id>/flows/*.json`. Run `cd apps/web && npx vitest run test/plugin-flows.test.ts`.
- A node in a **bundled** plugin also needs its recorded manifest refreshed (`docs/development.md`, "Recorded plugin manifests").

## 9. Outside the Landflow repository

`@landflow/sdk` and `@landflow/protocol` are not published. Say so plainly, then offer: (a) build inside a clone of
`https://github.com/landfalls-ai/landflow` as `plugins/<id>` (supported); (b) keep your repo and clone Landflow beside it, adding
`../landflow/packages/*` to your `pnpm-workspace.yaml` so `workspace:*` resolves (not tried by the authors of this skill);
(c) no SDK: implement `landflow.plugin/v1` yourself from `docs/protocol.md` (three endpoints are enough to start). Copy the sample's
`src/` and `test/`; the vitest alias config in the sample is only for the Landflow repository.

## 10. Checks before you say done

- [ ] `pnpm --filter @landflow/plugin-<id> test` and `typecheck` pass; `pnpm test` still passes if you touched shared code.
- [ ] The plugin starts, the manifest validates, one `execute` call returns the expected outputs (shown to the user).
- [ ] No secret, personal data or real token in any file; credential fields are `password`, a `baseUrl` is overridable.
- [ ] Docs: the plugin's `README.md`, a row in `docs/history.md`, `docs/limitations.md` for what is not done, the feature map in
  `docs/README.md` if it is a new page (`CLAUDE.md`, "Every change updates its docs").
- [ ] You stopped every process you started. Nothing was pushed or deployed.

## Traps

Do not use `triggerSource: 'webhook' | 'schedule' | 'chat'` for a plugin node (the host ignores them for plugins). Do not rename
a node or parameter after release (saved workflows use the names). A poll trigger with no baseline replays history. Returning
a flat array when the node has two outputs sends everything to output 0. `definePlugin` throws on an undeclared credential
type: read the message, it names the node.
