"""``Dispatcher``: the transport-neutral core every binding calls, plus ``CancelToken``.

The HTTP and gRPC servers (and broker or MCP bindings) convert their wire format into the protocol
dicts and hand them to one ``Dispatcher``, which applies the call's deadline and cancellation, the
plugin's concurrency limit (``max_concurrency``), then runs the plugin's handler logic (spans,
metrics, redaction, credentials, idempotency key) and the node. Node code sees the call's
``CancelToken`` as ``ctx.cancel`` (``ctx.cancel.is_set()``, ``ctx.cancel.check()``,
``ctx.cancel.remaining()``), so a long loop can stop when the caller went away or the deadline passed.
"""

from __future__ import annotations

import os
import threading
import time
from typing import Any

from .errors import ProtocolError
from .plugin import Plugin


class CallCancelledError(Exception):
    """The call was cancelled or its deadline passed before (or while) it ran.

    Raised by ``CancelToken.check()`` inside node code and by the dispatcher when a call's deadline
    is already over when it arrives. Transports answer HTTP 504 / gRPC ``DEADLINE_EXCEEDED`` (deadline)
    or 503 / ``CANCELLED`` (cancelled).
    """

    def __init__(self, message: str, *, deadline: bool = False) -> None:
        super().__init__(message)
        self.deadline = deadline


class OverloadedError(Exception):
    """No concurrency slot became free before the call's deadline (HTTP 503 / gRPC ``RESOURCE_EXHAUSTED``)."""


class CancelToken:
    """Cancellation and deadline of one call (the Python counterpart of Go's ``context.Context``).

    ``deadline`` is a ``time.monotonic()`` instant (``None`` = none). ``cancel()`` is called by the
    binding when its caller goes away; ``is_set()`` is also true once the deadline passed.
    """

    __slots__ = ("_event", "_reason", "deadline")

    def __init__(self, deadline: float | None = None, *, timeout: float | None = None) -> None:
        if timeout is not None:
            deadline = time.monotonic() + max(timeout, 0.0)
        self.deadline = deadline
        self._event = threading.Event()
        self._reason: str | None = None

    @classmethod
    def never(cls) -> CancelToken:
        """A token that never cancels (what node code sees when the binding gives none)."""
        return _NeverCancelled()

    def cancel(self, reason: str | None = None) -> None:
        """Mark the call cancelled (idempotent)."""
        if not self._event.is_set():
            self._reason = reason or "call cancelled"
            self._event.set()

    def is_set(self) -> bool:
        """True once cancelled or past the deadline."""
        return self._event.is_set() or self.expired()

    cancelled = property(is_set)

    def expired(self) -> bool:
        """True once the deadline passed."""
        return self.deadline is not None and time.monotonic() >= self.deadline

    def remaining(self) -> float | None:
        """Seconds until the deadline (``None`` without one, never negative)."""
        if self.deadline is None:
            return None
        return max(0.0, self.deadline - time.monotonic())

    def wait(self, timeout: float | None = None) -> bool:
        """Block until cancelled, the deadline passes or ``timeout`` elapses; returns ``is_set()``."""
        remaining = self.remaining()
        if remaining is not None and (timeout is None or remaining < timeout):
            timeout = remaining
        self._event.wait(timeout)
        return self.is_set()

    @property
    def reason(self) -> str | None:
        """Why the call ended early (``None`` while it runs)."""
        if self._event.is_set():
            return self._reason
        if self.expired():
            return "deadline exceeded"
        return None

    def check(self) -> None:
        """Raise ``CallCancelledError`` when the call should stop (call it in long loops)."""
        if self._event.is_set():
            raise CallCancelledError(self._reason or "call cancelled")
        if self.expired():
            raise CallCancelledError("deadline exceeded", deadline=True)

    def __repr__(self) -> str:
        return f"CancelToken(set={self.is_set()}, remaining={self.remaining()})"


class _NeverCancelled(CancelToken):
    __slots__ = ()

    def cancel(self, reason: str | None = None) -> None:  # noqa: ARG002 - shared instance, never cancelled
        pass


NEVER_CANCELLED: CancelToken = CancelToken.never()


def max_concurrency_from_env(fallback: int | None) -> int | None:
    """``LANDFLOW_MAX_CONCURRENCY`` (``0``/empty = fallback; ``None`` = unlimited)."""
    raw = os.environ.get("LANDFLOW_MAX_CONCURRENCY", "").strip()
    if not raw:
        return fallback if fallback else None
    try:
        value = int(raw)
    except ValueError:
        raise ValueError(f"LANDFLOW_MAX_CONCURRENCY must be a non-negative integer, got {raw!r}") from None
    if value < 0:
        raise ValueError(f"LANDFLOW_MAX_CONCURRENCY must be a non-negative integer, got {raw!r}")
    return value or None


