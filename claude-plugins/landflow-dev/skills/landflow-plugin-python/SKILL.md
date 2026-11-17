---
name: landflow-plugin-python
description: Build a Landflow node plugin in Python with landflow-sdk. Use when asked to "write a Landflow node in Python", "add an integration/plugin for X using Python", "a node that ...", "add a trigger/credential/webhook to a Python plugin", or to scaffold, run, test, register, containerize or add a Python plugin to the Landflow marketplace.
---

# Build a Landflow plugin in Python

You turn a request ("a node that ...") into a working plugin: descriptor, `execute`, credential, optional trigger, tests,
a local run that a host can discover, a Dockerfile route and a marketplace entry. Work in small steps and run each check.

## 0. Where am I?

Run `ls docs/platform/sdk examples/sdk/python/hello-node sdks/python/landflow_sdk 2>&1 | head`.

- **Those folders exist (inside the Landflow repository).** Read the local files named below. Build in `plugins/<name>/`.
- **They do not (your own repository).** Use GitHub. Fetch with `WebFetch` or `gh api`:
  `https://raw.githubusercontent.com/landfalls-ai/landflow/main/<path>` for raw files, or
  `https://github.com/landfalls-ai/landflow/blob/main/<path>`. `landflow-sdk` is **not on PyPI**: see step 9.

Read first (local path, same path on GitHub):

1. `docs/platform/sdk/python.md`: the walk-through of the whole job, with code copied from the sample.
2. `docs/platform/sdk/capabilities.md`: pick the features the request needs (outputs, trigger kind, binary data, OAuth, MCP).
3. `examples/sdk/python/hello-node/hello_node/__init__.py`, `main.py`, `setup.sh`, `tests/test_hello.py`: the template to copy.
4. `sdks/python/README.md`: the context API; `docs/protocol.md` only when a field is unclear.
5. The closest shipped plugin: `plugins/py-insights` (pure transforms, binary files, load-options),
   `plugins/productivity` (API integrations, OAuth2, webhook triggers, pagination helper).

## 1. Decide the shape (write it down before coding)

Answer these from the request, then tell the user in two lines:

- Plugin id (lowercase, dashes) and folder `plugins/<id>`; node names (lowerCamelCase, local).
- Per node: `action` or `trigger` (`poll` or `appWebhook`; **no** other trigger sources for a plugin), outputs, the
  parameters (type, default, `displayOptions`), `idempotent` (true for a read), `usableAsTool`.
- Credential type: fields, which are `password`, an overridable `baseUrl`, a cheap `test`. OAuth2: `extends=["oAuth2Api"]`.
- What a plugin **cannot** do from a separate process: wait/resume, sub-nodes (model, memory), streaming. If the request needs
  it, say so and propose the host's own nodes around the plugin (`docs/limitations.md`).

## 2. Scaffold

```bash
mkdir -p plugins/<id>/<pkg> plugins/<id>/tests
cp examples/sdk/python/hello-node/{main.py,setup.sh} plugins/<id>/
cp examples/sdk/python/hello-node/hello_node/__init__.py plugins/<id>/<pkg>/__init__.py
cp examples/sdk/python/hello-node/tests/test_hello.py plugins/<id>/tests/
```

Then in `plugins/<id>`: rename `hello_node`/`hello-node`; fix the relative path to the SDK in `setup.sh` (two levels up:
`../../sdks/python[grpc,mcp,brokers]`, as `plugins/py-insights/setup.sh`) and in the `parents[...]` fallbacks (`main.py`: `parents[2]`; the test: `HERE.parents[1]`); pick two free ports (`grep -rnE "HTTP_PORT = [0-9]+|http_port=[0-9]+" plugins/*/main.py`; 7101-7120 and the samples'
7191-7193 are taken). Run `./setup.sh`; the `.venv` is gitignored.

## 3. Write the node

- `class X(Node)` with `description = {...}` (wire shape: `name`, `displayName`, `description`, `version: 1`, `kind`, `inputs`,
  `outputs` with `displayName`, `credentials`, `properties`, `idempotent`) and `def execute(self, ctx)`.
- Loop `for i, item in enumerate(ctx.get_input_data())`, read `ctx.get_node_parameter(name, i)`, call APIs with `ctx.http`
  (traced; `.get/.post`, `resp.json`, `resp.raise_for_status()`), return `[out0, out1, ...]`. Copy items
  (`{**item["json"], "x": x}`); keep `pairedItem` when you add items.
- Errors: `raise NodeOperationError(message, description="what to do", item_index=i)`. Support `ctx.continue_on_fail()` by appending
  `{"json": {"error": msg}, "pairedItem": {"item": i}}`.
- Dynamic lists: `typeOptions: {"loadOptionsMethod": "getX"}` and `def load_options(self, method, parameters)`; end with
  `return super().load_options(method, parameters)`.
- Binary: `ctx.assert_binary_data`, `ctx.get_binary_bytes`, `ctx.prepare_binary_data` (capabilities.md, "Binary data").
- Nodes are shared across threads: no per-run state on `self`. Never log secrets.

## 4. Credential

`CredentialType(name=..., display_name=..., documentation_url=..., properties=[...], test=fn)` with the secret field
`"typeOptions": {"password": True}`, a `baseUrl`, and `fn(data, ctx)` making one cheap authenticated call and returning
`(ok, message)`. Pass it in `Plugin(..., credential_types=[...])` and list it in each node's `credentials`. Read it with
`ctx.get_credentials("name")` (defaults filled in). Never put a real token in code, tests or docs: tests use fake values.

