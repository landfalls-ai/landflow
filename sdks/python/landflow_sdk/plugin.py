"""``Plugin``: the manifest plus the transport-agnostic request dispatcher.

Both the HTTP and the gRPC server convert their wire format into the same
plain dicts (the JSON shapes in docs/protocol.md) and call
``Plugin.execute`` / ``Plugin.load_options`` / ``Plugin.test_credentials`` /
``Plugin.health``, so node code never knows which transport delivered the
request. They also pass the request's headers (or gRPC metadata) so the
server span continues the caller's trace (docs/observability.md).
"""

from __future__ import annotations

import asyncio
import copy
import dataclasses
import inspect
import json
import logging
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Callable, Iterable

from ._version import __version__
from .context import CredentialTestContext, ExecuteContext, LoadOptionsContext
from .credentials import CredentialType, normalize_test_result, secret_values
from .errors import (
    DescriptorError,
    NodeOperationError,
    ProtocolError,
    UnknownCredentialTypeError,
    UnknownMethodError,
    UnknownNodeError,
)
from .icons import resolve_icon
from .node import Node
from .protocol import (
    CONNECTION_TYPES,
    HTTP_PATHS,
    NODE_KINDS,
    PROPERTY_TYPES,
    PROTOCOL_VERSION,
    TRIGGER_SOURCES,
    to_jsonable,
)
from .redact import redact_text, secret_scope
from .telemetry import Telemetry

SDK_NAME = "landflow-sdk-python"
LANGUAGE = "python"

log = logging.getLogger("landflow_sdk")

_PLUGIN_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
_NODE_NAME_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9_-]*$")
_HEX_COLOR_RE = re.compile(r"^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")
_ITEM_KEYS = frozenset({"json", "pairedItem", "binary"})


