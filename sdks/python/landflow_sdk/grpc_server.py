"""gRPC binding (``pip install 'landflow-sdk[grpc]'``).

Converts the proto envelope (``DynamicValue`` = JSON bytes) to and from the
same plain dicts the HTTP binding uses, then delegates to ``Plugin``. The
call's metadata (``traceparent`` / ``tracestate`` / ``baggage``) is handed over
so server spans continue the caller's trace.
Importing this module raises ``ImportError`` when grpcio/protobuf are missing.
"""

from __future__ import annotations

import json
import logging
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import grpc

from ._pb import plugin_pb2 as pb
from ._pb import plugin_pb2_grpc as pb_grpc
from .announce import RegistryRejected, RegistryUnreachable, registry_secret_headers
from .errors import ProtocolError, UnknownCredentialTypeError, UnknownMethodError, UnknownNodeError
from .plugin import Plugin
from .protocol import PROTOCOL_VERSION, dumps
from .webhooks import decode_body

log = logging.getLogger("landflow_sdk.grpc")

MAX_MESSAGE_BYTES = 64 * 1024 * 1024

# ---------------------------------------------------------------------------
# DynamicValue
# ---------------------------------------------------------------------------


def to_dynamic(value: Any) -> pb.DynamicValue:
    return pb.DynamicValue(json=dumps(value))


