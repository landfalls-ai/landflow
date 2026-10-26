"""App webhook triggers (docs/protocol.md §12): what ``Node.webhook_*`` and ``Node.webhook`` see.

A trigger with ``"triggerSource": "appWebhook"`` registers its own webhook with an external service when the workflow
is published and removes it when it is unpublished, like n8n's ``webhookMethods``::

    class RepoTrigger(Node):
        description = {..., "kind": "trigger", "triggerSource": "appWebhook", "inputs": [], "outputs": [{"type": "main"}]}

        def webhook_check_exists(self, ctx):
            hook_id = ctx.get_static_data().get("hookId")
            return bool(hook_id) and ctx.http.get(f"{API}/hooks/{hook_id}").status == 200

        def webhook_create(self, ctx):
            hook = ctx.http.post(f"{API}/hooks", json={"url": ctx.get_webhook_url()}).json
            ctx.get_static_data().update(hookId=hook["id"], secret=hook["secret"])

        def webhook_delete(self, ctx):
            ctx.http.delete(f"{API}/hooks/{ctx.get_static_data().get('hookId')}")
            ctx.set_static_data({})

        def webhook(self, ctx):
            if not verify_github_signature(ctx.get_static_data().get("secret", ""), ctx.get_raw_body(),
                                           ctx.get_header("X-Hub-Signature-256")):
                return {"response": {"status": 401}}
            return {"items": [ctx.get_body()], "idempotencyKey": ctx.get_header("X-GitHub-Delivery")}

The host keeps the static data per workflow and node; changes made to ``ctx.get_static_data()`` (or a
``set_static_data()``) go back with the response. ``webhook()`` returns ``{"items", "response", "idempotencyKey"}``
or just a list of items; no items start no run (a ping, a rejected signature).
"""

from __future__ import annotations

import base64
import binascii
import copy
import json
from typing import Any, Mapping
from urllib.parse import parse_qsl

from .context import NodeLogger, _get_credentials, _TelemetryContext, _visible
from .metrics import Metrics
from .protocol import to_jsonable
from .telemetry import Span, Telemetry

WEBHOOK_METHODS = ("checkExists", "create", "delete")


def _parameter_defaults(properties: list[dict[str, Any]], parameters: Mapping[str, Any]) -> dict[str, Any]:
    """``parameters`` plus the defaults of the visible properties (the first visible property of a name wins)."""
    values = dict(parameters)
    for _ in range(8):
        changed = False
        for prop in properties:
            if prop.get("type") == "notice" or "default" not in prop or prop["name"] in values:
                continue
            if _visible(prop, values):
                values[prop["name"]] = prop["default"]
                changed = True
        if not changed:
            break
    return values


class WebhookContext(_TelemetryContext):
    """Passed to ``webhook_check_exists`` / ``webhook_create`` / ``webhook_delete`` and to ``webhook``.

    Attributes: ``node`` (NodeRef dict), ``node_type``, ``workflow_id``, ``method`` (the webhook method, ``None`` in
    ``webhook()``), ``parameters`` (expressions resolved without items), ``credentials``, ``logger``, ``metrics``,
    ``http`` and ``span()``. In ``webhook()`` also ``request``: ``{"method", "path", "headers" (lower-case), "query",
    "raw_body"}``.
    """

    def __init__(
        self,
        request: dict[str, Any],
        descriptor: dict[str, Any],
        *,
        plugin_id: str = "",
        telemetry: Telemetry | None = None,
        credentials: dict[str, Any] | None = None,
        span: Span | None = None,
        cancel: Any = None,
    ) -> None:
        self.descriptor = descriptor
        self._cancel = cancel
        self.node: dict[str, Any] = request["node"]
        self.node_type: str = self.node.get("type") or ""
        self.plugin_id = plugin_id
        self.workflow_id: str = request.get("workflowId") or ""
        self.method: str | None = request.get("method") if "request" not in request else None
        self.parameters: dict[str, Any] = request.get("parameters") or {}
        self.credentials: dict[str, Any] = credentials if credentials is not None else (request.get("credentials") or {})
        self.telemetry = telemetry or Telemetry.noop()
        self._server_span = span
        self._http = None
        self._webhook_url: str = request.get("webhookUrl") or ""
        initial = request.get("staticData") or {}
        self._static_initial = json.dumps(to_jsonable(initial), sort_keys=True)
        self._static_data: dict[str, Any] = copy.deepcopy(initial)
        properties = [prop for prop in descriptor.get("properties", []) if isinstance(prop, dict) and "name" in prop]
        self._values = _parameter_defaults(properties, self.parameters)
        node_name = self.node.get("name") or descriptor.get("name", "")
        self.logger = NodeLogger(
            node_name,
            attributes={"landflow.node.type": self.node_type, "landflow.node.name": node_name, "landflow.workflow.id": self.workflow_id},
            service=self.telemetry.service_name if telemetry is not None else None,
        )
        self.metrics = Metrics(
            self.telemetry.metrics,
            {"landflow.plugin.id": plugin_id, "landflow.node.type": self.node_type, "landflow.workflow.id": self.workflow_id},
        )
        incoming = request.get("request")
        self.request: dict[str, Any] | None = None
        self._body: Any = _UNPARSED
        if isinstance(incoming, dict):
            headers = {str(k).lower(): str(v) for k, v in (incoming.get("headers") or {}).items()}
            self.request = {
                "method": incoming.get("method") or "POST",
                "path": incoming.get("path") or "",
                "headers": headers,
                "query": dict(incoming.get("query") or {}),
                "raw_body": incoming.get("rawBody", b""),
            }

    def get_node_parameter(self, name: str, item_index: int = 0, default: Any = None) -> Any:
        """A parameter, else the property's default in the descriptor, else ``default``.

        Same signature as ``ExecuteContext.get_node_parameter`` so helpers work with both; there are no items here, so
        ``item_index`` is ignored.
        """
        return self._values.get(name, default)

    def get_credentials(self, name: str | None = None) -> dict[str, Any] | None:
        """Same as ``ExecuteContext.get_credentials``."""
        return _get_credentials(self.descriptor, self.credentials, name)

    def get_webhook_url(self) -> str:
        """Where the service must send its calls: ``{publicUrl}/api/webhook/app/<workflowId>/<nodeId>``."""
        return self._webhook_url

    def get_static_data(self) -> dict[str, Any]:
        """The node's static data for this workflow (a webhook id, a signing secret). Change it in place; the host stores it."""
        return self._static_data

    def set_static_data(self, data: Mapping[str, Any]) -> None:
        """Replace the static data."""
        if not isinstance(data, Mapping):
            raise TypeError(f"static data must be a dict, got {type(data).__name__}")
        self._static_data = dict(data)

    def _changed_static_data(self) -> dict[str, Any] | None:
        current = to_jsonable(self._static_data)
        return current if json.dumps(current, sort_keys=True) != self._static_initial else None

    # ------------------------------------------------------------ webhook()

    def _incoming(self) -> dict[str, Any]:
        if self.request is None:
            raise RuntimeError("the request is only available in webhook()")
        return self.request

    def get_header(self, name: str) -> str | None:
        """A request header (case-insensitive)."""
        return self._incoming()["headers"].get(name.lower())

    def get_raw_body(self) -> bytes:
        """The body bytes exactly as sent (what signatures cover)."""
        return self._incoming()["raw_body"]

    def get_body(self) -> Any:
        """The body: parsed JSON, a form-urlencoded body as a dict, else the text (``{}`` when empty)."""
        if self._body is _UNPARSED:
            self._body = _parse_body(self.get_raw_body(), self.get_header("content-type") or "")
        return self._body