class Plugin:
    """A set of nodes served under one plugin id.

    >>> plugin = Plugin("py-insights", "Insights", "0.1.0", nodes=[Stats(), Sentiment()])

    ``nodes`` may contain ``Node`` instances or ``Node`` subclasses (instantiated
    with no arguments). Descriptors are validated here, at startup.

    ``icon`` (here and in node descriptors) may be ``"file:<path>"`` to an SVG/PNG
    of at most 64 KB; it is inlined as a ``data:`` URL. Relative paths resolve
    against the directory of the module that declares them (the node's module,
    or the module calling ``Plugin``), or against ``icon_dir`` when given.
    ``color`` is the plugin's brand colour (hex).

    ``credential_types`` lists the ``CredentialType``s (or descriptor dicts)
    the nodes reference in their ``credentials``. ``telemetry`` overrides the
    ``Telemetry`` built from the environment (tests, embedding).
    """

    def __init__(
        self,
        id: str,
        name: str,
        version: str,
        nodes: Iterable[Node | type[Node]] = (),
        *,
        description: str | None = None,
        icon: str | None = None,
        color: str | None = None,
        author: str | None = None,
        homepage: str | None = None,
        icon_dir: str | os.PathLike[str] | None = None,
        credential_types: Iterable[CredentialType | dict[str, Any]] = (),
        telemetry: Telemetry | None = None,
    ) -> None:
        if not isinstance(id, str) or not _PLUGIN_ID_RE.match(id):
            raise DescriptorError(f"plugin id {id!r} must be lowercase kebab-case (e.g. 'py-insights')")
        if not isinstance(name, str) or not name:
            raise DescriptorError("plugin name is required")
        if not isinstance(version, str) or not version:
            raise DescriptorError("plugin version is required (a semver string)")
        if color is not None and (not isinstance(color, str) or not _HEX_COLOR_RE.match(color)):
            raise DescriptorError(f"plugin color {color!r} must be a hex colour like '#f59e0b'")
        self.id = id
        self.name = name
        self.version = version
        self.description = description
        caller = sys._getframe(1).f_globals.get("__name__")
        caller_dir = icon_dir if icon_dir is not None else _module_dir(caller)
        try:
            self.icon = resolve_icon(icon, caller_dir)
        except DescriptorError as exc:
            raise DescriptorError(f"plugin icon: {exc}") from None
        self.color = color
        self.author = author
        self.homepage = homepage
        self.started_at = time.monotonic()

        self._credential_types: dict[str, CredentialType] = {}
        for entry in credential_types:
            ctype = _validate_credential_type(entry, caller_dir)
            if ctype.name in self._credential_types:
                raise DescriptorError(f"duplicate credential type {ctype.name!r}")
            self._credential_types[ctype.name] = ctype

        self._nodes: dict[str, tuple[Node, dict[str, Any]]] = {}
        for entry in nodes:
            node = entry() if isinstance(entry, type) else entry
            if not isinstance(node, Node):
                raise DescriptorError(f"{entry!r} is not a landflow_sdk.Node")
            descriptor = _validate_descriptor(node, set(self._credential_types))
            if "icon" in descriptor:
                base = icon_dir if icon_dir is not None else _module_dir(type(node).__module__)
                try:
                    descriptor["icon"] = resolve_icon(descriptor["icon"], base)
                except DescriptorError as exc:
                    raise DescriptorError(f"node {descriptor['name']!r}: {exc}") from None
            if descriptor["name"] in self._nodes:
                raise DescriptorError(f"duplicate node name {descriptor['name']!r}")
            self._nodes[descriptor["name"]] = (node, descriptor)
        if not self._nodes:
            raise DescriptorError("a plugin needs at least one node")
        self._manifest = self._build_manifest()
        self.telemetry = telemetry if telemetry is not None else Telemetry(self.id, self.version)

    # ------------------------------------------------------------------ meta

    @property
    def node_names(self) -> list[str]:
        return list(self._nodes)

    @property
    def credential_types(self) -> list[CredentialType]:
        return list(self._credential_types.values())

    def _build_manifest(self) -> dict[str, Any]:
        info: dict[str, Any] = {
            "id": self.id,
            "name": self.name,
            "version": self.version,
            "language": LANGUAGE,
            "sdk": {"name": SDK_NAME, "version": __version__},
        }
        for key in ("description", "icon", "color", "author", "homepage"):
            value = getattr(self, key)
            if value:
                info[key] = value
        manifest: dict[str, Any] = {
            "protocol": PROTOCOL_VERSION,
            "plugin": info,
            "nodes": [descriptor for _, descriptor in self._nodes.values()],
        }
        if self._credential_types:
            manifest["credentialTypes"] = [ctype.descriptor() for ctype in self._credential_types.values()]
        return manifest

    def manifest(self) -> dict[str, Any]:
        """``PluginManifest``."""
        return copy.deepcopy(self._manifest)

    def well_known(self) -> dict[str, Any]:
        """``WellKnownDocument`` (the cheap discovery probe)."""
        return {
            "protocol": PROTOCOL_VERSION,
            "plugin": {"id": self.id, "name": self.name, "version": self.version, "language": LANGUAGE},
            "endpoints": {
                "manifest": HTTP_PATHS["manifest"],
                "execute": HTTP_PATHS["execute"],
                "loadOptions": HTTP_PATHS["loadOptions"],
                "health": HTTP_PATHS["health"],
                "testCredentials": HTTP_PATHS["testCredentials"],
            },
        }

    def health(self) -> dict[str, Any]:
        """``HealthResponse``."""
        return {
            "status": "ok",
            "uptimeMs": int((time.monotonic() - self.started_at) * 1000),
            "pluginId": self.id,
            "version": self.version,
        }

    # -------------------------------------------------------------- dispatch

    def resolve_node(self, node_type: Any) -> tuple[Node, dict[str, Any]]:
        """Accepts ``"<pluginId>.<name>"`` (ExecuteRequest) or a local ``"<name>"`` (LoadOptions)."""
        if not isinstance(node_type, str) or not node_type:
            raise ProtocolError("node type is required")
        local = node_type
        prefix = self.id + "."
        if node_type.startswith(prefix):
            local = node_type[len(prefix):]
        elif "." in node_type:
            raise UnknownNodeError(f"node type {node_type!r} does not belong to plugin {self.id!r}")
        entry = self._nodes.get(local)
        if entry is None:
            raise UnknownNodeError(f"unknown node type {node_type!r} (plugin {self.id!r} has: {', '.join(self._nodes)})")
        return entry

    def resolve_credential_type(self, name: Any) -> CredentialType:
        """Accepts a local (``"githubApi"``) or qualified (``"<pluginId>.githubApi"``) credential type name."""
        if not isinstance(name, str) or not name:
            raise ProtocolError("credentialType is required")
        local = name[len(self.id) + 1:] if name.startswith(self.id + ".") else name
        ctype = self._credential_types.get(local)
        if ctype is None:
            declared = ", ".join(self._credential_types) or "none"
            raise UnknownCredentialTypeError(f"unknown credential type {name!r} (plugin {self.id!r} declares: {declared})")
        return ctype

    def _with_defaults(self, credentials: dict[str, Any]) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for name, data in credentials.items():
            ctype = self._credential_types.get(name)
            out[name] = ctype.with_defaults(data) if ctype is not None else data
        return out

    def execute(self, request: Any, headers: Any = None) -> dict[str, Any]:
        """Run an ``ExecuteRequest`` dict and return an ``ExecuteResponse`` dict.

        ``headers``: the HTTP headers or gRPC metadata of the call (W3C trace
        context). Raises ``ProtocolError`` for malformed requests and
        ``UnknownNodeError`` for unknown node types; node failures are reported
        in ``error``.
        """
        request = _validate_execute_request(request)
        node, descriptor = self.resolve_node(request["node"]["type"])
        node_type = f"{self.id}.{descriptor['name']}"
        raw_credentials = request.get("credentials") or {}
        items_in = sum(len(branch) for branch in request["inputs"])
        telemetry = self.telemetry
        started = time.perf_counter()
        with secret_scope(secret_values(raw_credentials, self._credential_types)):
            span = telemetry.start_span(
                f"plugin.execute {node_type}",
                kind="server",
                parent=telemetry.extract(headers),
                attributes={
                    "landflow.plugin.id": self.id,
                    "landflow.node.type": node_type,
                    "landflow.node.name": request["node"].get("name") or None,
                    "landflow.workflow.id": request.get("workflowId") or None,
                    "landflow.execution.id": request.get("executionId") or None,
                    "landflow.execution.mode": request["mode"],
                    "landflow.items.in": items_in,
                },
            )
            try:
                with telemetry.use_span(span):
                    ctx = ExecuteContext(
                        request,
                        descriptor,
                        plugin_id=self.id,
                        telemetry=telemetry,
                        credentials=self._with_defaults(raw_credentials),
                        span=span,
                    )
                    response = self._run_node(node, ctx, descriptor, span)
            finally:
                span.end()
        items_out = sum(len(branch) for branch in response["outputs"])
        attributes = {"landflow.node.type": node_type, "landflow.node.status": "error" if "error" in response else "success"}
        telemetry.executions.add(1, attributes)
        telemetry.execute_duration.record((time.perf_counter() - started) * 1000, attributes)
        telemetry.items.add(items_in, {"landflow.node.type": node_type, "landflow.direction": "in"})
        telemetry.items.add(items_out, {"landflow.node.type": node_type, "landflow.direction": "out"})
        return response

    def _run_node(self, node: Node, ctx: ExecuteContext, descriptor: dict[str, Any], span: Any) -> dict[str, Any]:
        input_count = len(ctx.get_input_data(0))
        try:
            result = node.execute(ctx)
            if inspect.isawaitable(result):
                result = asyncio.run(_await(result))
            outputs = _normalize_outputs(result, descriptor, input_count)
        except NodeOperationError as exc:
            span.record_exception(exc)
            error = exc.to_payload()
        except Exception as exc:  # noqa: BLE001 - every node bug becomes a reported error
            log.warning(
                "node %s raised %s: %s", descriptor["name"], type(exc).__name__, redact_text(str(exc)),
                exc_info=log.isEnabledFor(logging.DEBUG),
            )
            span.record_exception(exc)
            error = {"message": str(exc) or type(exc).__name__}
        else:
            response: dict[str, Any] = {"outputs": outputs, "logs": ctx.logger.entries}
            poll_state = ctx._response_poll_state()
            if poll_state is not None:
                response["pollState"] = poll_state
            span.set_attribute("landflow.items.out", sum(len(branch) for branch in outputs))
            return response
        error = {k: redact_text(v) if isinstance(v, str) else v for k, v in error.items()}
        span.set_status("error", error["message"])
        span.set_attribute("landflow.items.out", 0)
        return {"outputs": [], "logs": ctx.logger.entries, "error": error}

    def load_options(
        self,
        node_type: Any,
        method: Any,
        parameters: Any = None,
        credentials: Any = None,
        headers: Any = None,
    ) -> list[dict[str, Any]]:
        """Resolve a ``loadOptionsMethod``; returns ``[{name, value, description?}]``."""
        node, descriptor = self.resolve_node(node_type)
        if not isinstance(method, str) or not method:
            raise ProtocolError("method is required")
        if parameters is None:
            parameters = {}
        if not isinstance(parameters, dict):
            raise ProtocolError("parameters must be an object")
        credentials = _validate_credentials(credentials)
        qualified = f"{self.id}.{descriptor['name']}"
        telemetry = self.telemetry
        outcome = "ok"
        with secret_scope(secret_values(credentials, self._credential_types)):
            span = telemetry.start_span(
                f"plugin.load_options {method}",
                kind="server",
                parent=telemetry.extract(headers),
                attributes={"landflow.plugin.id": self.id, "landflow.node.type": qualified, "landflow.load_options.method": method},
            )
            try:
                with telemetry.use_span(span):
                    ctx = LoadOptionsContext(
                        qualified,
                        method,
                        parameters,
                        descriptor,
                        plugin_id=self.id,
                        telemetry=telemetry,
                        credentials=self._with_defaults(credentials),
                        span=span,
                    )
                    try:
                        result = _call_load_options(node, method, parameters, ctx)
                    except NotImplementedError:
                        result = None
                    if result is None:
                        raise UnknownMethodError(f"node {node_type!r} has no load-options method {method!r}")
                    return [_normalize_option(option) for option in result]
            except Exception as exc:
                outcome = "error"
                exc.args = tuple(redact_text(a) if isinstance(a, str) else a for a in exc.args)
                span.record_exception(exc)
                span.set_status("error", str(exc) or type(exc).__name__)
                raise
            finally:
                span.end()
                telemetry.load_options_calls.add(1, {"landflow.load_options.method": method, "landflow.outcome": outcome})

    def load_options_request(self, request: Any, headers: Any = None) -> dict[str, Any]:
        """``LoadOptionsRequest`` dict -> ``LoadOptionsResponse`` dict."""
        if not isinstance(request, dict):
            raise ProtocolError("request body must be a JSON object")
        options = self.load_options(
            request.get("nodeType"), request.get("method"), request.get("parameters"), request.get("credentials"), headers
        )
        return {"options": options}

    def test_credentials(self, credential_type: Any, data: Any = None, headers: Any = None) -> dict[str, Any]:
        """Run the credential type's ``test`` -> ``TestCredentialsResponse`` (``{ok, message?}``).

        Raises ``UnknownCredentialTypeError`` for undeclared or untestable types.
        A failing or raising test is a normal ``{ok: False, message}`` answer.
        """
        ctype = self.resolve_credential_type(credential_type)
        if ctype.test is None:
            raise UnknownCredentialTypeError(f"credential type {ctype.name!r} is not testable (no test function)")
        if data is None:
            data = {}
        if not isinstance(data, dict):
            raise ProtocolError("data must be an object")
        telemetry = self.telemetry
        with secret_scope(ctype.secret_values(data)):
            span = telemetry.start_span(
                f"plugin.test_credentials {ctype.name}",
                kind="server",
                parent=telemetry.extract(headers),
                attributes={"landflow.plugin.id": self.id, "landflow.credential.type": ctype.name},
            )
            try:
                with telemetry.use_span(span):
                    ctx = CredentialTestContext(ctype.name, plugin_id=self.id, telemetry=telemetry, span=span)
                    try:
                        ok, message = normalize_test_result(_call_test(ctype.test, ctype.with_defaults(data), ctx))
                    except NodeOperationError as exc:  # an expected "no": bad token, 401, unreachable host
                        span.record_exception(exc)
                        ok, message = False, exc.message + (f": {exc.description}" if exc.description else "")
                    except Exception as exc:  # noqa: BLE001 - a bug in the test function
                        log.warning("credential test %s raised %s: %s", ctype.name, type(exc).__name__, redact_text(str(exc)))
                        span.record_exception(exc)
                        ok, message = False, str(exc) or type(exc).__name__
                        span.set_status("error", message)
                span.set_attribute("landflow.credential.ok", ok)
            finally:
                span.end()
            response: dict[str, Any] = {"ok": ok}
            if message:
                response["message"] = redact_text(message)
        return response

    def test_credentials_request(self, request: Any, headers: Any = None) -> dict[str, Any]:
        """``TestCredentialsRequest`` dict -> ``TestCredentialsResponse`` dict."""
        if not isinstance(request, dict):
            raise ProtocolError("request body must be a JSON object")
        return self.test_credentials(request.get("credentialType"), request.get("data"), headers)


