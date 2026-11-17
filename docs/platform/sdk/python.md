# Build a plugin in Python

You will build `hello-node`: an action with a credential and two outputs, and a poll trigger. Every code block on this
page is copied from [`examples/sdk/python/hello-node`](../../../examples/sdk/python/hello-node), whose tests pass. Read
[the overview](README.md) and [capabilities.md](capabilities.md) first for what the parts mean. The SDK's own reference is
[`sdks/python/README.md`](../../../sdks/python/README.md); the full example plugins are
[`plugins/py-insights`](../../../plugins/py-insights) and [`plugins/productivity`](../../../plugins/productivity).

You need Python 3.11 or later. The SDK, `landflow_sdk`, is plain Python: HTTP serving, tracing and metrics use only the
standard library. Extras add gRPC (`[grpc]`), the MCP face (`[mcp]`), OpenTelemetry export (`[otel]`) and brokers
(`[kafka]`, `[amqp]`, `[nats]`, `[valkey]`, `[brokers]` for all four).

## Layout

```
my_plugin/                  (the sample: examples/sdk/python/hello-node)
  setup.sh                  creates .venv (gitignored) and installs sdks/python editable with [grpc,mcp]
  main.py                   serve(build_plugin(), http_port=..., grpc_port=...)
  hello_node/__init__.py    the credential type, the nodes, build_plugin()
  tests/test_hello.py       unittest
```

A bundled Python plugin lives in `plugins/<name>/` with the same shape (`main.py` at the top, a package next to it,
`tests/`, `setup.sh`), and the Dockerfile copies that folder as it is.

## The credential

`CredentialType` declares the form and, with `test`, the "Test connection" check. `test(data, ctx)` returns
`(ok, message)`, a dict, a bool or `None`; raising `NodeOperationError` (or letting `raise_for_status()` raise) becomes
`ok: false` with the message.

```python
def check_hello_api(data: dict[str, Any], ctx: Any) -> tuple[bool, str]:
    """The "Test connection" check. A real plugin makes one cheap authenticated call here with ``ctx.http`` (Slack ``auth.test``,
    Telegram ``getMe``). The sample checks the key's shape so it needs no network."""
    if str(data.get("apiKey", "")).startswith("hello-"):
        return True, "Key accepted"
    return False, 'The key must start with "hello-"'


HELLO_API = CredentialType(
    name="helloApi",
    display_name="Hello API",
    documentation_url="https://example.com/hello-api",
    test=check_hello_api,
    properties=[
        # A password field: masked in the UI and redacted from logs and spans.
        {"name": "apiKey", "displayName": "API key", "type": "string", "required": True, "typeOptions": {"password": True}},
        {"name": "salutation", "displayName": "Salutation", "type": "string", "default": "Hello"},
    ],
)
```

<sub>From `examples/sdk/python/hello-node/hello_node/__init__.py`.</sub>

## The action

One action, two outputs, a credential, a `continue_on_fail` path and a logged line. `description` is a dict in the wire
shape; `execute` returns one list per output.

```python
class Greet(Node):
    """One action, two outputs: output 0 gets the greetings, output 1 the items that had nobody to greet."""

    description = {
        "name": "greet",
        "displayName": "Hello: Greet",
        "description": "Greet the name in each item",
        "version": 1,
        "kind": "action",
        "categories": ["Examples"],
        "icon": "lucide:hand",
        "subtitle": "{{name}}",
        "idempotent": True,  # the same input gives the same output, so a broker may deliver a call twice
        "usableAsTool": True,  # an agent may call it, and it becomes an MCP tool
        "inputs": [{"type": "main"}],
        "outputs": [
            {"type": "main", "displayName": "Greeted"},
            {"type": "main", "displayName": "Skipped"},
        ],
        "credentials": [{"name": "helloApi", "required": True}],
        "properties": [
            {"name": "name", "displayName": "Name", "type": "string", "default": "",
             "description": "Who to greet. An empty name goes to Skipped."},
            {"name": "shout", "displayName": "Shout", "type": "boolean", "default": False},
        ],
    }

    def execute(self, ctx):
        salutation = ctx.get_credentials("helloApi")["salutation"]  # property defaults are filled in
        greeted: list[dict[str, Any]] = []
        skipped: list[dict[str, Any]] = []
        for i, item in enumerate(ctx.get_input_data()):
            try:
                name = str(ctx.get_node_parameter("name", i)).strip()
                if len(name) > MAX_NAME_LENGTH:
                    raise NodeOperationError(f"The name is longer than {MAX_NAME_LENGTH} characters", item_index=i)
                if name == "":
                    skipped.append({"json": {**item["json"], "reason": "empty name"}})
                    continue
                text = f"{salutation}, {name}!"
                greeted.append({"json": {**item["json"], "greeting": text.upper() if ctx.get_node_parameter("shout", i) else text}})
            except NodeOperationError as exc:
                if not ctx.continue_on_fail():  # the node is not set to continue: the step fails
                    raise
                skipped.append({"json": {**item["json"], "error": exc.message}, "pairedItem": {"item": i}})
        ctx.logger.info("greeted", greeted=len(greeted), skipped=len(skipped))
        return [greeted, skipped]
```