def from_dynamic(value: pb.DynamicValue | None, fallback: Any, field: str = "value") -> Any:
    if value is None or not value.json:
        return fallback
    try:
        return json.loads(value.json.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise ProtocolError(f"{field}: DynamicValue does not hold valid UTF-8 JSON ({exc})") from None


def _optional(msg: Any, field: str) -> Any:
    return getattr(msg, field) if msg.HasField(field) else None


# ---------------------------------------------------------------------------
# Converters (proto <-> protocol dicts)
# ---------------------------------------------------------------------------


def _item_from_proto(item: pb.Item, where: str) -> dict[str, Any]:
    out: dict[str, Any] = {"json": from_dynamic(_optional(item, "json"), {}, where)}
    files = from_dynamic(_optional(item, "binary"), None, where.replace(".json", ".binary"))
    if isinstance(files, dict) and files:
        out["binary"] = files
    if item.HasField("paired_item"):
        out["pairedItem"] = {"item": item.paired_item.item, "input": item.paired_item.input}
    return out


def _items_to_branch(items: list[dict[str, Any]], branch: pb.Branch) -> None:
    for item in items:
        msg = branch.items.add()
        msg.json.json = dumps(item["json"])
        if item.get("binary"):
            msg.binary.json = dumps(item["binary"])
        paired = item.get("pairedItem")
        if paired is not None:
            msg.paired_item.item = int(paired["item"])
            msg.paired_item.input = int(paired.get("input") or 0)


def execute_request_from_proto(msg: pb.ExecuteRequest) -> dict[str, Any]:
    node = msg.node
    request: dict[str, Any] = {
        "protocol": msg.protocol or PROTOCOL_VERSION,
        "executionId": msg.execution_id,
        "mode": msg.mode or "manual",
        "node": {"id": node.id, "name": node.name, "type": node.type, "typeVersion": node.type_version or 1},
        "parameters": from_dynamic(_optional(msg, "parameters"), {}, "parameters"),
        "itemParameters": [from_dynamic(p, {}, f"item_parameters[{i}]") for i, p in enumerate(msg.item_parameters)],
        "inputs": [
            [_item_from_proto(item, f"inputs[{i}][{j}].json") for j, item in enumerate(branch.items)]
            for i, branch in enumerate(msg.inputs)
        ],
    }
    if msg.workflow_id:
        request["workflowId"] = msg.workflow_id
    credentials = from_dynamic(_optional(msg, "credentials"), None, "credentials")
    if credentials:
        request["credentials"] = credentials
    poll_state = from_dynamic(_optional(msg, "poll_state"), None, "poll_state")
    if poll_state is not None:
        request["pollState"] = poll_state
    if msg.continue_on_fail:
        request["continueOnFail"] = True
    if msg.HasField("binary_access") and msg.binary_access.url:
        request["binaryAccess"] = {"url": msg.binary_access.url, "token": msg.binary_access.token}
    if msg.idempotency_key:
        request["idempotencyKey"] = msg.idempotency_key
    return request


def execute_request_to_proto(request: dict[str, Any]) -> pb.ExecuteRequest:
    """Client-side helper (tests, tools): ExecuteRequest dict -> proto."""
    node = request.get("node") or {}
    msg = pb.ExecuteRequest(
        protocol=request.get("protocol", PROTOCOL_VERSION),
        execution_id=request.get("executionId", ""),
        workflow_id=request.get("workflowId", ""),
        mode=request.get("mode", "manual"),
        node=pb.NodeRef(
            id=node.get("id", ""), name=node.get("name", ""), type=node.get("type", ""),
            type_version=int(node.get("typeVersion", 1)),
        ),
        parameters=to_dynamic(request.get("parameters") or {}),
        item_parameters=[to_dynamic(p) for p in request.get("itemParameters") or []],
    )
    for items in request.get("inputs") or []:
        _items_to_branch(items, msg.inputs.add())
    if request.get("credentials"):
        msg.credentials.CopyFrom(to_dynamic(request["credentials"]))
    if request.get("pollState") is not None:
        msg.poll_state.CopyFrom(to_dynamic(request["pollState"]))
    if request.get("continueOnFail"):
        msg.continue_on_fail = True
    access = request.get("binaryAccess")
    if access:
        msg.binary_access.url = access.get("url", "")
        msg.binary_access.token = access.get("token", "")
    if request.get("idempotencyKey"):
        msg.idempotency_key = request["idempotencyKey"]
    return msg


def execute_response_to_proto(response: dict[str, Any]) -> pb.ExecuteResponse:
    msg = pb.ExecuteResponse()
    for items in response.get("outputs") or []:
        _items_to_branch(items, msg.outputs.add())
    for entry in response.get("logs") or []:
        msg.logs.add(level=entry["level"], message=entry["message"])
    error = response.get("error")
    if error:
        msg.error.message = error["message"]
        msg.error.description = error.get("description") or ""
        item_index = error.get("itemIndex")
        msg.error.item_index = -1 if item_index is None else int(item_index)
    if response.get("pollState") is not None:
        msg.poll_state.CopyFrom(to_dynamic(response["pollState"]))
    return msg


def execute_response_from_proto(msg: pb.ExecuteResponse) -> dict[str, Any]:
    """Client-side helper: proto -> ExecuteResponse dict."""
    response: dict[str, Any] = {
        "outputs": [
            [_item_from_proto(item, f"outputs[{i}][{j}].json") for j, item in enumerate(branch.items)]
            for i, branch in enumerate(msg.outputs)
        ],
        "logs": [{"level": entry.level, "message": entry.message} for entry in msg.logs],
    }
    if msg.HasField("error") and msg.error.message:
        error: dict[str, Any] = {"message": msg.error.message}
        if msg.error.description:
            error["description"] = msg.error.description
        if msg.error.item_index >= 0:
            error["itemIndex"] = msg.error.item_index
        response["error"] = error
    poll_state = from_dynamic(_optional(msg, "poll_state"), None, "poll_state")
    if poll_state is not None:
        response["pollState"] = poll_state
    return response


def _node_ref(node: pb.NodeRef) -> dict[str, Any]:
    return {"id": node.id, "name": node.name, "type": node.type, "typeVersion": node.type_version or 1}


def _node_ref_to_proto(node: dict[str, Any]) -> pb.NodeRef:
    return pb.NodeRef(id=node.get("id", ""), name=node.get("name", ""), type=node.get("type", ""), type_version=int(node.get("typeVersion", 1)))


def _webhook_base(msg: Any) -> dict[str, Any]:
    request: dict[str, Any] = {
        "protocol": msg.protocol or PROTOCOL_VERSION,
        "workflowId": msg.workflow_id,
        "node": _node_ref(msg.node),
        "parameters": from_dynamic(_optional(msg, "parameters"), {}, "parameters"),
        "webhookUrl": msg.webhook_url,
        "staticData": from_dynamic(_optional(msg, "static_data"), {}, "static_data"),
    }
    credentials = from_dynamic(_optional(msg, "credentials"), None, "credentials")
    if credentials:
        request["credentials"] = credentials
    return request


def _logs_and_error_to_proto(response: dict[str, Any], msg: Any) -> None:
    for entry in response.get("logs") or []:
        msg.logs.add(level=entry["level"], message=entry["message"])
    error = response.get("error")
    if error:
        msg.error.message = error["message"]
        msg.error.description = error.get("description") or ""
        item_index = error.get("itemIndex")
        msg.error.item_index = -1 if item_index is None else int(item_index)
    if response.get("staticData") is not None:
        msg.static_data.CopyFrom(to_dynamic(response["staticData"]))


def _logs_and_error_from_proto(msg: Any, response: dict[str, Any]) -> None:
    if msg.logs:
        response["logs"] = [{"level": entry.level, "message": entry.message} for entry in msg.logs]
    if msg.HasField("error") and msg.error.message:
        error: dict[str, Any] = {"message": msg.error.message}
        if msg.error.description:
            error["description"] = msg.error.description
        response["error"] = error
    static_data = from_dynamic(_optional(msg, "static_data"), None, "static_data")
    if static_data is not None:
        response["staticData"] = static_data


def webhook_method_request_from_proto(msg: pb.WebhookMethodRequest) -> dict[str, Any]:
    return {**_webhook_base(msg), "method": msg.method}


def webhook_method_request_to_proto(request: dict[str, Any]) -> pb.WebhookMethodRequest:
    """Client-side helper (tests, tools): WebhookMethodRequest dict -> proto."""
    msg = pb.WebhookMethodRequest(
        protocol=request.get("protocol", PROTOCOL_VERSION),
        method=request.get("method", ""),
        workflow_id=request.get("workflowId", ""),
        node=_node_ref_to_proto(request.get("node") or {}),
        parameters=to_dynamic(request.get("parameters") or {}),
        webhook_url=request.get("webhookUrl", ""),
        static_data=to_dynamic(request.get("staticData") or {}),
    )
    if request.get("credentials"):
        msg.credentials.CopyFrom(to_dynamic(request["credentials"]))
    return msg


def webhook_method_response_to_proto(response: dict[str, Any]) -> pb.WebhookMethodResponse:
    msg = pb.WebhookMethodResponse(exists=response.get("exists") is True)
    _logs_and_error_to_proto(response, msg)
    return msg


def webhook_method_response_from_proto(msg: pb.WebhookMethodResponse) -> dict[str, Any]:
    """Client-side helper. proto3 cannot tell ``exists: false`` from absent: hosts treat anything but ``True`` as not registered."""
    response: dict[str, Any] = {"exists": True} if msg.exists else {}
    _logs_and_error_from_proto(msg, response)
    return response


def webhook_request_from_proto(msg: pb.ReceiveWebhookRequest) -> dict[str, Any]:
    incoming = msg.request
    return {
        **_webhook_base(msg),
        "request": {
            "method": incoming.method or "POST",
            "path": incoming.path,
            "headers": dict(incoming.headers),
            "query": dict(incoming.query),
            "body": bytes(incoming.body),
        },
    }


def webhook_request_to_proto(request: dict[str, Any]) -> pb.ReceiveWebhookRequest:
    """Client-side helper: WebhookRequest dict (``request.body`` base64 or bytes) -> proto."""
    incoming = request.get("request") or {}
    msg = pb.ReceiveWebhookRequest(
        protocol=request.get("protocol", PROTOCOL_VERSION),
        workflow_id=request.get("workflowId", ""),
        node=_node_ref_to_proto(request.get("node") or {}),
        parameters=to_dynamic(request.get("parameters") or {}),
        webhook_url=request.get("webhookUrl", ""),
        static_data=to_dynamic(request.get("staticData") or {}),
        request=pb.IncomingWebhookRequest(
            method=incoming.get("method", "POST"),
            path=incoming.get("path", ""),
            headers={str(k): str(v) for k, v in (incoming.get("headers") or {}).items()},
            query={str(k): str(v) for k, v in (incoming.get("query") or {}).items()},
            body=decode_body(incoming.get("body")),
        ),
    )
    if request.get("credentials"):
        msg.credentials.CopyFrom(to_dynamic(request["credentials"]))
    return msg


def webhook_response_to_proto(response: dict[str, Any]) -> pb.ReceiveWebhookResponse:
    msg = pb.ReceiveWebhookResponse(idempotency_key=response.get("idempotencyKey") or "")
    _items_to_branch(response.get("items") or [], msg)  # ReceiveWebhookResponse.items has Branch's shape
    reply = response.get("response")
    if reply:
        msg.response.status = int(reply.get("status") or 0)
        msg.response.headers.update({str(k): str(v) for k, v in (reply.get("headers") or {}).items()})
        msg.response.body = str(reply.get("body") or "").encode("utf-8")
    _logs_and_error_to_proto(response, msg)
    return msg


def webhook_response_from_proto(msg: pb.ReceiveWebhookResponse) -> dict[str, Any]:
    """Client-side helper: proto -> WebhookResponse dict."""
    response: dict[str, Any] = {}
    items = [_item_from_proto(item, f"items[{i}].json") for i, item in enumerate(msg.items)]
    if items:
        response["items"] = items
    if msg.HasField("response"):
        reply: dict[str, Any] = {}
        if msg.response.status:
            reply["status"] = msg.response.status
        if msg.response.headers:
            reply["headers"] = dict(msg.response.headers)
        if msg.response.body:
            reply["body"] = msg.response.body.decode("utf-8", errors="replace")
        response["response"] = reply
    if msg.idempotency_key:
        response["idempotencyKey"] = msg.idempotency_key
    _logs_and_error_from_proto(msg, response)
    return response


def manifest_to_proto(manifest: dict[str, Any]) -> pb.GetManifestResponse:
    info = manifest["plugin"]
    sdk = info.get("sdk") or {}
    return pb.GetManifestResponse(
        protocol=manifest["protocol"],
        plugin=pb.PluginInfo(
            id=info["id"],
            name=info["name"],
            version=info["version"],
            description=info.get("description", ""),
            language=info["language"],
            sdk_name=sdk.get("name", ""),
            sdk_version=sdk.get("version", ""),
            icon=info.get("icon", ""),
            author=info.get("author", ""),
            homepage=info.get("homepage", ""),
            color=info.get("color", ""),
        ),
        nodes=[to_dynamic(node) for node in manifest["nodes"]],
        credential_types=[to_dynamic(ctype) for ctype in manifest.get("credentialTypes") or []],
    )


def metadata_dict(context: grpc.ServicerContext) -> dict[str, str]:
    """The call's text metadata with lower-case keys (W3C trace context lives here)."""
    out: dict[str, str] = {}
    for key, value in context.invocation_metadata() or ():
        if isinstance(value, str) and not key.endswith("-bin"):
            out.setdefault(key.lower(), value)
    return out


def health_to_proto(health: dict[str, Any]) -> pb.HealthResponse:
    return pb.HealthResponse(
        status=health["status"], uptime_ms=health["uptimeMs"], plugin_id=health["pluginId"], version=health["version"]
    )


# ---------------------------------------------------------------------------
# PluginService
# ---------------------------------------------------------------------------


class PluginServicer(pb_grpc.PluginServiceServicer):
    def __init__(self, plugin: Plugin) -> None:
        self.plugin = plugin

    def _guard(self, context: grpc.ServicerContext, method: str, fn: Any) -> Any:
        try:
            return fn()
        except ProtocolError as exc:
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, str(exc))
        except (UnknownNodeError, UnknownMethodError, UnknownCredentialTypeError) as exc:
            context.abort(grpc.StatusCode.NOT_FOUND, str(exc.args[0] if exc.args else exc))
        except Exception as exc:  # noqa: BLE001 - load_options failures and server bugs
            log.exception("error handling %s", method)
            context.abort(grpc.StatusCode.INTERNAL, f"{type(exc).__name__}: {exc}")

    def GetManifest(self, request: pb.GetManifestRequest, context: grpc.ServicerContext) -> pb.GetManifestResponse:  # noqa: N802
        return self._guard(context, "GetManifest", lambda: manifest_to_proto(self.plugin.manifest()))

    def Execute(self, request: pb.ExecuteRequest, context: grpc.ServicerContext) -> pb.ExecuteResponse:  # noqa: N802
        return self._guard(
            context,
            "Execute",
            lambda: execute_response_to_proto(
                self.plugin.execute(execute_request_from_proto(request), metadata_dict(context))
            ),
        )

    def LoadOptions(self, request: pb.LoadOptionsRequest, context: grpc.ServicerContext) -> pb.LoadOptionsResponse:  # noqa: N802
        def run() -> pb.LoadOptionsResponse:
            parameters = from_dynamic(_optional(request, "parameters"), {}, "parameters")
            credentials = from_dynamic(_optional(request, "credentials"), None, "credentials")
            options = self.plugin.load_options(
                request.node_type, request.method, parameters, credentials, metadata_dict(context)
            )
            return pb.LoadOptionsResponse(options=to_dynamic(options))

        return self._guard(context, "LoadOptions", run)

    def TestCredentials(  # noqa: N802
        self, request: pb.TestCredentialsRequest, context: grpc.ServicerContext
    ) -> pb.TestCredentialsResponse:
        def run() -> pb.TestCredentialsResponse:
            data = from_dynamic(_optional(request, "data"), {}, "data")
            result = self.plugin.test_credentials(request.credential_type, data, metadata_dict(context))
            return pb.TestCredentialsResponse(ok=result["ok"], message=result.get("message", ""))

        return self._guard(context, "TestCredentials", run)

    def Health(self, request: pb.HealthRequest, context: grpc.ServicerContext) -> pb.HealthResponse:  # noqa: N802
        return self._guard(context, "Health", lambda: health_to_proto(self.plugin.health()))

    def WebhookMethod(  # noqa: N802
        self, request: pb.WebhookMethodRequest, context: grpc.ServicerContext
    ) -> pb.WebhookMethodResponse:
        return self._guard(
            context,
            "WebhookMethod",
            lambda: webhook_method_response_to_proto(
                self.plugin.webhook_method(webhook_method_request_from_proto(request), metadata_dict(context))
            ),
        )

    def ReceiveWebhook(  # noqa: N802
        self, request: pb.ReceiveWebhookRequest, context: grpc.ServicerContext
    ) -> pb.ReceiveWebhookResponse:
        return self._guard(
            context,
            "ReceiveWebhook",
            lambda: webhook_response_to_proto(self.plugin.receive_webhook(webhook_request_from_proto(request), metadata_dict(context))),
        )


