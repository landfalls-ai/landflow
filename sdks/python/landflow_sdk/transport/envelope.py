"""The Landflow messaging envelope: a CloudEvents 1.0 event (docs/protocol.md §14.3).

Byte-compatible with ``packages/transports/src/envelope.ts`` and ``sdks/go/transport/envelope.go``: the same
attribute rules, the same two wire modes (binary: headers + bytes; structured: one ``application/cloudevents+json``
document) and the same JSON serialisation (``json_stringify`` reproduces ``JSON.stringify``, so the manifest hash
agrees across the three cores).
"""

from __future__ import annotations

import base64
import json
import math
import re
import secrets
from dataclasses import dataclass, field, fields
from datetime import datetime, timezone
from typing import Any, Literal

CE_SPECVERSION = "1.0"
CE_TYPE_PREFIX = "dev.landflow.plugin.v1."
STRUCTURED_CONTENT_TYPE = "application/cloudevents+json; charset=utf-8"
JSON_CONTENT_TYPE = "application/json"
ENCRYPTED_CONTENT_TYPE = "application/octet-stream"
ENC_AES_GCM = "aes-256-gcm"

#: The logical RPC methods (docs/protocol.md), with their lower-case CloudEvents type segment.
METHODS = ("GetManifest", "Execute", "LoadOptions", "TestCredentials", "Health", "WebhookMethod", "ReceiveWebhook")
_SEGMENTS = {
    "GetManifest": "getmanifest",
    "Execute": "execute",
    "LoadOptions": "loadoptions",
    "TestCredentials": "testcredentials",
    "Health": "health",
    "WebhookMethod": "webhookmethod",
    "ReceiveWebhook": "receivewebhook",
}
_BY_SEGMENT = {segment: method for method, segment in _SEGMENTS.items()}

CANCEL_TYPE = CE_TYPE_PREFIX + "cancel"
ANNOUNCE_TYPE = CE_TYPE_PREFIX + "announce"
WITHDRAW_TYPE = CE_TYPE_PREFIX + "withdraw"

AT_MOST_ONCE = "at-most-once"
AT_LEAST_ONCE = "at-least-once"
DeliveryMode = Literal["at-most-once", "at-least-once"]

#: ``lferror`` codes a plugin answers with (docs/protocol.md §14.6).
REMOTE_ERROR_CODES = ("manifest_mismatch", "expired", "bad_request", "not_found", "internal", "cancelled", "unavailable", "capacity", "too_large")

#: The Landflow extensions; ``lfsig`` is computed over all the others and never part of the canonical form.
LF_EXTENSIONS = ("lfreplyto", "lfcorrelation", "lfdeadline", "lfattempt", "lfidempotency", "lfdelivery", "lfmanifest", "lferror", "lfenc", "lfkeyid", "lfsig")
#: Every attribute the envelope knows, in canonical (signing) order. Anything else is dropped on decode.
KNOWN_ATTRIBUTES = ("specversion", "id", "source", "type", "subject", "time", "datacontenttype", "traceparent", "tracestate", *LF_EXTENSIONS)


def method_segment(method: str) -> str:
    return _SEGMENTS[method]


def request_type(method: str) -> str:
    return f"{CE_TYPE_PREFIX}{_SEGMENTS[method]}.request"


def response_type(method: str) -> str:
    return f"{CE_TYPE_PREFIX}{_SEGMENTS[method]}.response"


@dataclass(frozen=True)
class ParsedType:
    """What a ``type`` means: ``kind`` is ``request``/``response`` (with ``method``), ``cancel``, ``announce`` or ``withdraw``."""

    kind: str
    method: str | None = None


def parse_type(type_: str) -> ParsedType | None:
    """``ParsedType`` for a known event type, ``None`` for one this version does not know."""
    if not type_.startswith(CE_TYPE_PREFIX):
        return None
    rest = type_[len(CE_TYPE_PREFIX):]
    if rest in ("cancel", "announce", "withdraw"):
        return ParsedType(rest)
    dot = rest.rfind(".")
    if dot < 0:
        return None
    method = _BY_SEGMENT.get(rest[:dot])
    kind = rest[dot + 1:]
    if method is None or kind not in ("request", "response"):
        return None
    return ParsedType(kind, method)