<sub>From `examples/sdk/python/hello-node/hello_node/__init__.py`.</sub>

Points to copy:

- `ctx.get_node_parameter(name, i)` reads the parameter for item `i`, with the property's default applied.
- `ctx.get_credentials("helloApi")` returns the values with the type's property defaults filled in
  (`creds["salutation"]`), and raises a `NodeOperationError` that names the type when the host sent none. Pass
  `required: False` in the descriptor and the call returns `None` instead.
- `raise NodeOperationError(message, description=..., item_index=i)` fails the step with a reason the user can read.
- A node returns `list[list[item]]` (one list per output) or a flat `list[item]` for one output. An item is
  `{"json": {...}}`; a bare dict is wrapped. Nodes are shared across request threads, so keep per-run state in locals.
- `async def execute` works too.

## The trigger

```python
# The stand-in for the service a real trigger polls. Tests append to it.
REQUESTS: list[dict[str, Any]] = []


class NewRequest(Node):
    """A poll trigger: the host calls it every ``pollInterval`` seconds with the state the last call returned."""

    description = {
        "name": "newRequest",
        "displayName": "Hello: New Request",
        "description": "Starts the workflow for each new greeting request",
        "version": 1,
        "kind": "trigger",
        "triggerSource": "poll",
        "inputs": [],
        "outputs": [{"type": "main"}],
        "credentials": [{"name": "helloApi", "required": True}],
        "properties": [poll_interval_property(default_seconds=30)],
    }

    def execute(self, ctx):
        ctx.get_credentials("helloApi")
        newest = max((r["id"] for r in REQUESTS), default=0)
        if ctx.mode != "poll":  # "Execute" in the editor: a few recent items, no state
            return [{"json": dict(r)} for r in REQUESTS[-3:]]
        if ctx.is_first_poll():  # baseline: remember where we are and emit nothing
            ctx.set_poll_state({"lastId": newest})
            return []
        last = ctx.get_poll_state()["lastId"]
        ctx.set_poll_state({"lastId": max(last, newest)})
        return [{"json": dict(r)} for r in REQUESTS if r["id"] > last]
```

<sub>From `examples/sdk/python/hello-node/hello_node/__init__.py`.</sub>

`REQUESTS` stands in for the service a real trigger would call with `ctx.http.get(url, headers=...)`, which is traced and
returns an `HttpResponse` (`status`, `ok`, `json`, `raise_for_status()`). `poll_interval_property(default_seconds=30)` adds
the required `pollInterval` property.

## The plugin and `main.py`

```python
def build_plugin() -> Plugin:
    return Plugin(
        "hello-node", "Hello Node", "0.1.0",
        nodes=[Greet(), NewRequest()],
        credential_types=[HELLO_API],
        description="A small example plugin",
        icon="lucide:hand",
        color="#16a34a",
        author="Landflow examples",
    )
```

<sub>From `examples/sdk/python/hello-node/hello_node/__init__.py`.</sub>

`Plugin(...)` validates every descriptor at startup and raises one `DescriptorError` that lists all the problems.