# ---------------------------------------------------------------------------
# Validation & normalization
# ---------------------------------------------------------------------------


async def _await(awaitable: Any) -> Any:
    return await awaitable


def _resolve(result: Any) -> Any:
    return asyncio.run(_await(result)) if inspect.isawaitable(result) else result


def _accepts(fn: Callable[..., Any], count: int, keyword: str) -> tuple[bool, bool]:
    """(takes ``count`` positional args, takes ``keyword=``) for a callable."""
    try:
        params = list(inspect.signature(fn).parameters.values())
    except (TypeError, ValueError):
        return True, False
    positional = [p for p in params if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD)]
    varargs = any(p.kind is p.VAR_POSITIONAL for p in params)
    by_keyword = any(p.kind is p.VAR_KEYWORD or (p.name == keyword and p.kind is p.KEYWORD_ONLY) for p in params)
    return varargs or len(positional) >= count, by_keyword


def _call_load_options(node: Node, method: str, parameters: dict[str, Any], ctx: LoadOptionsContext) -> Any:
    positional, by_keyword = _accepts(node.load_options, 3, "ctx")
    if positional:
        return _resolve(node.load_options(method, parameters, ctx))
    if by_keyword:
        return _resolve(node.load_options(method, parameters, ctx=ctx))
    return _resolve(node.load_options(method, parameters))


