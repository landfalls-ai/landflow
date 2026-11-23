"""Hello Node: the smallest plugin that shows the parts every integration has.

- a credential type with a "Test connection" check,
- an action (``greet``) that uses the credential and sends items to one of two outputs,
- a poll trigger (``newRequest``) that remembers where it stopped.
"""

from __future__ import annotations

from typing import Any

from landflow_sdk import CredentialType, Node, NodeOperationError, Plugin, poll_interval_property

MAX_NAME_LENGTH = 50


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