class EnvelopeError(Exception):
    """A wire event does not decode or validate (``reason``: ``malformed``, ``unsupported`` or ``too_large``). The core drops it."""

    def __init__(self, message: str, reason: str) -> None:
        super().__init__(message)
        self.reason = reason


@dataclass
class Attributes:
    """The decoded attributes of an event. Every value is a string on the wire; ``None`` means absent."""

    specversion: str = CE_SPECVERSION
    id: str = ""
    source: str = ""
    type: str = ""
    subject: str | None = None
    time: str = ""
    datacontenttype: str = JSON_CONTENT_TYPE
    traceparent: str | None = None
    tracestate: str | None = None
    lfreplyto: str | None = None
    lfcorrelation: str | None = None
    lfdeadline: str | None = None
    lfattempt: str | None = None
    lfidempotency: str | None = None
    lfdelivery: str | None = None
    lfmanifest: str | None = None
    lferror: str | None = None
    lfenc: str | None = None
    lfkeyid: str | None = None
    lfsig: str | None = None

    def headers(self) -> dict[str, str]:
        """The attributes as wire headers, in canonical order, without absent values."""
        out: dict[str, str] = {}
        for name in KNOWN_ATTRIBUTES:
            value = getattr(self, name)
            if value is not None and value != "":
                out[name] = value
        return out

    def deadline_ms(self) -> int | None:
        """``lfdeadline`` as epoch milliseconds, ``None`` when absent."""
        return int(self.lfdeadline) if self.lfdeadline else None

    def copy(self, **changes: Any) -> Attributes:
        values = {f.name: getattr(self, f.name) for f in fields(self)}
        values.update(changes)
        return Attributes(**values)


@dataclass
class RawEvent:
    """An event with its body still as bytes: what the security layer signs, verifies, encrypts and decrypts."""

    attributes: Attributes
    body: bytes = b""


@dataclass
class WireEvent:
    """One event on the wire: string headers (bare CloudEvents names plus ``content-type``) and bytes."""

    headers: dict[str, str] = field(default_factory=dict)
    body: bytes = b""


@dataclass(frozen=True)
class WireSize:
    header_bytes: int
    body_bytes: int
    total_bytes: int


_ID_RE = re.compile(r"^[\x21-\x7e]{1,128}$")
_SOURCE_RE = re.compile(r"^landflow://(host/[A-Za-z0-9._-]{1,128}|plugin/[A-Za-z0-9._-]{1,128}/[A-Za-z0-9._-]{1,128})$")
_TYPE_RE = re.compile(r"^dev\.landflow\.plugin\.v1\.[a-z]+(\.(request|response))?$")
_DIGITS_RE = re.compile(r"^\d{1,16}$")
_HEX_RE = re.compile(r"^[0-9a-f]+$")
_TIME_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$")
_VALUE_RE = re.compile(r"^[\x20-\x7e]*$")
_OPTIONAL: tuple[tuple[str, re.Pattern[str] | None, int], ...] = (
    ("subject", re.compile(r"^[A-Za-z0-9._:-]{1,256}$"), 4096),
    ("traceparent", re.compile(r"^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$"), 4096),
    ("tracestate", None, 1024),
    ("lfreplyto", re.compile(r"^[A-Za-z0-9._-]{1,256}$"), 4096),
    ("lfcorrelation", _ID_RE, 4096),
    ("lfdeadline", _DIGITS_RE, 4096),
    ("lfattempt", re.compile(r"^\d{1,6}$"), 4096),
    ("lfidempotency", re.compile(r"^[\x21-\x7e]{1,256}$"), 4096),
    ("lfmanifest", re.compile(r"^[0-9a-f]{8,64}$"), 4096),
    ("lfkeyid", re.compile(r"^[0-9a-f]{8,32}$"), 4096),
    ("lfsig", re.compile(r"^[0-9a-f]{64}$"), 4096),
)
_LFERROR_RE = re.compile(r"^[a-z_]{1,32}$")


