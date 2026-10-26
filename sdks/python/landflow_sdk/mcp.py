"""The MCP face (docs/transports.md "MCP: every plugin is also an MCP server", docs/protocol.md §15.2): every action
node's operations as MCP tools, with no code in the plugin.

- **Streamable HTTP at ``/mcp``** on the plugin's HTTP port, stateless: the official ``mcp`` package (2.3.0, the
  ``mcp`` extra) serves the 2026-07-28 revision (per-request ``_meta`` envelope, ``server/discover``) and 2025-era
  clients (``initialize``, stateless) from the same server. A ``Bearer $LANDFLOW_MCP_TOKEN`` is required unless the
  HTTP server listens on loopback only; a missing or wrong token is ``401`` with ``WWW-Authenticate: Bearer``. The
  ``mcp`` package's ASGI app is driven from the SDK's stdlib HTTP server through a small in-process bridge
  (``McpFace.handle_http``), so the face needs no second port and no ASGI server.
- **stdio** with ``--mcp-stdio`` or ``LANDFLOW_MCP=stdio``: the plugin speaks MCP on stdin/stdout and nothing else
  (logs go to stderr), so a desktop agent can start it directly.
- **Tools** are ``mcp_tools_from_manifest(manifest)`` (``mcp_tools.py``, the shared mapping); ``_meta`` (the node
  binding) is stripped from what agents see. A ``list_options`` tool exists when a tool has dynamic options and a
  credential is configured.
- **``tools/call``** -> ``tool_call_to_parameters()`` -> the dispatcher's execute with ``mode: "mcp"``, the call's
  ``CancelToken`` (cancelled when the client closes the request's stream) and the span attribute ``mcp.tool.name``.
  Credentials come from ``LANDFLOW_MCP_CREDENTIALS`` (a JSON file path or inline JSON, ``{"<credentialType>":
  {...fields}}`` by local type name); a tool whose node needs a credential that is not configured answers
  ``isError: true`` naming the missing type and its fields. The result is the node's first output as
  ``structuredContent: {items}`` plus a short text; a node error is ``isError: true`` with its message.

Without the ``mcp`` extra the face is off and ``serve()`` logs one line saying so.
"""

from __future__ import annotations

import asyncio
import contextvars
import hashlib
import hmac
import ipaddress
import json
import logging
import os
import re
import sys
import threading
import uuid
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence

from .binding import Binding, BindingContext, BindingInfo, HttpBinding
from .dispatcher import CallCancelledError, CancelToken, Dispatcher, OverloadedError
from .errors import ProtocolError, UnknownMethodError, UnknownNodeError
from .mcp_tools import MCP_TOOL_META_KEY, mcp_tools_from_manifest, tool_call_to_parameters, without_binding

log = logging.getLogger("landflow_sdk.mcp")

_disconnected: contextvars.ContextVar[threading.Event | None] = contextvars.ContextVar("landflow_mcp_disconnected", default=None)
"""Set per HTTP request by the bridge: the client closed the connection (cancels the call in flight)."""

MCP_ENV = "LANDFLOW_MCP"
MCP_TOKEN_ENV = "LANDFLOW_MCP_TOKEN"
MCP_CREDENTIALS_ENV = "LANDFLOW_MCP_CREDENTIALS"
MCP_STDIO_FLAG = "--mcp-stdio"
DEFAULT_MCP_PATH = "/mcp"
LIST_OPTIONS_TOOL = "list_options"
"""The read-only tool that resolves dynamic options (``load_options``) for another tool's parameter."""
INSTALL_HINT = "pip install 'landflow-sdk[mcp]'"


def mcp_available() -> bool:
    """Whether the ``mcp`` extra is installed."""
    try:
        import mcp.server.lowlevel.server  # noqa: F401
    except Exception:  # noqa: BLE001 - ImportError or a broken install
        return False
    return True