```python
import sys
from pathlib import Path

try:
    import landflow_sdk  # noqa: F401
except ImportError:  # not installed: use the SDK from this checkout
    sys.path.insert(0, str(Path(__file__).resolve().parents[4] / "sdks" / "python"))

from landflow_sdk import serve

from hello_node import build_plugin

if __name__ == "__main__":
    serve(build_plugin(), http_port=7192, grpc_port=7292, max_concurrency=8)
```

<sub>From `examples/sdk/python/hello-node/main.py`.</sub>

`serve` starts the HTTP face, the gRPC face when `grpcio` is installed (one log line says so when it is not), and the MCP
face when the `mcp` package is installed; announces with a heartbeat; and on `SIGINT` or `SIGTERM` withdraws and flushes
telemetry. The `try: import landflow_sdk` fallback lets `python main.py` use the SDK from this checkout when it is not
installed, which is handy; drop it in a plugin that always runs in its venv.

## Run it

```bash
cd examples/sdk/python/hello-node
./setup.sh                                              # .venv with the local SDK and the gRPC and MCP extras
LANDFLOW_REGISTRY_URL=off .venv/bin/python main.py      # stand-alone, no host

# in a second shell
curl -s localhost:7192/.well-known/landflow
curl -s localhost:7192/landflow/v1/manifest
curl -s -XPOST localhost:7192/landflow/v1/test-credentials -H 'content-type: application/json' \
  -d '{"credentialType":"helloApi","data":{"apiKey":"hello-1"}}'
curl -s -XPOST localhost:7192/landflow/v1/execute -H 'content-type: application/json' -d '{
  "protocol":"landflow.plugin/v1","executionId":"e","mode":"manual",
  "node":{"id":"n","name":"n","type":"hello-node.greet","typeVersion":1},
  "parameters":{"name":"Ada"},"itemParameters":[{"name":"Ada"}],"inputs":[[{"json":{}}]],
  "credentials":{"helloApi":{"apiKey":"hello-1"}}}'
```

The last call answers `{"outputs":[[{"json":{"greeting":"Hello, Ada!"},...}],[]],...}`; the credential's `salutation` default
`Hello` was filled in because the request did not send it. A venv is required on Homebrew Python (PEP 668).
`LANDFLOW_HTTP_PORT` and `LANDFLOW_GRPC_PORT` override the ports (`off` disables one, `0` picks a free port).

## Register it with a dev host

