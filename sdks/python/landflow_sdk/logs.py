"""Process logs: one JSON object per line on stdout, with trace ids (docs/observability.md §3).

``configure_logging()`` (called by ``serve()``) installs ``LogFormatter`` on the
root logger unless the application configured logging itself. Every record,
whatever logger wrote it, gets ``ts``, ``level``, ``service``, ``msg`` and the
active ``trace_id`` / ``span_id``; structured fields ride in
``extra={"landflow_fields": {...}}``. Messages and fields are redacted.

    LANDFLOW_LOG_LEVEL   debug | info (default) | warn | error
    LANDFLOW_LOG_FORMAT  json (default) | pretty
"""

from __future__ import annotations

import datetime as _dt
import json
import logging
import os
import sys
import time
from typing import Any, Callable, Mapping, TextIO

from .protocol import to_jsonable
from .redact import redact_attributes, redact_text

SPAN_LOGGER = "landflow_sdk.span"
NODE_LOGGER = "landflow_sdk.node"
_NO_LOGGER_FIELD = {SPAN_LOGGER, NODE_LOGGER}
_LEAD_FIELDS = ("span", "kind")  # span.end lines put these before the ids, as in the spec

LEVELS = {"debug": logging.DEBUG, "info": logging.INFO, "warn": logging.WARNING, "warning": logging.WARNING, "error": logging.ERROR}

# span.end lines only show up once logging is configured (no last-resort stderr output).
logging.getLogger(SPAN_LOGGER).addHandler(logging.NullHandler())

# Set by telemetry.py: returns the active (trace_id, span_id) or (None, None).
_ids_provider: Callable[[], tuple[str | None, str | None]] = lambda: (None, None)


def set_ids_provider(provider: Callable[[], tuple[str | None, str | None]]) -> None:
    global _ids_provider
    _ids_provider = provider


def level_name(levelno: int) -> str:
    if levelno >= logging.ERROR:
        return "error"
    if levelno >= logging.WARNING:
        return "warn"
    if levelno >= logging.INFO:
        return "info"
    return "debug"


def parse_level(value: str | None, default: int = logging.INFO) -> int:
    return LEVELS.get((value or "").strip().lower(), default)


class LogFormatter(logging.Formatter):
    """``json``: one object per line. ``pretty``: ``HH:MM:SS level service msg (trace=…/span=…) k=v``."""

    def __init__(self, service: str = "landflow-plugin", fmt: str = "json") -> None:
        super().__init__()
        self.service = service
        self.pretty = fmt.strip().lower() == "pretty"

    def _record(self, record: logging.LogRecord) -> tuple[dict[str, Any], dict[str, Any]]:
        fields = getattr(record, "landflow_fields", None) or {}
        trace_id = getattr(record, "trace_id", None)
        span_id = getattr(record, "span_id", None)
        if trace_id is None:
            trace_id, span_id = _ids_provider()
        head: dict[str, Any] = {
            "ts": _iso(record.created),
            "level": level_name(record.levelno),
            "service": getattr(record, "landflow_service", None) or self.service,
            "msg": redact_text(record.getMessage()),
        }
        body = redact_attributes(fields) if isinstance(fields, Mapping) else {}
        for key in _LEAD_FIELDS:
            if key in body:
                head[key] = body.pop(key)
        if trace_id:
            head["trace_id"] = trace_id
            head["span_id"] = span_id
        if record.name not in _NO_LOGGER_FIELD:
            head["logger"] = record.name
        if record.exc_info and record.exc_info[1] is not None:
            exc = record.exc_info[1]
            body["exception.type"] = type(exc).__name__
            body["exception.message"] = redact_text(str(exc))
            body["exception.stacktrace"] = redact_text(self.formatException(record.exc_info))
        return head, body

    def format(self, record: logging.LogRecord) -> str:
        head, body = self._record(record)
        if self.pretty:
            return _pretty(record, head, body)
        for key, value in body.items():
            head.setdefault(key, value)
        return json.dumps(to_jsonable(head), ensure_ascii=False, separators=(",", ":"))


def _iso(created: float) -> str:
    stamp = _dt.datetime.fromtimestamp(created, _dt.timezone.utc)
    return stamp.strftime("%Y-%m-%dT%H:%M:%S.") + f"{stamp.microsecond // 1000:03d}Z"


def _pretty_value(value: Any) -> str:
    if isinstance(value, str) and value and not any(c.isspace() for c in value) and '"' not in value:
        return value
    return json.dumps(to_jsonable(value), ensure_ascii=False)


def _pretty(record: logging.LogRecord, head: dict[str, Any], body: dict[str, Any]) -> str:
    clock = time.strftime("%H:%M:%S", time.localtime(record.created))
    msg = head["msg"]
    if "span" in head:
        msg = f"{msg} {head['span']}"
    line = f"{clock} {head['level']:<5} {head['service']} {msg}"
    if head.get("trace_id"):
        line += f" (trace={head['trace_id']}/span={head['span_id']})"
    pairs: list[str] = []
    if "kind" in head:
        pairs.append(f"kind={head['kind']}")
    stack = body.pop("exception.stacktrace", None)
    for key, value in body.items():
        if key == "attributes" and isinstance(value, Mapping):
            pairs.extend(f"{k}={_pretty_value(v)}" for k, v in value.items())
        else:
            pairs.append(f"{key}={_pretty_value(value)}")
    if "logger" in head:
        pairs.append(f"logger={head['logger']}")
    if pairs:
        line += " " + " ".join(pairs)
    if stack:
        line += "\n" + stack
    return line


def emit_span_end(
    service: str,
    name: str,
    kind: str,
    trace_id: str,
    span_id: str,
    parent_span_id: str | None,
    duration_ms: float,
    error: str | None,
    attributes: Mapping[str, Any],
) -> None:
    """Write the ``span.end`` line for a finished span (``LANDFLOW_LOG_SPANS``)."""
    logger = logging.getLogger(SPAN_LOGGER)
    level = logging.ERROR if error is not None else logging.INFO
    if not logger.isEnabledFor(level):
        return
    fields: dict[str, Any] = {"span": name, "kind": kind}
    if parent_span_id:
        fields["parent_span_id"] = parent_span_id
    fields["duration_ms"] = round(duration_ms, 3)
    fields["status"] = "error" if error is not None else "ok"
    if error is not None:
        fields["error"] = error
    fields["attributes"] = dict(attributes)
    logger.log(
        level,
        "span.end",
        extra={"trace_id": trace_id, "span_id": span_id, "landflow_service": service, "landflow_fields": fields},
    )


def configure_logging(
    service: str | Any = None,
    *,
    env: Mapping[str, str] | None = None,
    stream: TextIO | None = None,
    force: bool = False,
) -> logging.Handler | None:
    """Send all logging to ``stream`` (stdout) through ``LogFormatter``.

    ``service`` is a service name or a ``Plugin`` (its telemetry's service
    name is used). Does nothing when the root logger already has handlers,
    unless ``force``. Returns the installed handler.
    """
    env = os.environ if env is None else env
    root = logging.getLogger()
    if root.handlers and not force:
        return None
    telemetry = getattr(service, "telemetry", None)
    name = telemetry.service_name if telemetry is not None else (service or "landflow-plugin")
    handler = logging.StreamHandler(stream or sys.stdout)
    handler.setFormatter(LogFormatter(str(name), env.get("LANDFLOW_LOG_FORMAT", "json")))
    if force:
        for existing in list(root.handlers):
            root.removeHandler(existing)
    root.addHandler(handler)
    root.setLevel(parse_level(env.get("LANDFLOW_LOG_LEVEL")))
    return handler