def _address(host: str, port: int) -> str:
    return f"[{host}]:{port}" if ":" in host and not host.startswith("[") else f"{host}:{port}"


class GrpcPluginServer:
    """Serves ``PluginService`` for ``plugin`` on ``host:port`` (port 0 = OS-assigned)."""

    def __init__(self, plugin: Plugin, host: str = "127.0.0.1", port: int = 0, max_workers: int = 16) -> None:
        self.server = grpc.server(
            ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="landflow-grpc"),
            options=[
                ("grpc.max_receive_message_length", MAX_MESSAGE_BYTES),
                ("grpc.max_send_message_length", MAX_MESSAGE_BYTES),
                ("grpc.so_reuseport", 0),  # fail loudly if the port is taken
            ],
        )
        pb_grpc.add_PluginServiceServicer_to_server(PluginServicer(plugin), self.server)
        address = _address(host, port)
        try:
            bound = self.server.add_insecure_port(address)
        except RuntimeError as exc:
            raise OSError(f"cannot bind gRPC server to {address}: {exc}") from None
        if not bound:
            raise OSError(f"cannot bind gRPC server to {address} (port in use?)")
        self.host = host
        self.port: int = bound

    def start(self) -> None:
        self.server.start()

    def stop(self, grace: float = 1.0) -> None:
        self.server.stop(grace).wait(grace + 1)