## 5. Trigger (only if asked)

Poll: `"kind": "trigger"`, `"triggerSource": "poll"`, `"inputs": []`, `properties: [poll_interval_property(60)]`; on the first poll
(`ctx.is_first_poll()`) `ctx.set_poll_state({...})` and return `[]`; later return only new items and set the state; in
`ctx.mode == "manual"` return the latest few and no state. App webhook: `"triggerSource": "appWebhook"`, methods
`webhook_check_exists`, `webhook_create`, `webhook_delete`, `webhook`; verify the signature (`verify_github_signature`,
`verify_hmac_sha256`, ...), return `{"items": [...], "idempotencyKey": key}`, keep the hook id and secret with `ctx.set_static_data`.
Template: `plugins/productivity/productivity/github.py`.

## 6. Test (write them with the node, not after)

Copy `tests/test_hello.py`: `request(...)` builds the `ExecuteRequest` dict; `build_plugin().execute(request)` returns the response
dict. Cover each output, an error with `itemIndex`, `continueOnFail`, a missing credential, `plugin.test_credentials(type, data)`, the poll
baseline and the next poll, and `plugin.manifest()`. Stub network calls (a local `http.server` thread or a monkeypatched client),
never the real service.

```bash
cd plugins/<id> && .venv/bin/python -m unittest discover -s tests
```

## 7. Run, discover, register

```bash
cd plugins/<id> && LANDFLOW_REGISTRY_URL=off .venv/bin/python main.py      # in the background
curl -s localhost:<http>/.well-known/landflow; curl -s localhost:<http>/landflow/v1/manifest
curl -s -XPOST localhost:<http>/landflow/v1/execute -H 'content-type: application/json' -d '<an ExecuteRequest>'
```

Check the manifest lists your nodes and credential types and an execute answers. Then register with a host: start it (`pnpm dev`, or a
scratch host with its own `LANDFLOW_DATA_DIR` per `docs/development.md` "Checking a change live") and start the plugin without
`LANDFLOW_REGISTRY_URL=off`. Stop only the processes you started, by pid. Never touch `apps/web/.data` or other people's containers.

## 8. Package (only when asked)

- Image: `deploy/docker/python-plugin.Dockerfile --build-arg PLUGIN=<id> HTTP_PORT=... GRPC_PORT=...`; it installs the SDK with every
  extra and copies `plugins/<id>/` to `/app`, running `python main.py`. It has no step for your own dependencies: add one to a copy of
  the Dockerfile or vendor them. Local only: `COMPOSE_BAKE=false`; OrbStack cluster images
  `docker --context orbstack buildx build --builder orbstack --load`; never push.
- Compose: copy the `py-insights` block in `deploy/compose.yml` and add the service to `LANDFLOW_SCAN_HOSTS`. Kubernetes: copy
  `deploy/k8s/base/plugins/py-insights.yaml` and list it in `deploy/k8s/base/kustomization.yaml`.
- Marketplace: `plugins/<id>/landflow.plugin.json` with `"runtime": "python"`, an entry in `.claude-plugin/marketplace.json`, flows in
  `flows/`. The host links **no** SDK for Python: `install` must create the environment and install `landflow-sdk`, and `start` must run
  that interpreter (not tried by the authors; say so). Run `cd apps/web && npx vitest run test/plugin-flows.test.ts`.
- A node in a **bundled** plugin also needs its recorded manifest refreshed (`docs/development.md`, "Recorded plugin manifests").

## 9. Outside the Landflow repository

`landflow-sdk` is not on PyPI. Install it from GitHub (checked against a local clone):

```bash
pip install "landflow-sdk[grpc,mcp] @ git+https://github.com/landfalls-ai/landflow.git#subdirectory=sdks/python"
```

Pin a commit with `@<sha>` before `#`. Python 3.11+. Use a venv. Copy the sample's `hello_node/`, `main.py` and `tests/`; drop the
`sys.path` fallback in `main.py` and the test (it only helps inside the Landflow repository).

## 10. Checks before you say done

- [ ] `.venv/bin/python -m unittest discover -s tests` passes; if you touched `sdks/python`, run `python3 -m unittest discover -s sdks/python/tests`.
- [ ] The plugin starts, the manifest validates, one `execute` call returns the expected outputs (shown to the user).
- [ ] No secret, personal data or real token in any file; credential fields are `password`, a `baseUrl` is overridable.
- [ ] Docs: the plugin's `README.md`, a row in `docs/history.md`, `docs/limitations.md` for what is not done, the feature map in
  `docs/README.md` if it is a new page (`CLAUDE.md`, "Every change updates its docs").
- [ ] You stopped every process you started. Nothing was pushed or deployed.

## Traps

Do not use `triggerSource` `webhook`, `schedule` or `chat` for a plugin node. Do not rename a node or parameter after release. A poll
trigger with no baseline replays history. Returning a flat list when the node has two outputs sends everything to output 0 (return
`[a, b]`). `Plugin(...)` raises `DescriptorError` listing every problem at startup: read all of it. Without the `[mcp]` extra `serve()`
logs an error line about the MCP face; `LANDFLOW_MCP=off` silences it.