def _call_test(test: Callable[..., Any], data: dict[str, Any], ctx: CredentialTestContext) -> Any:
    positional, by_keyword = _accepts(test, 2, "ctx")
    if positional:
        return _resolve(test(data, ctx))
    if by_keyword:
        return _resolve(test(data, ctx=ctx))
    return _resolve(test(data))


def _module_dir(module_name: str | None) -> Path:
    """Directory of a loaded module's file: the base for its relative ``file:`` icons (cwd if it has none)."""
    module_file = getattr(sys.modules.get(module_name or ""), "__file__", None)
    return Path(module_file).resolve().parent if module_file else Path.cwd()


def _validate_properties(properties: Any, where: str) -> None:
    if not isinstance(properties, list):
        raise DescriptorError(f"{where}: properties must be a list")
    for prop in properties:
        if not isinstance(prop, dict) or not isinstance(prop.get("name"), str) or not prop["name"]:
            raise DescriptorError(f"{where}: every property needs a name, got {prop!r}")
        if prop.get("type") not in PROPERTY_TYPES:
            raise DescriptorError(f"{where}: property {prop['name']!r} has invalid type {prop.get('type')!r}")
        if not isinstance(prop.get("displayName"), str):
            raise DescriptorError(f"{where}: property {prop['name']!r} needs a displayName")