def mcp_mode(option: bool | Mapping[str, Any] | None, env: Mapping[str, str] | None = None, argv: Sequence[str] | None = None) -> str:
    """``"http"`` (at ``/mcp`` on the HTTP port, the default), ``"stdio"`` or ``"off"``: from ``--mcp-stdio`` in argv,
    ``LANDFLOW_MCP`` (``on``, ``off``, ``stdio``) and the ``serve()`` option (``False`` turns it off, ``{"stdio": True}``
    picks stdio), in that order of precedence."""
    env = os.environ if env is None else env
    argv = sys.argv[1:] if argv is None else argv
    if MCP_STDIO_FLAG in argv:
        return "stdio"
    value = (env.get(MCP_ENV) or "").strip().lower()
    if value == "stdio":
        return "stdio"
    if value in ("off", "false", "0"):
        return "off"
    if value and value not in ("on", "true", "1", "http"):
        raise ValueError(f'{MCP_ENV}="{env.get(MCP_ENV)}" is not one of on, off, stdio')
    if option is False or (isinstance(option, Mapping) and option.get("enabled") is False):
        return "off"
    if isinstance(option, Mapping) and option.get("stdio"):
        return "stdio"
    return "http"


def is_loopback_host(host: str | None) -> bool:
    """Is a listen host loopback only (so ``/mcp`` may run without a token)? ``""``/``0.0.0.0`` are not."""
    value = (host or "").strip().lower().strip("[]")
    if not value:
        return False
    if value in ("localhost", "::1", "::ffff:127.0.0.1") or re.match(r"^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$", value):
        return True
    try:
        return ipaddress.ip_address(value).is_loopback
    except ValueError:
        return False


def load_mcp_credentials(value: str | None = None) -> dict[str, dict[str, Any]]:
    """The credentials a standalone plugin uses for its tools, from ``LANDFLOW_MCP_CREDENTIALS``: a path to a JSON file or
    inline JSON, ``{"<credentialType>": {...fields}}`` keyed by the local type name (``plugin.type`` is reduced to
    ``type``). Empty when unset."""
    text = (os.environ.get(MCP_CREDENTIALS_ENV, "") if value is None else value).strip()
    if not text:
        return {}
    inline = text.startswith("{") or text.startswith("[")
    source = text if inline else Path(text).read_text(encoding="utf-8")
    try:
        parsed = json.loads(source)
    except json.JSONDecodeError as exc:
        raise ValueError(f"{MCP_CREDENTIALS_ENV} is not valid JSON{'' if inline else f' (file {text})'}: {exc}") from None
    if not isinstance(parsed, dict):
        raise ValueError(f"{MCP_CREDENTIALS_ENV} must be a JSON object keyed by credential type")
    out: dict[str, dict[str, Any]] = {}
    for typ, fields in parsed.items():
        if not isinstance(fields, dict):
            raise ValueError(f'{MCP_CREDENTIALS_ENV}: "{typ}" must be an object of fields')
        out[typ.rsplit(".", 1)[-1]] = fields
    return out


def bearer_token_matches(header: str | None, token: str) -> bool:
    """Constant-time check of ``Authorization: Bearer <token>``."""
    match = re.match(r"^Bearer\s+(.+)$", (header or "").strip(), re.IGNORECASE)
    if not match or not token:
        return False
    return hmac.compare_digest(hashlib.sha256(match.group(1).encode()).digest(), hashlib.sha256(token.encode()).digest())


def _text_result(text: str, *, is_error: bool = False, structured: Any = None) -> Any:
    from mcp_types import CallToolResult, TextContent

    return CallToolResult(content=[TextContent(type="text", text=text)], is_error=is_error, structured_content=structured)


def _invalid_params(message: str) -> Exception:
    from mcp.shared.exceptions import MCPError
    from mcp_types import INVALID_PARAMS

    return MCPError(code=INVALID_PARAMS, message=message)