class Dispatcher:
    """One per plugin (``plugin.dispatcher``); ``PluginServer`` configures it with ``max_concurrency``.

    Every method takes the protocol dict a binding decoded and the call's ``headers`` (W3C trace
    context), plus keyword-only ``cancel`` (a ``CancelToken``), ``deadline`` (``time.monotonic()``
    instant, added on top of the token's) and ``transport`` (the binding kind, recorded as the span
    attribute ``landflow.transport``). ``in_flight`` and ``waiting`` are live counts.
    """

    def __init__(self, plugin: Plugin, max_concurrency: int | None = None) -> None:
        self.plugin = plugin
        self.max_concurrency: int | None = max_concurrency if max_concurrency and max_concurrency > 0 else None
        self._lock = threading.Condition()
        self._in_flight = 0
        self._waiting = 0

    @property
    def in_flight(self) -> int:
        with self._lock:
            return self._in_flight

    @property
    def waiting(self) -> int:
        with self._lock:
            return self._waiting

    # ------------------------------------------------------------ cheap calls

    def manifest(self) -> dict[str, Any]:
        return self.plugin.manifest()

    def well_known(self) -> dict[str, Any]:
        return self.plugin.well_known()

    def health(self) -> dict[str, Any]:
        return self.plugin.health()

    # ------------------------------------------------------------------ calls

    def execute(
        self,
        request: Any,
        headers: Any = None,
        *,
        cancel: CancelToken | None = None,
        deadline: float | None = None,
        transport: str | None = None,
    ) -> dict[str, Any]:
        """``ExecuteRequest`` dict -> ``ExecuteResponse`` dict (see ``Plugin.execute``)."""
        token = self._enter(cancel, deadline)
        try:
            return self.plugin.execute(request, headers, cancel=token, transport=transport)
        finally:
            self._leave()

    def load_options_request(
        self,
        request: Any,
        headers: Any = None,
        *,
        cancel: CancelToken | None = None,
        deadline: float | None = None,
        transport: str | None = None,
    ) -> dict[str, Any]:
        """``LoadOptionsRequest`` dict -> ``LoadOptionsResponse`` dict."""
        if not isinstance(request, dict):
            raise ProtocolError("request body must be a JSON object")
        token = self._enter(cancel, deadline)
        try:
            options = self.plugin.load_options(
                request.get("nodeType"), request.get("method"), request.get("parameters"), request.get("credentials"), headers,
                cancel=token, transport=transport,
            )
            return {"options": options}
        finally:
            self._leave()

    def test_credentials_request(
        self,
        request: Any,
        headers: Any = None,
        *,
        cancel: CancelToken | None = None,
        deadline: float | None = None,
        transport: str | None = None,
    ) -> dict[str, Any]:
        """``TestCredentialsRequest`` dict -> ``TestCredentialsResponse`` dict."""
        if not isinstance(request, dict):
            raise ProtocolError("request body must be a JSON object")
        token = self._enter(cancel, deadline)
        try:
            return self.plugin.test_credentials(
                request.get("credentialType"), request.get("data"), headers, cancel=token, transport=transport
            )
        finally:
            self._leave()

    def webhook_method(
        self,
        request: Any,
        headers: Any = None,
        *,
        cancel: CancelToken | None = None,
        deadline: float | None = None,
        transport: str | None = None,
    ) -> dict[str, Any]:
        """``WebhookMethodRequest`` dict -> ``WebhookMethodResponse`` dict."""
        token = self._enter(cancel, deadline)
        try:
            return self.plugin.webhook_method(request, headers, cancel=token, transport=transport)
        finally:
            self._leave()

    def receive_webhook(
        self,
        request: Any,
        headers: Any = None,
        *,
        cancel: CancelToken | None = None,
        deadline: float | None = None,
        transport: str | None = None,
    ) -> dict[str, Any]:
        """``WebhookRequest`` dict -> ``WebhookResponse`` dict."""
        token = self._enter(cancel, deadline)
        try:
            return self.plugin.receive_webhook(request, headers, cancel=token, transport=transport)
        finally:
            self._leave()

    # ---------------------------------------------------------------- slots

    def _enter(self, cancel: CancelToken | None, deadline: float | None) -> CancelToken:
        """Resolve the call's token and take a concurrency slot, waiting until the token ends."""
        token = cancel if cancel is not None else (CancelToken(deadline) if deadline is not None else NEVER_CANCELLED)
        if deadline is not None and cancel is not None and (cancel.deadline is None or deadline < cancel.deadline):
            token = _LinkedToken(cancel, deadline)
        token.check()
        with self._lock:
            if self.max_concurrency is not None and self._in_flight >= self.max_concurrency:
                self._waiting += 1
                try:
                    while self._in_flight >= self.max_concurrency:
                        remaining = token.remaining()
                        # Poll the token: a cancel() from another thread must wake us too.
                        self._lock.wait(min(remaining, 0.1) if remaining is not None else 0.1)
                        if token.is_set():
                            raise OverloadedError(
                                f"plugin is at its concurrency limit ({self._in_flight} in flight, limit {self.max_concurrency}): "
                                f"{token.reason}"
                            )
                finally:
                    self._waiting -= 1
            self._in_flight += 1
            count = self._in_flight
        self.plugin.telemetry.in_flight.set(count, {"landflow.plugin.id": self.plugin.id})
        return token

    def _leave(self) -> None:
        with self._lock:
            self._in_flight -= 1
            count = self._in_flight
            self._lock.notify()
        self.plugin.telemetry.in_flight.set(count, {"landflow.plugin.id": self.plugin.id})


class _LinkedToken(CancelToken):
    """A binding's token with an earlier deadline laid over it."""

    __slots__ = ("_parent",)

    def __init__(self, parent: CancelToken, deadline: float) -> None:
        super().__init__(deadline)
        self._parent = parent

    def is_set(self) -> bool:
        return self._parent.is_set() or super().is_set()

    cancelled = property(is_set)

    @property
    def reason(self) -> str | None:
        return self._parent.reason or super().reason

    def check(self) -> None:
        self._parent.check()
        super().check()

    def wait(self, timeout: float | None = None) -> bool:
        remaining = self.remaining()
        if remaining is not None and (timeout is None or remaining < timeout):
            timeout = remaining
        return self._parent.wait(timeout) or self.is_set()