# ---------------------------------------------------------------------------
# RegistryService client (used by the announcer for grpc:// registry URLs)
# ---------------------------------------------------------------------------

_UNREACHABLE_CODES = {grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED}


class GrpcRegistryClient:
    def __init__(self, target: str) -> None:
        self.target = target
        self.channel = grpc.insecure_channel(target)
        self.stub = pb_grpc.RegistryServiceStub(self.channel)

    def _call(self, fn: Any, request: Any, timeout: float) -> Any:
        metadata = [(key.lower(), value) for key, value in registry_secret_headers().items()]
        try:
            return fn(request, timeout=timeout, metadata=metadata or None)
        except grpc.RpcError as exc:
            code = exc.code() if hasattr(exc, "code") else None
            detail = exc.details() if hasattr(exc, "details") else str(exc)
            if code in _UNREACHABLE_CODES:
                raise RegistryUnreachable(f"{code.name if code else 'error'}: {detail}") from None
            raise RegistryRejected(f"{code.name if code else 'error'}: {detail}") from None

    def announce(self, payload: dict[str, Any], timeout: float) -> dict[str, Any]:
        response = self._call(
            self.stub.Announce,
            pb.AnnounceRequest(
                protocol=payload["protocol"],
                endpoint=payload["endpoint"],
                plugin_id=payload["pluginId"],
                version=payload["version"],
                ttl_seconds=int(payload.get("ttlSeconds") or 0),
            ),
            timeout,
        )
        return {
            "accepted": response.accepted,
            "heartbeatIntervalSeconds": response.heartbeat_interval_seconds,
            "message": response.message,
        }

    def withdraw(self, payload: dict[str, Any], timeout: float) -> None:
        self._call(
            self.stub.Withdraw,
            pb.WithdrawRequest(endpoint=payload["endpoint"], plugin_id=payload.get("pluginId", "")),
            timeout,
        )

    def close(self) -> None:
        self.channel.close()
