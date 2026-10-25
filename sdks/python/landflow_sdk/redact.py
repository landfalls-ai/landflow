"""Secret redaction for log lines and span attributes (docs/observability.md §3).

Two rules, applied to every log line and span attribute the SDK writes:

* **by key**: an attribute whose key matches ``SECRET_KEY_RE`` (token, secret,
  password, authorization, api key, cookie) has its string value replaced.
  Numbers and booleans are kept, so ``gen_ai.usage.input_tokens=12`` survives.
* **by value**: while a request runs, the credential values it carries are
  registered with ``secret_scope``; any occurrence of them in a message or a
  string attribute (a token embedded in a URL, an error text...) is replaced.
"""

from __future__ import annotations

import contextvars
import re
import urllib.parse
from contextlib import contextmanager
from typing import Any, Iterable, Iterator, Mapping

REDACTED = "[REDACTED]"
# Names of addresses and kinds (tokenUrl, tokenType) are not secrets.
SECRET_KEY_RE = re.compile(r"^(?!.*(?:url|uri|endpoint|host|type)$).*(?:token|secret|password|authorization|api[-_]?key|cookie)", re.IGNORECASE)
MIN_SECRET_LENGTH = 4  # shorter values are only redacted by key, never by substring

_secrets: contextvars.ContextVar[tuple[str, ...]] = contextvars.ContextVar("landflow_secrets", default=())


@contextmanager
def secret_scope(values: Iterable[str]) -> Iterator[None]:
    """Redact ``values`` (and their URL-encoded forms) from everything logged in this context."""
    fresh = set(_secrets.get())
    for value in values:
        if isinstance(value, str) and len(value) >= MIN_SECRET_LENGTH:
            fresh.add(value)
            quoted = urllib.parse.quote(value, safe="")
            if quoted != value:
                fresh.add(quoted)
    token = _secrets.set(tuple(sorted(fresh, key=len, reverse=True)))  # longest first
    try:
        yield
    finally:
        _secrets.reset(token)


def active_secrets() -> tuple[str, ...]:
    return _secrets.get()


def redact_text(text: str) -> str:
    """Replace every registered secret value in ``text``."""
    secrets = _secrets.get()
    if not secrets or not text:
        return text
    for secret in secrets:
        if secret in text:
            text = text.replace(secret, REDACTED)
    return text


def is_secret_key(key: str) -> bool:
    return bool(SECRET_KEY_RE.search(key))


def redact_value(key: str, value: Any) -> Any:
    if isinstance(value, (bool, int, float)) or value is None:
        return value
    if is_secret_key(key):
        return REDACTED
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, Mapping):
        return redact_attributes(value)
    if isinstance(value, (list, tuple)):
        return [redact_value(key, v) for v in value]
    return redact_text(str(value))


def redact_attributes(attributes: Mapping[str, Any] | None) -> dict[str, Any]:
    """A redacted copy of ``attributes`` (nested mappings are walked)."""
    if not attributes:
        return {}
    return {str(key): redact_value(str(key), value) for key, value in attributes.items()}


def collect_strings(value: Any) -> Iterator[str]:
    """Every string inside a JSON-like value (used to register whole secret fields)."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, Mapping):
        for v in value.values():
            yield from collect_strings(v)
    elif isinstance(value, (list, tuple)):
        for v in value:
            yield from collect_strings(v)
