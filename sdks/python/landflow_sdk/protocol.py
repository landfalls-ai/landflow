"""Protocol constants and JSON helpers shared by every transport.

Mirrors ``packages/protocol/src/types.ts`` (the source of truth).
"""

from __future__ import annotations

import base64
import datetime as _dt
import decimal
import json
import math
import uuid
from typing import Any

PROTOCOL_VERSION = "landflow.plugin/v1"

HTTP_PATHS = {
    "wellKnown": "/.well-known/landflow",
    "manifest": "/landflow/v1/manifest",
    "execute": "/landflow/v1/execute",
    "loadOptions": "/landflow/v1/load-options",
    "testCredentials": "/landflow/v1/test-credentials",
    "health": "/landflow/v1/health",
    "webhookMethod": "/landflow/v1/webhook-method",  # app webhook triggers (docs/protocol.md §12)
    "webhook": "/landflow/v1/webhook",
}

METRICS_PATH = "/metrics"  # Prometheus text (docs/observability.md)
TRACE_HEADERS = ("traceparent", "tracestate", "baggage")

ANNOUNCE_PATH = "/api/plugins/announce"

DEFAULT_ANNOUNCE_TTL_SECONDS = 30
DEFAULT_HEARTBEAT_SECONDS = 10

NODE_KINDS = ("trigger", "action", "subnode")
TRIGGER_SOURCES = ("manual", "webhook", "schedule", "chat", "poll", "appWebhook")
CONNECTION_TYPES = ("main", "ai_languageModel", "ai_tool", "ai_memory")
PROPERTY_TYPES = (
    "string",
    "number",
    "boolean",
    "options",
    "multiOptions",
    "json",
    "code",
    "collection",
    "fixedCollection",
    "color",
    "dateTime",
    "notice",
    "hidden",
)
EXECUTION_MODES = ("manual", "trigger", "webhook", "tool", "chat", "poll", "mcp")
LOG_LEVELS = ("debug", "info", "warn", "error")


def to_jsonable(value: Any) -> Any:
    """Return a copy of ``value`` that ``json.dumps`` (and JS ``JSON.parse``) accepts.

    Tuples/sets become lists, datetimes ISO strings, Decimals floats, bytes
    base64, and non-finite floats (NaN, Infinity) ``None``.
    """
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {str(k): to_jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [to_jsonable(v) for v in value]
    if isinstance(value, (_dt.datetime, _dt.date, _dt.time)):
        return value.isoformat()
    if isinstance(value, decimal.Decimal):
        return to_jsonable(float(value))
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        return base64.b64encode(bytes(value)).decode("ascii")
    return str(value)


def dumps(value: Any) -> bytes:
    """Encode to compact UTF-8 JSON bytes."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