Start the host (`pnpm dev`, port 3000) and the plugin **without** `LANDFLOW_REGISTRY_URL=off`. It announces to
`http://127.0.0.1:3000`, the host pulls and validates the manifest, and the nodes show in the editor. A plugin on ports
7100-7299 is found by the scan too. After a code change restart the plugin: the new `instanceId` makes the host read the
manifest again, with no version bump. To try it without touching `apps/web/.data`, run a scratch host with its own data
directory ([development.md, "Checking a change live"](../../development.md#checking-a-change-live)) and set
`LANDFLOW_REGISTRY_URL=http://localhost:3100`. That is how the samples were checked: they announced as `hello-node`, the
registry listed `greet` and `newRequest`, and every endpoint showed `online`. Add a credential of type
`hello-node.helloApi` with a key that starts with `hello-` and press **Test connection**.

## Test it

`Plugin` is the test harness: call it with the dict the host would send and read the dict it returns, with no server and no
network.

| Call | Returns |
|---|---|
| `plugin.execute(request)` | the `ExecuteResponse` dict: `outputs`, `error`, `pollState`, `logs` |
| `plugin.test_credentials(type, data)` | `{"ok": ..., "message": ...}` |
| `plugin.load_options(...)`, `plugin.load_options_request(request)` | the options for a `loadOptionsMethod` |
| `plugin.webhook_method(request)`, `plugin.receive_webhook(request)` | an app webhook trigger |
| `plugin.manifest()` | the `PluginManifest` dict: assert on nodes, outputs and `testable` |

```python
CREDENTIALS = {"helloApi": {"apiKey": "hello-123", "salutation": "Hello"}}


def request(node: str, parameters: dict[str, Any], items: list[dict[str, Any]], **more: Any) -> dict[str, Any]:
    return {
        "protocol": "landflow.plugin/v1", "executionId": "ex_test", "mode": "manual",
        "node": {"id": "n1", "name": node, "type": f"hello-node.{node}", "typeVersion": 1},
        "parameters": parameters, "itemParameters": [parameters for _ in items],
        "inputs": [[{"json": item} for item in items]],
        "credentials": CREDENTIALS, **more,
    }


class GreetTest(unittest.TestCase):
    def test_greetings_go_to_output_0_and_empty_names_to_output_1(self):
        response = build_plugin().execute(request("greet", {"name": "Ada", "shout": False}, [{"id": 1}]))
        self.assertNotIn("error", response)
        self.assertEqual([i["json"] for i in response["outputs"][0]], [{"id": 1, "greeting": "Hello, Ada!"}])
        self.assertEqual(response["outputs"][1], [])

        empty = build_plugin().execute(request("greet", {"name": "  "}, [{"id": 2}]))
        self.assertEqual(empty["outputs"][0], [])
        self.assertEqual([i["json"] for i in empty["outputs"][1]], [{"id": 2, "reason": "empty name"}])

    def test_shouts_and_uses_the_credential_salutation(self):
        response = build_plugin().execute(request(
            "greet", {"name": "Ada", "shout": True}, [{}], credentials={"helloApi": {"apiKey": "hello-1", "salutation": "Hi"}}))
        self.assertEqual(response["outputs"][0][0]["json"]["greeting"], "HI, ADA!")

    def test_a_long_name_fails_the_step_with_the_item_index(self):
        response = build_plugin().execute(request("greet", {"name": "x" * 51}, [{}]))
        self.assertIn("longer than 50", response["error"]["message"])
        self.assertEqual(response["error"]["itemIndex"], 0)

    def test_a_node_set_to_continue_on_fail_sends_the_item_to_skipped(self):
        response = build_plugin().execute(request("greet", {"name": "x" * 51}, [{}], continueOnFail=True))
        self.assertNotIn("error", response)
        self.assertIn("longer than 50", response["outputs"][1][0]["json"]["error"])

    def test_refuses_to_run_without_the_credential(self):
        response = build_plugin().execute(request("greet", {"name": "Ada"}, [{}], credentials={}))
        self.assertIn("helloApi", response["error"]["message"])


class CredentialTest(unittest.TestCase):
```

<sub>From `examples/sdk/python/hello-node/tests/test_hello.py`.</sub>

```python
class NewRequestTest(unittest.TestCase):
    def setUp(self):
        hello_node.REQUESTS.clear()

    def test_records_a_baseline_first_then_returns_only_what_is_new(self):
        plugin = build_plugin()
        hello_node.REQUESTS.append({"id": 1, "name": "old"})
        first = plugin.execute(request("newRequest", {}, [], mode="poll", inputs=[]))
        self.assertEqual(first["outputs"][0] if first["outputs"] else [], [])
        self.assertEqual(first["pollState"], {"lastId": 1})

        hello_node.REQUESTS.append({"id": 2, "name": "new"})
        second = plugin.execute(request("newRequest", {}, [], mode="poll", inputs=[], pollState=first["pollState"]))
        self.assertEqual([i["json"] for i in second["outputs"][0]], [{"id": 2, "name": "new"}])
        self.assertEqual(second["pollState"], {"lastId": 2})

    def test_shows_recent_items_in_manual_mode_without_state(self):
        hello_node.REQUESTS.append({"id": 1, "name": "a"})
        response = build_plugin().execute(request("newRequest", {}, [], mode="manual", inputs=[]))
        self.assertEqual(len(response["outputs"][0]), 1)
        self.assertNotIn("pollState", response)


class ManifestTest(unittest.TestCase):
```

<sub>From `examples/sdk/python/hello-node/tests/test_hello.py`.</sub>

Run them:

```bash
cd examples/sdk/python/hello-node
.venv/bin/python -m unittest discover -s tests
```

Run the SDK's own tests with `python3 -m unittest discover -s sdks/python/tests`. A bundled plugin's tests are run the
same way from its folder (`cd plugins/py-insights && .venv/bin/python -m unittest discover -s tests`).

## Package it

1. **Move it into `plugins/<name>`** with `main.py` at the top and a `setup.sh` like `plugins/py-insights/setup.sh`
   (editable install of `../../sdks/python[grpc,mcp,brokers]`). Add a root script `plugin:<name>` to `package.json` if you
   want one command like the others.
2. **Image.** `deploy/docker/python-plugin.Dockerfile` installs the SDK with every extra into `/opt/venv`, adds the
   `landflow-bridge` binary for the other broker kinds, copies `plugins/${PLUGIN}/` to `/app` as an unprivileged user and
   runs `python main.py`, with a health check on `/landflow/v1/health`:

   ```bash
   docker build -f deploy/docker/python-plugin.Dockerfile \
     --build-arg PLUGIN=<name> --build-arg HTTP_PORT=<7xxx> --build-arg GRPC_PORT=<7yyy> \
     -t landflow/plugin-<name>:dev .
   ```

   There is no `requirements.txt` step: a dependency of your own must be added to the Dockerfile (a copy of it for your
   plugin) or vendored into the plugin folder. Build locally only and never push; compose builds with
   `COMPOSE_BAKE=false`, and an image for the OrbStack cluster with `docker --context orbstack buildx build --builder orbstack --load`
   ([CLAUDE.md](../../../CLAUDE.md)).
3. **Compose and Kubernetes.** Copy the `py-insights` block in `deploy/compose.yml` (names, ports,
   `LANDFLOW_ADVERTISE_HOST`, and the service name in `LANDFLOW_SCAN_HOSTS`), and
   `deploy/k8s/base/plugins/py-insights.yaml` (Deployment, Service labelled `landflow.dev/plugin=true`, listed in
   `deploy/k8s/base/kustomization.yaml`). The pod listens on `0.0.0.0`: keep `LANDFLOW_MCP=off` or give it a token.
4. Docs: a row in `docs/history.md`, the plugin's README, `docs/limitations.md` if it is not finished.

## Add it to the marketplace

Add `plugins/<name>/landflow.plugin.json` and an entry in `.claude-plugin/marketplace.json`
([the format](capabilities.md#marketplace-format-and-bundled-flows)), with flows under `plugins/<name>/flows/`. For
`"runtime": "python"` the host runs `install` and `start` as given and links **no** SDK: unlike a TypeScript or Go plugin
(where it rewrites the dependency to its own copy), your `install` must create the environment and install
`landflow-sdk` itself, and `start` must run the interpreter that has it. That route was not tried here. If people run the
process themselves (compose, Kubernetes) none of this applies.

## Outside this repository

`landflow-sdk` is not on PyPI. It installs from the repository (the syntax was checked against a local clone):

```bash
pip install "landflow-sdk[grpc,mcp] @ git+https://github.com/landfalls-ai/landflow.git#subdirectory=sdks/python"
# or from a clone:  pip install -e "../landflow/sdks/python[grpc,mcp]"
```

In `pyproject.toml` or `requirements.txt` write the same direct reference. Pin a commit (`...landflow.git@<sha>#subdirectory=...`)
so a change to the SDK cannot change your plugin. The wire contract is the same everywhere: a plugin that only speaks
`landflow.plugin/v1` needs nothing else from the repository.

## Traps

- **Return a list for each output**, even an empty one: `[greeted, skipped]`. `[]` alone means one empty output.
- **Nodes are shared across threads.** Do not keep per-run state on `self`.
- **Copy before you change:** `{**item["json"], "x": 1}`.
- **A poll trigger must set a baseline** on the first poll (`ctx.is_first_poll()`) and return nothing.
- **`ctx.get_poll_state()` is `None` on the first poll**; the sample reads it only after the first-poll branch.
- **`description` is validated:** `kind`, `inputs`, `outputs`, `properties` are required keys, `name` is local, the host sees
  `<pluginId>.<name>`.
- **The MCP face needs `[mcp]`.** Without it `serve()` logs `MCP face not started` as an error line; set `LANDFLOW_MCP=off`
  to silence it.
- **Do not name a helper `test_*`** in a module the test runner imports.
