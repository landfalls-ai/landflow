"""What node code sees while it runs: ``ExecuteContext``, ``LoadOptionsContext``, ``CredentialTestContext``.

All three share the observability helpers (docs/observability.md §6):

    with ctx.span("github.list_issues", {"github.repo": repo}) as span:
        resp = ctx.http.get(url, headers=auth, params={"state": "open"})   # client span + traceparent
        span.set_attribute("github.issues", len(resp.json))
    ctx.metrics.counter("github.issues.fetched").add(len(resp.json))
    ctx.logger.info("fetched issues", count=len(resp.json))
"""

from __future__ import annotations

import copy
import logging
from contextlib import AbstractContextManager
from typing import Any, Mapping

from .errors import NodeOperationError
from .http_client import HttpClient
from .logs import NODE_LOGGER
from .metrics import Metrics
from .protocol import to_jsonable
from .redact import redact_text
from .telemetry import Span, Telemetry

_NO_DEFAULT = object()


def _visible(prop: Mapping[str, Any], values: Mapping[str, Any]) -> bool:
    """n8n-style ``displayOptions`` check against the item's parameter values."""
    options = prop.get("displayOptions") or {}
    for key, allowed in (options.get("show") or {}).items():
        if values.get(key, _NO_DEFAULT) not in allowed:
            return False
    for key, blocked in (options.get("hide") or {}).items():
        if values.get(key, _NO_DEFAULT) in blocked:
            return False
    return True
_UNSET = object()
_node_log = logging.getLogger(NODE_LOGGER)
_LEVELS = {"debug": logging.DEBUG, "info": logging.INFO, "warn": logging.WARNING, "error": logging.ERROR}


class NodeLogger:
    """``debug/info/warn/error(message, *args, **attrs)``.

    Lines are collected into ``ExecuteResponse.logs`` (message only) and written
    to the process log with the trace ids, the node's attributes and ``attrs``.
    ``args`` are %-formatted into the message, as with ``logging``.
    """

    def __init__(
        self,
        node_name: str = "",
        attributes: Mapping[str, Any] | None = None,
        service: str | None = None,
        collect: bool = True,
    ) -> None:
        self._node_name = node_name
        self._attributes = {k: v for k, v in (attributes or {}).items() if v not in (None, "")}
        self._service = service
        self._collect = collect
        self.entries: list[dict[str, str]] = []

    def _log(self, level: str, message: Any, args: tuple[Any, ...], attrs: dict[str, Any]) -> None:
        text = redact_text(str(message) % args if args else str(message))
        if self._collect:
            self.entries.append({"level": level, "message": text})
        levelno = _LEVELS[level]
        if _node_log.isEnabledFor(levelno):
            extra: dict[str, Any] = {"landflow_fields": {**self._attributes, **attrs}}
            if self._service:
                extra["landflow_service"] = self._service
            _node_log.log(levelno, text, extra=extra)

    def debug(self, message: Any, /, *args: Any, **attrs: Any) -> None:
        self._log("debug", message, args, attrs)

    def info(self, message: Any, /, *args: Any, **attrs: Any) -> None:
        self._log("info", message, args, attrs)

    def warn(self, message: Any, /, *args: Any, **attrs: Any) -> None:
        self._log("warn", message, args, attrs)

    warning = warn

    def error(self, message: Any, /, *args: Any, **attrs: Any) -> None:
        self._log("error", message, args, attrs)


class _TelemetryContext:
    """``span()``, ``metrics``, ``http``, ``logger`` and the active ``trace_id`` / ``span_id``."""

    telemetry: Telemetry
    metrics: Metrics
    logger: NodeLogger
    _server_span: Span | None
    _http: HttpClient | None

    def span(self, name: str, attributes: Mapping[str, Any] | None = None) -> AbstractContextManager[Span]:
        """``with ctx.span("telegram.send", {"telegram.chat_type": t}) as span:`` -- a child span.

        Use a low-cardinality name (an operation, never a user value); put details in attributes.
        An exception leaving the block marks the span as failed and propagates.
        """
        return self.telemetry.span(name, attributes)

    @property
    def http(self) -> HttpClient:
        """Traced HTTP client: ``ctx.http.request(method, url, headers=, json=, data=, params=, timeout=)``."""
        if self._http is None:
            self._http = HttpClient(self.telemetry)
        return self._http

    @property
    def trace_id(self) -> str | None:
        span = self._server_span
        return span.trace_id if span is not None and span.trace_id else None

    @property
    def span_id(self) -> str | None:
        span = self._server_span
        return span.span_id if span is not None and span.span_id else None