class McpFace:
    """The MCP face over a dispatcher: the tools of the served manifest, the ``mcp`` server, the HTTP bridge (token
    checked here) and the stdio runner. Needs the ``mcp`` extra (``McpFace()`` raises ``ImportError`` without it)."""

    def __init__(
        self,
        dispatcher: Dispatcher,
        manifest: dict[str, Any] | None = None,
        *,
        credentials: dict[str, dict[str, Any]] | None = None,
        token: str | None = None,
        loopback: bool = False,
        realm: str = "landflow-plugin",
        logger: logging.Logger | None = None,
    ) -> None:
        if not mcp_available():
            raise ImportError(f"the MCP face needs the mcp package: {INSTALL_HINT}")
        self.dispatcher = dispatcher
        self.manifest = manifest if manifest is not None else dispatcher.manifest()
        self.credentials = load_mcp_credentials() if credentials is None else credentials
        self.token = token
        self.loopback = loopback
        self.realm = realm
        self.log = logger or log
        self._nodes = {n["name"]: n for n in self.manifest.get("nodes") or []}
        self.definitions = mcp_tools_from_manifest(self.manifest)
        self._runtimes = {d["name"]: d for d in self.definitions}
        self.dynamic = any(d["_meta"][MCP_TOOL_META_KEY]["dynamicOptions"] for d in self.definitions) and bool(self.credentials)
        self.tools: list[dict[str, Any]] = [without_binding(d) for d in self.definitions]
        if self.dynamic and LIST_OPTIONS_TOOL not in self._runtimes:
            self.tools.append(self._list_options_tool())
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._manager: Any = None
        self._ready = threading.Event()
        self._stopping: asyncio.Event | None = None

    # ------------------------------------------------------------------ tools

    def _list_options_tool(self) -> dict[str, Any]:
        names = [d["name"] for d in self.definitions if d["_meta"][MCP_TOOL_META_KEY]["dynamicOptions"]]
        return {
            "name": LIST_OPTIONS_TOOL,
            "title": "List options",
            "description": "The values a tool argument with a dynamic list accepts (resolved with the configured credential): pass the tool name, the parameter and, when the list depends on other arguments, those arguments.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tool": {"type": "string", "description": "The tool whose argument has a dynamic list.", "enum": names},
                    "parameter": {"type": "string", "description": "The argument (a path like `channel` or `options/labels`)."},
                    "arguments": {"type": "object", "description": "Other arguments the list depends on."},
                },
                "required": ["tool", "parameter"],
            },
            "outputSchema": {"type": "object", "properties": {"options": {"type": "array", "items": {"type": "object", "properties": {"name": {"type": "string"}, "value": {}}, "required": ["name", "value"]}}}, "required": ["options"]},
            "annotations": {"title": "List options", "readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": True},
        }

    def _describe_credential(self, typ: str) -> str:
        for descriptor in self.manifest.get("credentialTypes") or []:
            if descriptor.get("name") == typ:
                fields = [p["name"] for p in descriptor.get("properties") or []]
                return f"{typ} (fields: {', '.join(fields)})" if fields else typ
        return typ

    def _bind_credentials(self, definition: dict[str, Any]) -> tuple[dict[str, Any] | None, dict[str, Any], str | None]:
        """The configured credentials a node call gets and the selector parameters that pick them, or the message naming
        the missing types when none is configured and one is required."""
        binding = definition["_meta"][MCP_TOOL_META_KEY]
        node = self._nodes.get(binding["nodeName"]) or {}
        wanted = node.get("credentials") or []
        selectors: dict[str, Any] = {}
        if not wanted:
            return None, selectors, None
        credentials: dict[str, Any] = {}
        for credential in wanted:
            value = self.credentials.get(credential["name"])
            if value is None:
                continue
            credentials[credential["name"]] = value
            for selector in binding["credentialSelectors"]:
                if credential["name"] in selector["byCredential"] and selector["parameter"] not in selectors:
                    selectors[selector["parameter"]] = selector["byCredential"][credential["name"]]
        if not credentials and any(c.get("required") for c in wanted):
            missing = " or ".join(self._describe_credential(c["name"]) for c in wanted)
            return None, selectors, (
                f"This tool needs a credential that is not configured: {missing}. "
                f'Set {MCP_CREDENTIALS_ENV} to a JSON file or inline JSON {{ "<credentialType>": {{ …fields }} }}.'
            )
        return (credentials or None), selectors, None

    # ------------------------------------------------------------------ calls

    def _call_options(self, ctx: Any, cancel: CancelToken, attributes: dict[str, Any]) -> tuple[Any, dict[str, Any]]:
        """The trace headers (``_meta.traceparent``, else the HTTP request's headers) and the dispatcher kwargs."""
        headers: Any = {}
        meta = getattr(ctx, "meta", None) or {}
        traceparent = meta.get("traceparent") if isinstance(meta, Mapping) else None
        if isinstance(traceparent, str):
            headers = {"traceparent": traceparent, "tracestate": meta.get("tracestate") or ""}
        else:
            request = getattr(ctx, "request", None)
            if request is not None and getattr(request, "headers", None) is not None:
                headers = request.headers
        return headers, {"cancel": cancel, "transport": "mcp", "span_attributes": attributes}

    async def _run_blocking(self, fn: Callable[[], Any], cancel: CancelToken) -> Any:
        """Run a dispatcher call in a worker thread; the client closing the stream (the bridge's disconnect event, or a
        cancelled task) cancels the call."""
        import anyio

        disconnected = _disconnected.get()

        async def watch() -> None:
            while disconnected is not None and not disconnected.is_set():
                await asyncio.sleep(0.05)
            cancel.cancel("client closed the stream")

        watcher = asyncio.ensure_future(watch()) if disconnected is not None else None
        try:
            return await anyio.to_thread.run_sync(fn, abandon_on_cancel=True)
        except anyio.get_cancelled_exc_class():
            cancel.cancel("client closed the stream")
            raise
        except BaseException:
            cancel.cancel("call failed")
            raise
        finally:
            if watcher is not None:
                watcher.cancel()

    async def _on_list_tools(self, ctx: Any, params: Any) -> Any:
        from mcp_types import ListToolsResult, Tool

        return ListToolsResult(tools=[Tool.model_validate(t) for t in self.tools])

    async def _on_call_tool(self, ctx: Any, params: Any) -> Any:
        name = params.name
        args = params.arguments
        if args is not None and not isinstance(args, dict):
            raise _invalid_params('"arguments" must be an object')
        if name == LIST_OPTIONS_TOOL and self.dynamic:
            return await self._list_options(ctx, args or {})
        definition = self._runtimes.get(name)
        if definition is None:
            raise _invalid_params(f'Unknown tool "{name}"')
        mapping = tool_call_to_parameters(definition, args)
        credentials, selectors, missing = self._bind_credentials(definition)
        if missing:
            return _text_result(missing, is_error=True)
        parameters = {**selectors, **mapping["parameters"]}
        binding = definition["_meta"][MCP_TOOL_META_KEY]
        node = self._nodes.get(binding["nodeName"]) or {}
        request: dict[str, Any] = {
            "protocol": self.manifest.get("protocol") or "landflow.plugin/v1",
            "executionId": f"mcp_{uuid.uuid4()}",
            "mode": "mcp",
            "node": {"id": f"mcp-{definition['name']}", "name": node.get("displayName") or definition["title"], "type": mapping["nodeType"], "typeVersion": mapping["typeVersion"]},
            "parameters": parameters,
            "itemParameters": [parameters],
            "inputs": [[{"json": args or {}}]],
        }
        if credentials:
            request["credentials"] = credentials
        cancel = CancelToken()
        headers, options = self._call_options(ctx, cancel, {"mcp.tool.name": definition["name"]})
        try:
            response = await self._run_blocking(lambda: self.dispatcher.execute(request, headers, **options), cancel)
        except UnknownNodeError as exc:
            raise _invalid_params(str(exc)) from None
        except ProtocolError as exc:
            raise _invalid_params(str(exc)) from None
        except OverloadedError as exc:
            return _text_result(f"{exc}; try again shortly", is_error=True)
        return tool_result_from_response(response, mapping["ignored"])

    async def _list_options(self, ctx: Any, args: dict[str, Any]) -> Any:
        tool_name, parameter = args.get("tool"), args.get("parameter")
        if not isinstance(tool_name, str) or not isinstance(parameter, str):
            raise _invalid_params(f'{LIST_OPTIONS_TOOL} needs "tool" and "parameter"')
        definition = self._runtimes.get(tool_name)
        if definition is None:
            raise _invalid_params(f'Unknown tool "{tool_name}"')
        binding = definition["_meta"][MCP_TOOL_META_KEY]
        option = next((d for d in binding["dynamicOptions"] if d["parameter"] == parameter), None)
        if option is None:
            raise _invalid_params(f'"{parameter}" of {tool_name} has no dynamic options')
        nested = args.get("arguments") if isinstance(args.get("arguments"), dict) else None
        mapping = tool_call_to_parameters(definition, nested)
        credentials, selectors, missing = self._bind_credentials(definition)
        if missing:
            return _text_result(missing, is_error=True)
        request: dict[str, Any] = {"nodeType": binding["nodeType"], "method": option["method"], "parameters": {**selectors, **mapping["parameters"]}}
        if credentials:
            request["credentials"] = credentials
        cancel = CancelToken()
        headers, options = self._call_options(ctx, cancel, {"mcp.tool.name": LIST_OPTIONS_TOOL, "landflow.load_options.tool": tool_name})
        try:
            response = await self._run_blocking(lambda: self.dispatcher.load_options_request(request, headers, **options), cancel)
        except (UnknownNodeError, UnknownMethodError, ProtocolError) as exc:
            raise _invalid_params(str(exc)) from None
        except (OverloadedError, CallCancelledError) as exc:
            return _text_result(str(exc), is_error=True)
        except Exception as exc:  # noqa: BLE001 - the loader's own failure is a tool error
            return _text_result(f"{type(exc).__name__}: {exc}", is_error=True)
        found = response.get("options") or []
        return _text_result(f"{len(found)} option{'' if len(found) == 1 else 's'}", structured={"options": found})

    # ------------------------------------------------------------------ server

    def build_server(self) -> Any:
        """A fresh ``mcp`` lowlevel server: ``tools/list`` and ``tools/call`` from the mapping and the dispatcher."""
        from mcp.server.lowlevel.server import Server

        plugin = self.manifest.get("plugin") or {}
        return Server(
            plugin.get("id") or "landflow-plugin",
            version=plugin.get("version") or "",
            title=plugin.get("name"),
            instructions=plugin.get("description") or None,
            on_list_tools=self._on_list_tools,
            on_call_tool=self._on_call_tool,
        )

    # ------------------------------------------------------------------ HTTP bridge

    def start(self) -> None:
        """Start the event loop thread that hosts the ``mcp`` session manager (stateless, JSON responses)."""
        if self._thread is not None:
            return
        self._ready.clear()
        self._thread = threading.Thread(target=self._run_loop, name="landflow-mcp", daemon=True)
        self._thread.start()
        if not self._ready.wait(10):
            raise RuntimeError("the MCP face did not start")

    def _run_loop(self) -> None:
        from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
        from mcp.server.transport_security import TransportSecuritySettings

        async def main() -> None:
            self._loop = asyncio.get_running_loop()
            self._stopping = asyncio.Event()
            self._manager = StreamableHTTPSessionManager(
                app=self.build_server(), json_response=True, stateless=True,
                security_settings=TransportSecuritySettings(enable_dns_rebinding_protection=False),
                max_request_body_size=64 * 1024 * 1024,
            )
            async with self._manager.run():
                self._ready.set()
                await self._stopping.wait()

        try:
            asyncio.run(main())
        except Exception:  # noqa: BLE001
            self.log.exception("MCP face stopped")
        finally:
            self._ready.set()

    def close(self) -> None:
        loop, stopping = self._loop, self._stopping
        if loop is not None and stopping is not None and loop.is_running():
            loop.call_soon_threadsafe(stopping.set)
        if self._thread is not None:
            self._thread.join(timeout=5)
        self._thread, self._loop, self._manager = None, None, None

    def handle_http(self, handler: Any, body: bytes, *, disconnected: threading.Event | None = None) -> None:
        """Serve one ``/mcp`` request from the stdlib HTTP handler: the token check, then the ASGI app in the loop thread.
        ``disconnected`` (set by the server when the client went away) ends the ASGI ``receive`` with ``http.disconnect``,
        which cancels the call."""
        if not self.loopback:
            if not self.token:
                handler._send(503, {"error": "MCP is not configured with a token"})
                return
            if not bearer_token_matches(handler.headers.get("Authorization"), self.token):
                handler._send(401, {"error": "unauthorized"}, headers={"WWW-Authenticate": f'Bearer realm="{self.realm}"'})
                return
        loop, manager = self._loop, self._manager
        if loop is None or manager is None:
            handler._send(503, {"error": "MCP face not running"})
            return
        path = handler.path.split("?", 1)[0]
        query = handler.path.split("?", 1)[1] if "?" in handler.path else ""
        scope = {
            "type": "http", "asgi": {"version": "3.0", "spec_version": "2.3"}, "http_version": "1.1",
            "method": handler.command, "scheme": "http", "path": path, "raw_path": path.encode(), "query_string": query.encode(),
            "root_path": "", "headers": [(k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in handler.headers.items()],
            "client": tuple(handler.client_address[:2]) if handler.client_address else None, "server": tuple(handler.server.server_address[:2]),
        }
        future = asyncio.run_coroutine_threadsafe(self._bridge(scope, body, disconnected), loop)
        status, headers, out = future.result()
        handler._send_raw(status, out, headers.pop("content-type", "application/json"), headers=headers)

    async def _bridge(self, scope: dict[str, Any], body: bytes, disconnected: threading.Event | None) -> tuple[int, dict[str, str], bytes]:
        assert self._manager is not None
        sent_body = False
        status = 500
        headers: dict[str, str] = {}
        chunks: list[bytes] = []
        done = asyncio.Event()

        async def receive() -> dict[str, Any]:
            nonlocal sent_body
            if not sent_body:
                sent_body = True
                return {"type": "http.request", "body": body, "more_body": False}
            while not (disconnected is not None and disconnected.is_set()) and not done.is_set():
                await asyncio.sleep(0.05)
            return {"type": "http.disconnect"}

        async def send(message: dict[str, Any]) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
                for k, v in message.get("headers") or []:
                    headers[k.decode("latin-1").lower()] = v.decode("latin-1")
            elif message["type"] == "http.response.body":
                chunks.append(message.get("body") or b"")
                if not message.get("more_body", False):
                    done.set()

        token = _disconnected.set(disconnected)
        try:
            await self._manager.handle_request(scope, receive, send)
        finally:
            _disconnected.reset(token)
            done.set()
        headers.pop("content-length", None)
        headers.pop("transfer-encoding", None)
        return status, headers, b"".join(chunks)

    # ------------------------------------------------------------------ stdio

    def serve_stdio(self) -> None:
        """Speak MCP on stdin/stdout until the client goes away (both eras; no token). Blocks. Logs must go to stderr."""
        from mcp.server.stdio import stdio_server

        server = self.build_server()

        async def main() -> None:
            async with stdio_server() as (read_stream, write_stream):
                await server.run(read_stream, write_stream, server.create_initialization_options())

        asyncio.run(main())


def tool_result_from_response(response: dict[str, Any], ignored: Sequence[str] = ()) -> Any:
    """The node's first output as ``structuredContent: {items}`` plus a short text, or ``isError`` with the node's message."""
    error = response.get("error")
    if error:
        message = error.get("message") or "node failed"
        description = error.get("description")
        return _text_result(f"{message}\n{description}" if description else message, is_error=True)
    outputs = response.get("outputs") or []
    items = [item.get("json") or {} for item in (outputs[0] if outputs else [])]
    # Arguments the tool's schema does not declare are not node parameters; they only reach the node as fields of the input item.
    note = f" (arguments outside this tool's schema, passed only as input item fields: {', '.join(ignored)})" if ignored else ""
    summary = json.dumps(items[0], separators=(",", ":")) if len(items) == 1 else f"{len(items)} item{'' if len(items) == 1 else 's'}"
    return _text_result(summary + note, structured={"items": items})


class McpBinding(Binding):
    """Mounts the MCP face at ``/mcp`` on the HTTP binding (``PluginServer`` builds one unless the face is off). A
    missing token on a non-loopback host is not fatal: the face stays off, an error line says so, the plugin keeps
    serving its other faces."""

    kind = "mcp"

    def __init__(self, http: HttpBinding | None, options: Mapping[str, Any] | None = None) -> None:
        self.http = http
        self.options = dict(options or {})
        self.face: McpFace | None = None
        self.path = self.options.get("path") or DEFAULT_MCP_PATH

    def can_start(self, bind_host: str, logger: logging.Logger) -> bool:
        """Whether the face will start (``PluginServer`` lists it as a transport only then); logs the reason when not:
        no HTTP binding, no ``mcp`` package, or no token off loopback."""
        if self.http is None:
            logger.error("MCP face not started: it needs the HTTP binding (set an HTTP port, or use %s); LANDFLOW_MCP=off silences this", MCP_STDIO_FLAG)
            return False
        if not mcp_available():
            logger.error("MCP face not started: the mcp package is not installed (%s); LANDFLOW_MCP=off silences this", INSTALL_HINT)
            return False
        token = self.options.get("token") or os.environ.get(MCP_TOKEN_ENV) or ""
        if not token and not is_loopback_host(bind_host):
            logger.error(
                "MCP face not started: %s is not set and the HTTP server listens on %s (not loopback only); set a token, LANDFLOW_BIND_HOST=127.0.0.1, or LANDFLOW_MCP=off",
                MCP_TOKEN_ENV, bind_host or "all interfaces",
            )
            return False
        return True

    def start(self, context: BindingContext) -> BindingInfo:
        if self.http is None or self.http.server is None or not mcp_available():
            return BindingInfo()
        token = self.options.get("token") or os.environ.get(MCP_TOKEN_ENV) or ""
        loopback = is_loopback_host(context.bind_host)
        if not token and not loopback:
            return BindingInfo()
        self.face = McpFace(context.dispatcher, context.manifest, credentials=self.options.get("credentials"), token=token or None, loopback=loopback, logger=context.logger)
        self.face.start()
        self.http.server.mount(self.path, self.face.handle_http)
        context.logger.info("MCP face at %s (%s)", self.path, "loopback only, no token" if loopback and not token else "Bearer token required")
        return BindingInfo()

    def stop(self) -> None:
        if self.face is not None:
            if self.http is not None and self.http.server is not None:
                self.http.server.unmount(self.path)
            self.face.close()
            self.face = None


def serve_mcp_stdio(plugin: Any, *, max_concurrency: int | None = None, max_queue: int | None = None, options: Mapping[str, Any] | None = None) -> None:
    """``serve()`` in stdio mode: the plugin speaks MCP on stdin/stdout and nothing else; logs go to stderr."""
    from .logs import configure_logging

    configure_logging(plugin, stream=sys.stderr, force=True)
    if not mcp_available():
        raise RuntimeError(f"{MCP_STDIO_FLAG} needs the mcp package: {INSTALL_HINT}")
    options = dict(options or {})
    plugin.transports = ["mcp"]
    plugin.max_concurrency = max_concurrency
    dispatcher = Dispatcher(plugin, max_concurrency, max_queue)
    plugin.dispatcher = dispatcher
    face = McpFace(dispatcher, plugin.manifest(), credentials=options.get("credentials"), loopback=True)
    log.info("%s %s speaking MCP on stdio (%d tool(s)); no other face, no announce", plugin.id, plugin.version, len(face.tools))
    try:
        face.serve_stdio()
    finally:
        dispatcher.drain(10)
        plugin.telemetry.flush()
        log.info("%s stopped", plugin.id)