_UNPARSED = object()


def _parse_body(raw: bytes, content_type: str) -> Any:
    text = raw.decode("utf-8", errors="replace")
    if not text:
        return {}
    looks_json = text.lstrip()[:1] in ("{", "[")
    if "json" in content_type.lower() or (not content_type and looks_json):
        try:
            return json.loads(text)
        except ValueError:
            return text
    if "application/x-www-form-urlencoded" in content_type.lower():
        form = dict(parse_qsl(text, keep_blank_values=True))
        # GitHub and others can send JSON as a ``payload`` form field.
        payload = form.get("payload")
        if isinstance(payload, str) and payload.lstrip()[:1] in ("{", "["):
            try:
                return json.loads(payload)
            except ValueError:
                pass
        return form
    return text


def decode_body(value: Any) -> bytes:
    """``IncomingWebhookRequest.body``: base64 over JSON, bytes over gRPC."""
    if isinstance(value, (bytes, bytearray, memoryview)):
        return bytes(value)
    if not value:
        return b""
    if not isinstance(value, str):
        raise ValueError("request.body must be a base64 string")
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        raise ValueError("request.body must be base64") from None


def normalize_webhook_result(result: Any) -> dict[str, Any]:
    """``webhook()``'s return value -> the ``items`` / ``response`` / ``idempotencyKey`` part of a ``WebhookResponse``."""
    out: dict[str, Any] = {}
    if result is None:
        return out
    if isinstance(result, (list, tuple)):
        entries: Any = list(result)
        reply = None
        key = None
    elif isinstance(result, dict):
        entries = result.get("items") or []
        reply = result.get("response")
        key = result.get("idempotencyKey", result.get("idempotency_key"))
    else:
        raise TypeError(f"webhook() must return a dict or a list of items, got {type(result).__name__}")
    items = []
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            raise TypeError(f"webhook() item {index} is a {type(entry).__name__}, expected a dict")
        if isinstance(entry.get("json"), dict) and set(entry) <= {"json", "binary", "pairedItem"}:
            item = {"json": to_jsonable(entry["json"])}
            if entry.get("binary"):
                item["binary"] = to_jsonable(entry["binary"])
        else:
            item = {"json": to_jsonable(entry)}
        items.append(item)
    if items:
        out["items"] = items
    if reply:
        if not isinstance(reply, dict):
            raise TypeError("webhook() response must be a dict {status, headers, body | json}")
        headers = {str(k): str(v) for k, v in (reply.get("headers") or {}).items()}
        body = reply.get("body")
        if reply.get("json") is not None:
            body = json.dumps(to_jsonable(reply["json"]), separators=(",", ":"))
            if not any(name.lower() == "content-type" for name in headers):
                headers["content-type"] = "application/json; charset=utf-8"
        response: dict[str, Any] = {}
        if reply.get("status"):
            response["status"] = int(reply["status"])
        if headers:
            response["headers"] = headers
        if body is not None:
            response["body"] = body.decode("utf-8", errors="replace") if isinstance(body, (bytes, bytearray)) else str(body)
        out["response"] = response
    if key:
        out["idempotencyKey"] = str(key)
    return out