def host_source(instance_id: str) -> str:
    return f"landflow://host/{instance_id}"


def plugin_source(plugin_id: str, instance_id: str) -> str:
    return f"landflow://plugin/{plugin_id}/{instance_id}"


_PLUGIN_SOURCE_RE = re.compile(r"^landflow://plugin/([^/]+)/([^/]+)$")


def parse_plugin_source(source: str) -> tuple[str, str] | None:
    """``(plugin_id, instance_id)`` of a ``landflow://plugin/…`` source; ``None`` for a host source."""
    match = _PLUGIN_SOURCE_RE.match(source)
    return (match.group(1), match.group(2)) if match else None


def validate_attributes(raw: dict[str, str | None], *, strict: bool = False) -> Attributes:
    """Strict validation of wire attributes (every required one present and well-formed, values printable ASCII).

    Unknown attributes are dropped; ``strict=True`` refuses them instead (for tests). Raises ``EnvelopeError``.
    """

    def bad(name: str, why: str = "is malformed") -> EnvelopeError:
        return EnvelopeError(f'attribute "{name}" {why}', "malformed")

    def read(name: str, required: bool, pattern: re.Pattern[str] | None = None, maximum: int = 4096) -> str | None:
        value = raw.get(name)
        if value is None or value == "":
            if required:
                raise bad(name, "is required")
            return None
        if not isinstance(value, str) or len(value) > maximum or not _VALUE_RE.match(value):
            raise bad(name)
        if pattern is not None and not pattern.match(value):
            raise bad(name)
        return value

    if strict:
        for name in raw:
            if name not in KNOWN_ATTRIBUTES:
                raise bad(name, "is not a known attribute")
    specversion = read("specversion", True)
    if specversion != CE_SPECVERSION:
        raise EnvelopeError(f'specversion "{specversion}" is not supported', "unsupported")
    type_ = read("type", True, _TYPE_RE) or ""
    if parse_type(type_) is None:
        raise EnvelopeError(f'type "{type_}" is not supported', "unsupported")
    datacontenttype = read("datacontenttype", True) or ""
    if datacontenttype not in (JSON_CONTENT_TYPE, ENCRYPTED_CONTENT_TYPE):
        raise EnvelopeError(f'datacontenttype "{datacontenttype}" is not supported', "unsupported")
    lfdelivery = read("lfdelivery", False)
    if lfdelivery is not None and lfdelivery not in (AT_MOST_ONCE, AT_LEAST_ONCE):
        raise bad("lfdelivery")
    lfenc = read("lfenc", False)
    if lfenc is not None and lfenc != ENC_AES_GCM:
        raise EnvelopeError(f'lfenc "{lfenc}" is not supported', "unsupported")
    if (lfenc is not None) != (datacontenttype == ENCRYPTED_CONTENT_TYPE):
        raise bad("lfenc", "does not match datacontenttype")
    lferror = read("lferror", False, _LFERROR_RE)
    attributes = Attributes(
        specversion=CE_SPECVERSION,
        id=read("id", True, _ID_RE) or "",
        source=read("source", True, _SOURCE_RE) or "",
        type=type_,
        time=read("time", True, _TIME_RE) or "",
        datacontenttype=datacontenttype,
    )
    for name, pattern, maximum in _OPTIONAL:
        value = read(name, False, pattern, maximum)
        if value is not None:
            setattr(attributes, name, value)
    attributes.lfdelivery = lfdelivery
    attributes.lfenc = lfenc
    attributes.lferror = lferror
    if attributes.lfsig and not _HEX_RE.match(attributes.lfsig):
        raise bad("lfsig")
    return attributes