def _get_credentials(descriptor: Mapping[str, Any], credentials: Mapping[str, Any], name: str | None) -> dict[str, Any] | None:
    requirements = [c for c in descriptor.get("credentials") or [] if isinstance(c, dict)]
    if name is None:
        if len(requirements) == 1:
            name = requirements[0]["name"]
        elif len(credentials) == 1:
            name = next(iter(credentials))
        else:
            declared = ", ".join(repr(c["name"]) for c in requirements) or "none"
            raise ValueError(f"get_credentials() needs a credential type name (this node declares: {declared})")
    data = credentials.get(name)
    if isinstance(data, dict):
        return data
    requirement = next((c for c in requirements if c["name"] == name), None)
    if requirement is not None and not requirement.get("required", False):
        return None
    raise NodeOperationError(
        f"No credentials set for '{name}'",
        description="Select (or create) a credential for this node in its parameters panel.",
    )


class ExecuteContext(_TelemetryContext):
    """Read-only view of an ``ExecuteRequest`` for one node invocation.

    Attributes: ``node`` (NodeRef dict), ``node_type`` (qualified), ``mode``,
    ``execution_id``, ``workflow_id``, ``credentials`` (dict, possibly empty),
    ``type_version``, ``logger``, ``metrics``, ``http``, ``trace_id`` and
    ``request`` (the raw request dict).
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
    ) -> None:
        self.request = request
        self.descriptor = descriptor
        self.node: dict[str, Any] = request["node"]
        self.node_type: str = self.node.get("type") or ""
        self.plugin_id = plugin_id
        self.mode: str = request.get("mode") or "manual"
        self.execution_id: str = request.get("executionId") or ""
        self.workflow_id: str | None = request.get("workflowId") or None
        self.credentials: dict[str, Any] = credentials if credentials is not None else (request.get("credentials") or {})
        self.type_version: int = self.node.get("typeVersion") or 1
        self.parameters: dict[str, Any] = request.get("parameters") or {}
        self.item_parameters: list[dict[str, Any]] = request.get("itemParameters") or []
        self.inputs: list[list[dict[str, Any]]] = request.get("inputs") or []
        self.telemetry = telemetry or Telemetry.noop()
        self._server_span = span
        self._http = None
        node_name = self.node.get("name") or descriptor.get("name", "")
        self.logger = NodeLogger(
            node_name,
            attributes={
                "landflow.node.type": self.node_type,
                "landflow.node.name": node_name,
                "landflow.execution.id": self.execution_id,
                "landflow.workflow.id": self.workflow_id,
            },
            service=self.telemetry.service_name if telemetry is not None else None,
        )
        self.metrics = Metrics(
            self.telemetry.metrics,
            {"landflow.plugin.id": plugin_id, "landflow.node.type": self.node_type, "landflow.workflow.id": self.workflow_id},
        )
        poll_state = request.get("pollState")
        self._poll_state_in: dict[str, Any] | None = poll_state if isinstance(poll_state, dict) else None
        self._poll_state_out: Any = _UNSET
        self._properties = [prop for prop in descriptor.get("properties", []) if isinstance(prop, dict) and "name" in prop]
        self._item_defaults: dict[int, dict[str, Any]] = {}

    def get_input_data(self, input_index: int = 0) -> list[dict[str, Any]]:
        """Items that arrived on main input ``input_index`` (``[]`` if none)."""
        if 0 <= input_index < len(self.inputs):
            return self.inputs[input_index]
        return []

    def get_node_parameter(self, name: str, item_index: int = 0, default: Any = None) -> Any:
        """Parameter value for item ``item_index``.

        Order: ``itemParameters[item_index][name]`` -> ``parameters[name]`` ->
        the property's ``default`` in the descriptor -> ``default``.
        """
        if 0 <= item_index < len(self.item_parameters):
            per_item = self.item_parameters[item_index]
            if isinstance(per_item, dict) and name in per_item:
                return per_item[name]
        if name in self.parameters:
            return self.parameters[name]
        defaults = self._defaults_for(item_index)
        if name in defaults:
            return defaults[name]
        # A hidden property falls back to the first default declared under its name.
        for prop in self._properties:
            if prop["name"] == name and "default" in prop:
                return prop["default"]
        return default

    def _defaults_for(self, item_index: int) -> dict[str, Any]:
        """Defaults of the properties visible for this item. As in n8n, the first visible property of a name wins,
        so ``operation`` takes the default of the variant shown for the chosen ``resource``."""
        cached = self._item_defaults.get(item_index)
        if cached is not None:
            return cached
        values: dict[str, Any] = dict(self.parameters)
        if 0 <= item_index < len(self.item_parameters) and isinstance(self.item_parameters[item_index], dict):
            values.update(self.item_parameters[item_index])
        for _ in range(8):
            changed = False
            for prop in self._properties:
                if prop.get("type") == "notice" or "default" not in prop or prop["name"] in values:
                    continue
                if _visible(prop, values):
                    values[prop["name"]] = prop["default"]
                    changed = True
            if not changed:
                break
        self._item_defaults[item_index] = values
        return values

    # ---------------------------------------------------------- credentials

    def get_credentials(self, name: str | None = None) -> dict[str, Any] | None:
        """Decrypted values of credential type ``name`` (local name), with the type's defaults filled in.

        ``name`` may be omitted when the node declares exactly one credential.
        A missing credential raises ``NodeOperationError``, unless the node
        declares it with ``required: False`` (then ``None``).
        """
        return _get_credentials(self.descriptor, self.credentials, name)

    def continue_on_fail(self) -> bool:
        """True when the node is set to continue on error: catch a failing item, append
        ``{"json": {"error": str(exc)}, "pairedItem": {"item": i}}`` and go on with the next item."""
        return self.request.get("continueOnFail") is True

    # -------------------------------------------------------------- polling

    def get_poll_state(self) -> dict[str, Any] | None:
        """The ``pollState`` the previous poll returned (a copy), ``None`` on the first poll."""
        return copy.deepcopy(self._poll_state_in) if self._poll_state_in is not None else None

    def set_poll_state(self, state: Mapping[str, Any]) -> None:
        """State for the next poll (a JSON object). Returned as ``pollState`` only in ``mode == "poll"``;
        without a call the incoming state is passed back unchanged."""
        if not isinstance(state, Mapping):
            raise TypeError(f"poll state must be a dict, got {type(state).__name__}")
        self._poll_state_out = to_jsonable(dict(state))

    def is_first_poll(self) -> bool:
        """``True`` on a scheduled poll without previous state: establish the baseline, return no items."""
        return self.mode == "poll" and self._poll_state_in is None

    def _response_poll_state(self) -> dict[str, Any] | None:
        if self.mode != "poll":
            return None
        if self._poll_state_out is not _UNSET:
            return self._poll_state_out
        return self._poll_state_in


class LoadOptionsContext(_TelemetryContext):
    """Passed as ``ctx`` to ``Node.load_options(method, parameters, ctx)`` when the override accepts it."""

    def __init__(
        self,
        node_type: str,
        method: str,
        parameters: dict[str, Any],
        descriptor: dict[str, Any],
        *,
        plugin_id: str = "",
        telemetry: Telemetry | None = None,
        credentials: dict[str, Any] | None = None,
        span: Span | None = None,
    ) -> None:
        self.node_type = node_type
        self.method = method
        self.parameters = parameters
        self.descriptor = descriptor
        self.plugin_id = plugin_id
        self.credentials: dict[str, Any] = credentials or {}
        self.telemetry = telemetry or Telemetry.noop()
        self._server_span = span
        self._http = None
        self.logger = NodeLogger(
            descriptor.get("name", ""),
            attributes={"landflow.node.type": node_type, "landflow.load_options.method": method},
            service=self.telemetry.service_name if telemetry is not None else None,
            collect=False,
        )
        self.metrics = Metrics(self.telemetry.metrics, {"landflow.plugin.id": plugin_id, "landflow.node.type": node_type})

    def get_credentials(self, name: str | None = None) -> dict[str, Any] | None:
        """Same as ``ExecuteContext.get_credentials``."""
        return _get_credentials(self.descriptor, self.credentials, name)


class CredentialTestContext(_TelemetryContext):
    """Passed as ``ctx`` to a ``CredentialType.test(data, ctx)`` function."""

    def __init__(self, credential_type: str, *, plugin_id: str = "", telemetry: Telemetry | None = None, span: Span | None = None) -> None:
        self.credential_type = credential_type
        self.plugin_id = plugin_id
        self.telemetry = telemetry or Telemetry.noop()
        self._server_span = span
        self._http = None
        self.logger = NodeLogger(
            credential_type,
            attributes={"landflow.credential.type": credential_type},
            service=self.telemetry.service_name if telemetry is not None else None,
            collect=False,
        )
        self.metrics = Metrics(self.telemetry.metrics, {"landflow.plugin.id": plugin_id})