def _validate_credential_type(entry: Any, icon_base: Any) -> CredentialType:
    if isinstance(entry, dict):
        entry = CredentialType(
            name=entry.get("name"),  # type: ignore[arg-type]
            display_name=entry.get("displayName"),  # type: ignore[arg-type]
            properties=entry.get("properties") or [],
            documentation_url=entry.get("documentationUrl"),
            description=entry.get("description"),
            icon=entry.get("icon"),
            test=entry.get("test"),
        )
    if not isinstance(entry, CredentialType):
        raise DescriptorError(f"credential_types entries must be CredentialType or a descriptor dict, got {entry!r}")
    if not isinstance(entry.name, str) or not _NODE_NAME_RE.match(entry.name):
        raise DescriptorError(f"credential type name {entry.name!r} must be an identifier (e.g. 'githubApi')")
    where = f"credential type {entry.name!r}"
    if not isinstance(entry.display_name, str) or not entry.display_name:
        raise DescriptorError(f"{where}: display_name is required")
    if entry.test is not None and not callable(entry.test):
        raise DescriptorError(f"{where}: test must be a callable test(data, ctx)")
    properties = copy.deepcopy(list(entry.properties or []))
    _validate_properties(properties, where)
    try:
        icon = resolve_icon(entry.icon, icon_base)
    except DescriptorError as exc:
        raise DescriptorError(f"{where}: {exc}") from None
    validated = dataclasses.replace(entry, properties=properties, icon=icon)
    try:
        json.dumps(validated.descriptor(), allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise DescriptorError(f"{where}: descriptor is not JSON-serializable ({exc})") from None
    return validated


def _validate_descriptor(node: Node, credential_types: set[str] | frozenset[str] = frozenset()) -> dict[str, Any]:
    raw = node.description
    if not isinstance(raw, dict):
        raise DescriptorError(f"{type(node).__name__}.description must be a dict (NodeDescriptor)")
    descriptor = copy.deepcopy(raw)
    where = f"{type(node).__name__}.description"

    name = descriptor.get("name")
    if not isinstance(name, str) or not _NODE_NAME_RE.match(name):
        raise DescriptorError(f"{where}: name {name!r} must be an identifier (letters, digits, _ and -)")
    where = f"node {name!r}"
    if not isinstance(descriptor.get("displayName"), str) or not descriptor["displayName"]:
        raise DescriptorError(f"{where}: displayName is required")
    if descriptor.get("kind") not in NODE_KINDS:
        raise DescriptorError(f"{where}: kind must be one of {NODE_KINDS}, got {descriptor.get('kind')!r}")
    version = descriptor.get("version")
    versions = version if isinstance(version, list) else [version]
    if not versions or not all(isinstance(v, int) and not isinstance(v, bool) and v >= 1 for v in versions):
        raise DescriptorError(f"{where}: version must be a positive int or a non-empty list of them")
    for key in ("inputs", "outputs"):
        ports = descriptor.get(key)
        if not isinstance(ports, list):
            raise DescriptorError(f"{where}: {key} is required (a list of ports, e.g. [{{'type': 'main'}}])")
        for port in ports:
            if not isinstance(port, dict) or port.get("type") not in CONNECTION_TYPES:
                raise DescriptorError(f"{where}: {key} entries need type in {CONNECTION_TYPES}, got {port!r}")
    descriptor.setdefault("description", "")
    properties = descriptor.setdefault("properties", [])
    _validate_properties(properties, where)
    overrides_load_options = type(node).load_options is not Node.load_options
    for prop in properties:
        method = (prop.get("typeOptions") or {}).get("loadOptionsMethod")
        if method and not overrides_load_options:
            log.warning("%s: property %r uses loadOptionsMethod %r but the node does not implement load_options()", where, prop["name"], method)
    trigger_source = descriptor.get("triggerSource")
    if trigger_source is not None and trigger_source not in TRIGGER_SOURCES:
        raise DescriptorError(f"{where}: triggerSource must be one of {TRIGGER_SOURCES}, got {trigger_source!r}")
    if trigger_source == "poll" and not any(p["name"] == "pollInterval" for p in properties):
        log.warning("%s: poll trigger without a 'pollInterval' property; add poll_interval_property()", where)
    requirements = descriptor.get("credentials")
    if requirements is not None:
        if not isinstance(requirements, list):
            raise DescriptorError(f"{where}: credentials must be a list of {{'name': ..., 'required': bool}}")
        for requirement in requirements:
            if not isinstance(requirement, dict) or not isinstance(requirement.get("name"), str):
                raise DescriptorError(f"{where}: every credentials entry needs a name, got {requirement!r}")
            if requirement["name"] not in credential_types:
                raise DescriptorError(
                    f"{where}: credential type {requirement['name']!r} is not declared in Plugin(credential_types=...)"
                )
    try:
        json.dumps(descriptor, allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise DescriptorError(f"{where}: descriptor is not JSON-serializable ({exc})") from None
    return descriptor


def _validate_credentials(credentials: Any) -> dict[str, Any]:
    if credentials is None:
        return {}
    if not isinstance(credentials, dict) or not all(isinstance(v, dict) for v in credentials.values()):
        raise ProtocolError("credentials must be an object of objects ({<credentialType>: {...}})")
    return credentials


def _validate_execute_request(request: Any) -> dict[str, Any]:
    if not isinstance(request, dict):
        raise ProtocolError("request body must be a JSON object")
    protocol = request.get("protocol")
    if protocol not in (None, "", PROTOCOL_VERSION):
        raise ProtocolError(f"unsupported protocol {protocol!r} (expected {PROTOCOL_VERSION!r})")
    node = request.get("node")
    if not isinstance(node, dict) or not isinstance(node.get("type"), str) or not node["type"]:
        raise ProtocolError("node.type is required")

    parameters = request.get("parameters")
    if parameters is None:
        parameters = {}
    if not isinstance(parameters, dict):
        raise ProtocolError("parameters must be an object")

    item_parameters = request.get("itemParameters")
    if item_parameters is None:
        item_parameters = []
    if not isinstance(item_parameters, list) or not all(isinstance(p, dict) for p in item_parameters):
        raise ProtocolError("itemParameters must be an array of objects")

    inputs = request.get("inputs")
    if inputs is None:
        inputs = []
    if not isinstance(inputs, list):
        raise ProtocolError("inputs must be an array of item arrays")
    for i, branch in enumerate(inputs):
        if not isinstance(branch, list):
            raise ProtocolError(f"inputs[{i}] must be an array of items")
        for j, item in enumerate(branch):
            if not isinstance(item, dict) or not isinstance(item.get("json"), dict):
                raise ProtocolError(f"inputs[{i}][{j}] must be an item {{\"json\": {{...}}}}")

    credentials = _validate_credentials(request.get("credentials"))
    poll_state = request.get("pollState")
    if poll_state is not None and not isinstance(poll_state, dict):
        raise ProtocolError("pollState must be an object")
    mode = request.get("mode")
    if mode is not None and not isinstance(mode, str):
        raise ProtocolError("mode must be a string")

    normalized = dict(request)
    normalized.update(
        protocol=PROTOCOL_VERSION,
        node=dict(node),
        mode=mode or "manual",
        parameters=parameters,
        itemParameters=item_parameters,
        inputs=inputs,
    )
    if credentials:
        normalized["credentials"] = credentials
    return normalized


def _normalize_outputs(result: Any, descriptor: dict[str, Any], input_count: int) -> list[list[dict[str, Any]]]:
    if result is None:
        branches: list[Any] = [[]]
    elif isinstance(result, dict):
        branches = [[result]]
    elif isinstance(result, (list, tuple)):
        if not result:
            branches = [[]]
        elif all(isinstance(x, (list, tuple)) for x in result):
            branches = list(result)
        elif all(isinstance(x, dict) for x in result):
            branches = [result]
        else:
            raise TypeError("execute() returned a mix of lists and items; return list[list[item]] or list[item]")
    else:
        raise TypeError(f"execute() must return a list of items or a list of outputs, got {type(result).__name__}")

    outputs: list[list[dict[str, Any]]] = []
    for o, branch in enumerate(branches):
        items = [_normalize_item(item, o, i) for i, item in enumerate(branch)]
        if input_count and len(items) == input_count:
            for i, item in enumerate(items):
                item.setdefault("pairedItem", {"item": i})
        outputs.append(items)

    main_outputs = sum(1 for port in descriptor.get("outputs", []) if port.get("type") == "main")
    while len(outputs) < main_outputs:
        outputs.append([])
    return outputs


def _normalize_item(item: Any, output_index: int, item_index: int) -> dict[str, Any]:
    if not isinstance(item, dict):
        raise TypeError(f"output {output_index} item {item_index} is a {type(item).__name__}, expected a dict")
    if isinstance(item.get("json"), dict) and _ITEM_KEYS.issuperset(item):
        payload, paired = item["json"], item.get("pairedItem")
    else:
        payload, paired = item, None
    out: dict[str, Any] = {"json": to_jsonable(payload)}
    if paired is not None:
        if isinstance(paired, int) and not isinstance(paired, bool):
            out["pairedItem"] = {"item": paired}
        elif isinstance(paired, dict) and isinstance(paired.get("item"), int):
            out["pairedItem"] = {"item": paired["item"]}
            if isinstance(paired.get("input"), int):
                out["pairedItem"]["input"] = paired["input"]
        else:
            raise TypeError(f"output {output_index} item {item_index}: pairedItem must be {{'item': int}}")
    return out


def _normalize_option(option: Any) -> dict[str, Any]:
    if isinstance(option, dict):
        if "value" not in option:
            raise TypeError(f"load_options() returned an option without 'value': {option!r}")
        out = {"name": str(option.get("name", option["value"])), "value": option["value"]}
        for key in ("description", "action"):
            if option.get(key):
                out[key] = str(option[key])
        return out
    if isinstance(option, (str, int, float, bool)):
        return {"name": str(option), "value": option}
    raise TypeError(f"load_options() returned an invalid option: {option!r}")