def size_of(wire: WireEvent) -> WireSize:
    """Headers (names and values as UTF-8) plus body bytes."""
    header_bytes = sum(len(name.encode()) + len(value.encode()) for name, value in wire.headers.items())
    return WireSize(header_bytes, len(wire.body), header_bytes + len(wire.body))


def encode_wire(event: RawEvent, mode: str) -> tuple[WireEvent, WireSize]:
    """Encode a raw event (already sealed) for the wire in ``binary`` or ``structured`` mode."""
    headers = event.attributes.headers()
    if mode == "binary":
        headers["content-type"] = event.attributes.datacontenttype
        wire = WireEvent(headers, event.body)
        return wire, size_of(wire)
    document: dict[str, Any] = dict(headers)
    if event.attributes.lfenc:
        document["data_base64"] = base64.b64encode(event.body).decode("ascii")
    else:
        document["data"] = None if len(event.body) == 0 else json.loads(event.body.decode("utf-8"))
    wire = WireEvent({"content-type": STRUCTURED_CONTENT_TYPE}, json_stringify(document).encode("utf-8"))
    return wire, size_of(wire)


def decode_wire(wire: WireEvent, *, max_bytes: int | None = None, strict: bool = False) -> RawEvent:
    """Decode a wire event in either mode (binary when the headers carry ``specversion``) into attributes and body bytes.

    Validates strictly; raises ``EnvelopeError`` (the core drops such events and counts them).
    """
    size = size_of(wire)
    if max_bytes is not None and size.total_bytes > max_bytes:
        raise EnvelopeError(f"event is {size.total_bytes} bytes, over the limit of {max_bytes}", "too_large")
    headers = {name.lower(): value for name, value in wire.headers.items()}
    if "specversion" in headers:
        content_type = headers.pop("content-type", None)
        attributes = validate_attributes(headers, strict=strict)
        if content_type is not None and content_type.split(";")[0].strip() != attributes.datacontenttype:
            raise EnvelopeError("content-type does not match datacontenttype", "malformed")
        return RawEvent(attributes, wire.body)
    content_type = headers.get("content-type")
    if content_type is not None and not content_type.startswith("application/cloudevents+json"):
        raise EnvelopeError(f'content-type "{content_type}" is not a CloudEvents document', "unsupported")
    try:
        document = json.loads(wire.body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise EnvelopeError("structured event is not valid JSON", "malformed") from None
    if not isinstance(document, dict):
        raise EnvelopeError("structured event is not a JSON object", "malformed")
    data = document.pop("data", _MISSING)
    data_base64 = document.pop("data_base64", _MISSING)
    for name, value in document.items():
        if not isinstance(value, str):
            raise EnvelopeError(f'attribute "{name}" is not a string', "malformed")
    attributes = validate_attributes(document, strict=strict)
    if attributes.lfenc:
        if not isinstance(data_base64, str) or data is not _MISSING:
            raise EnvelopeError("an encrypted structured event carries data_base64 only", "malformed")
        try:
            body = base64.b64decode(data_base64, validate=True)
        except ValueError:
            raise EnvelopeError("data_base64 is not base64", "malformed") from None
    else:
        if data_base64 is not _MISSING:
            raise EnvelopeError("a plain structured event carries data, not data_base64", "malformed")
        body = b"" if data is _MISSING or data is None else serialize_body(data)
    return RawEvent(attributes, body)


_MISSING = object()


def parse_body(body: bytes) -> Any:
    """Parse a plain (decrypted) body as JSON; an empty body is ``None``."""
    if len(body) == 0:
        return None
    try:
        return json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise EnvelopeError("body is not valid JSON", "malformed") from None


def serialize_body(data: Any) -> bytes:
    """``JSON.stringify``-compatible bytes for a JSON value (``bytes`` pass through as already serialised JSON)."""
    if isinstance(data, (bytes, bytearray)):
        return bytes(data)
    return json_stringify(data).encode("utf-8")


def new_event_id() -> str:
    """A fresh event id: 32 hex characters (128 random bits)."""
    return secrets.token_hex(16)


def now_ms() -> int:
    """The wall clock in epoch milliseconds (what ``lfdeadline`` and ``time`` are made of)."""
    import time

    return int(time.time() * 1000)


def format_time(epoch_ms: int) -> str:
    """RFC 3339 with milliseconds and ``Z``, as ``Date.prototype.toISOString`` writes it."""
    dt = datetime.fromtimestamp(epoch_ms / 1000, tz=timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{epoch_ms % 1000:03d}Z"


def parse_time_ms(value: str) -> int | None:
    """An RFC 3339 timestamp as epoch milliseconds; ``None`` when it does not parse."""
    text = value.strip()
    if text.endswith("Z") or text.endswith("z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(round(dt.timestamp() * 1000))


def subject_of(method: str, body: Any) -> str | None:
    """``node.type`` of an Execute/webhook body, or the ``nodeType`` of LoadOptions: the event's ``subject``."""
    if not isinstance(body, dict):
        return None
    if method == "LoadOptions":
        node_type = body.get("nodeType")
        return node_type if isinstance(node_type, str) else None
    node = body.get("node")
    if isinstance(node, dict) and isinstance(node.get("type"), str):
        return node["type"]
    return None


# --- JSON.stringify ----------------------------------------------------------------------------------------------------

_ESCAPES = {'"': '\\"', "\\": "\\\\", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t"}


def _js_string(value: str) -> str:
    out = ['"']
    for ch in value:
        escaped = _ESCAPES.get(ch)
        if escaped is not None:
            out.append(escaped)
        elif ch < " " or "\ud800" <= ch <= "\udfff":
            out.append(f"\\u{ord(ch):04x}")
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def js_number(value: float) -> str:
    """A finite float as ``Number.prototype.toString`` prints it (shortest round-trip digits, JS exponent rules)."""
    if value == 0:
        return "0"
    text = repr(float(value))
    negative = text.startswith("-")
    if negative:
        text = text[1:]
    mantissa, _, exponent = text.partition("e")
    whole, _, frac = mantissa.partition(".")
    digits = (whole + frac).lstrip("0")
    # Decimal point position relative to the first significant digit.
    point = len(whole) - (len(whole + frac) - len((whole + frac).lstrip("0"))) + (int(exponent) if exponent else 0)
    digits = digits.rstrip("0") or "0"
    k = len(digits)
    n = point
    if k <= n <= 21:
        body = digits + "0" * (n - k)
    elif 0 < n <= 21:
        body = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        body = "0." + "0" * (-n) + digits
    else:
        e = n - 1
        sign = "+" if e >= 0 else "-"
        body = (digits[0] + ("." + digits[1:] if k > 1 else "")) + "e" + sign + str(abs(e))
    return ("-" if negative else "") + body


def json_stringify(value: Any) -> str:
    """``JSON.stringify(value)``: compact, UTF-8 (no ``\\uXXXX`` for non-ASCII), integral floats without ``.0``,
    non-finite numbers as ``null``. Dict keys keep their order (as a JSON parser preserves it)."""
    parts: list[str] = []
    _stringify(value, parts)
    return "".join(parts)


def _stringify(value: Any, out: list[str]) -> None:
    if value is None:
        out.append("null")
    elif value is True:
        out.append("true")
    elif value is False:
        out.append("false")
    elif isinstance(value, int):
        out.append(str(value))
    elif isinstance(value, float):
        out.append("null" if math.isnan(value) or math.isinf(value) else js_number(value))
    elif isinstance(value, str):
        out.append(_js_string(value))
    elif isinstance(value, dict):
        out.append("{")
        first = True
        for key, item in value.items():
            if not first:
                out.append(",")
            first = False
            out.append(_js_string(str(key)))
            out.append(":")
            _stringify(item, out)
        out.append("}")
    elif isinstance(value, (list, tuple)):
        out.append("[")
        for index, item in enumerate(value):
            if index:
                out.append(",")
            _stringify(item, out)
        out.append("]")
    else:
        raise TypeError(f"{type(value).__name__} is not JSON-serialisable")
