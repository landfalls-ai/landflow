"""The plugin side of generic messaging: ``MessagingServer`` consumes a plugin's request channel over one broker
connection and hands each call to a dispatcher (docs/protocol.md §14.4–§14.8; the counterpart of
``packages/transports/src/server.ts`` and ``sdks/go/transport/server.go``).

Delivery rules, all implemented here and never in drivers:

- **At most once by default**: an ``Execute`` is acknowledged before it runs. **At least once** (acknowledge after the
  reply) only when the host asked for it (``lfdelivery``) **and** the work is safe to repeat: every method but Execute,
  an Execute of a node (or operation) the manifest marks ``idempotent``, or one with an ``idempotencyKey``.
- **Deadlines** (``lfdeadline``) are checked before dispatch and again once the call has a slot: an expired request is
  acknowledged and dropped; a running call's ``CancelToken`` expires at the deadline and the response says ``expired``.
- **Concurrency**: prefetch = ``max_concurrency``, and a semaphore bounds dispatches to it whatever the driver does.
- **Version skew**: a request whose ``lfmanifest`` differs from this plugin's hash is put back once, then answered
  ``manifest_mismatch`` with this plugin's hash.
- **Cancel** events on the control channel cancel the call's token; a cancel that arrives first drops the call.
- **Announce** every 10 s on the registry channel (with a registry proof when ``LANDFLOW_REGISTRY_SECRET`` is set),
  withdraw and drain in-flight calls on ``stop()``.

**Threading.** ``on_request`` runs on the driver's handler thread, dispatches synchronously and returns once the reply
is out (so a driver that bounds concurrency by outstanding handlers sees the same limit as the semaphore). The
dispatcher callable gets a ``DispatchContext`` with a ``CancelToken`` the deadline and a host cancel both trip.
"""

from __future__ import annotations

import hashlib
import logging
import os
import secrets
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable

from ..dispatcher import CancelToken
from .channels import ChannelNames, broker_endpoint, control_spec, instance_spec, registry_spec, request_spec
from .codec import Codec
from .driver import BrokerDriver, ConsumeOptions, Delivery, PublishOptions, Subscription, WireEvent
from .envelope import (
    ANNOUNCE_TYPE,
    AT_LEAST_ONCE,
    AT_MOST_ONCE,
    WITHDRAW_TYPE,
    Attributes,
    EnvelopeError,
    json_stringify,
    now_ms,
    parse_type,
    plugin_source,
    response_type,
)
from .errors import UsageError
from .security import Keyring, ReplayGuard, registry_proof

log = logging.getLogger("landflow_sdk.transport")

PROTOCOL_VERSION = "landflow.plugin/v1"
DEFAULT_MAX_CONCURRENCY = 16
DEFAULT_HEARTBEAT_SECONDS = 10
DEFAULT_ANNOUNCE_TTL_SECONDS = 30
_CANCELLED_MEMORY_MS = 60_000


def manifest_hash_of(manifest: dict[str, Any]) -> str:
    """``sha256(JSON.stringify(manifest))[0..16]``, the same hash the host's registry computes."""
    return hashlib.sha256(json_stringify(manifest).encode("utf-8")).hexdigest()[:16]


def idempotency_from_manifest(manifest: dict[str, Any]) -> Callable[[Any], bool]:
    """Which nodes and operations a manifest marks ``idempotent`` (the operation option wins over the node)."""
    plugin_id = (manifest.get("plugin") or {}).get("id", "")
    nodes = {f"{plugin_id}.{node.get('name')}": node for node in manifest.get("nodes") or [] if isinstance(node, dict)}

    def check(request: Any) -> bool:
        if not isinstance(request, dict):
            return False
        node = nodes.get(((request.get("node") or {}).get("type")) or "")
        if node is None:
            return False
        operation = (request.get("parameters") or {}).get("operation") if isinstance(request.get("parameters"), dict) else None
        for prop in node.get("properties") or []:
            if isinstance(prop, dict) and prop.get("name") == "operation":
                for option in prop.get("options") or []:
                    if isinstance(option, dict) and option.get("value") == operation and "idempotent" in option:
                        return bool(option["idempotent"])
        return bool(node.get("idempotent", False))

    return check


@dataclass
class DispatchContext:
    call_id: str
    #: Epoch ms; ``cancel`` trips when it passes.
    deadline_ms: int | None
    cancel: CancelToken
    idempotency_key: str | None
    #: The broker's delivery attempt (1 on the first).
    attempt: int
    delivery: str
    traceparent: str | None
    tracestate: str | None
    #: The host that called, ``landflow://host/<instanceId>``.
    source: str
    channel: str = ""


#: Runs one logical RPC: ``(method, body, context) -> response body``; raise ``DispatchError`` for a coded failure.
Dispatcher = Callable[[str, Any, DispatchContext], Any]


class DispatchError(Exception):
    """A failure with a code the host can act on (``not_found`` for an unknown node, ``bad_request`` for an invalid body…)."""

    def __init__(self, message: str, code: str = "internal", details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.details = details


class _HostCancelToken(CancelToken):
    """A ``CancelToken`` that remembers whether the host (not the deadline) cancelled it."""

    __slots__ = ("host_cancelled",)

    def __init__(self, deadline: float | None) -> None:
        super().__init__(deadline)
        self.host_cancelled = False

    def cancel(self, reason: str | None = None) -> None:
        self.host_cancelled = True
        super().cancel(reason)


@dataclass
class _InFlight:
    token: _HostCancelToken
    done: threading.Event


class MessagingServer:
    def __init__(
        self,
        *,
        driver: BrokerDriver,
        config: Any,
        keyring: Keyring,
        plugin_id: str,
        version: str,
        manifest: dict[str, Any] | None = None,
        manifest_hash: str | None = None,
        dispatch: Dispatcher,
        is_idempotent: Callable[[Any], bool] | None = None,
        max_concurrency: int | None = None,
        instance_id: str | None = None,
        transports: list[str] | None = None,
        announce_interval_ms: int | None = None,
        ttl_seconds: int | None = None,
        registry_secret: str | None | bool = None,
        drain_timeout_ms: int = 30_000,
        clock_skew_ms: int | None = None,
        now: Callable[[], int] | None = None,
        logger: logging.Logger | None = None,
    ) -> None:
        if manifest is None and manifest_hash is None:
            raise UsageError("MessagingServer needs a manifest or its hash")
        self.driver = driver
        self.config = config
        self.plugin_id = plugin_id
        self.version = version
        self.instance_id = instance_id or secrets.token_hex(16)
        self.manifest_hash = manifest_hash or manifest_hash_of(manifest or {})
        self.names = ChannelNames(getattr(config, "prefix", None))
        self.endpoint = broker_endpoint(driver.kind, getattr(config, "connection_id", "env"), plugin_id)
        self.dispatch = dispatch
        self.transports = transports
        self.log = logger or log
        self.now = now or now_ms
        self.codec = Codec(keyring, driver.capabilities, clock_skew_ms=clock_skew_ms, replay=ReplayGuard(), now=self.now)
        self.is_idempotent = is_idempotent or (idempotency_from_manifest(manifest) if manifest is not None else (lambda _r: False))
        self.max_concurrency = max_concurrency or (manifest or {}).get("maxConcurrency") or DEFAULT_MAX_CONCURRENCY
        if registry_secret is None:
            registry_secret = os.environ.get("LANDFLOW_REGISTRY_SECRET") or None
        self.registry_secret: str | None = registry_secret if isinstance(registry_secret, str) and registry_secret else None
        self.announce_interval_ms = announce_interval_ms or DEFAULT_HEARTBEAT_SECONDS * 1000
        self.ttl_seconds = ttl_seconds or DEFAULT_ANNOUNCE_TTL_SECONDS
        self.drain_timeout_ms = drain_timeout_ms
        self._lock = threading.Lock()
        self._in_flight: dict[str, _InFlight] = {}
        self._cancelled: dict[str, int] = {}
        self._slots = threading.Semaphore(self.max_concurrency)
        self._subscriptions: list[Subscription] = []
        self._stop = threading.Event()
        self._heartbeat: threading.Thread | None = None
        self.state = "new"
        #: Counters for tests and metrics.
        self.counters = {"received": 0, "dispatched": 0, "replied": 0, "dropped": 0, "expired": 0, "mismatched": 0, "requeued": 0, "cancelled": 0, "announces": 0}

    @property
    def in_flight_count(self) -> int:
        return len(self._in_flight)

    def _count(self, name: str) -> None:
        with self._lock:
            self.counters[name] += 1

    # ------------------------------------------------------------------ lifecycle

    def start(self) -> None:
        if self.state != "new":
            raise UsageError(f"server already {self.state}")
        self.driver.connect(self.config)
        request = self.names.request(self.plugin_id)
        instance = self.names.instance(self.plugin_id, self.instance_id)
        control = self.names.control(self.plugin_id)
        registry = self.names.registry()
        self.driver.declare([request_spec(request), instance_spec(instance), control_spec(control), registry_spec(registry)])
        self.request_channel = request
        self._subscriptions = [
            self.driver.consume(control, ConsumeOptions(prefetch=256, ack_mode="auto"), lambda wire, _d: self._on_control(wire)),
            self.driver.consume(request, ConsumeOptions(prefetch=self.max_concurrency, ack_mode="manual", group=request), self._on_request),
            self.driver.consume(instance, ConsumeOptions(prefetch=self.max_concurrency, ack_mode="manual", group=instance), self._on_request),
        ]
        self.state = "started"
        self.announce()
        self._heartbeat = threading.Thread(target=self._heartbeat_loop, name=f"landflow-announce-{self.plugin_id}", daemon=True)
        self._heartbeat.start()

    def _heartbeat_loop(self) -> None:
        while not self._stop.wait(self.announce_interval_ms / 1000):
            self.announce()

    def stop(self) -> None:
        """Stop taking calls, withdraw, wait for the calls in flight (up to ``drain_timeout_ms``), close."""
        if self.state in ("stopped", "draining"):
            return
        self.state = "draining"
        self._stop.set()
        self._withdraw()
        with self._lock:
            in_flight = list(self._in_flight.values())
        if in_flight:
            until = time.monotonic() + self.drain_timeout_ms / 1000
            for entry in in_flight:
                entry.done.wait(max(0.0, until - time.monotonic()))
            with self._lock:
                remaining = list(self._in_flight.values())
            for entry in remaining:
                entry.token.cancel("plugin stopping")
        for subscription in self._subscriptions:
            try:
                subscription.close()
            except Exception as exc:  # noqa: BLE001
                self.log.warning("closing a subscription failed: %s", exc)
        self._subscriptions = []
        self.state = "stopped"
        self.driver.close()

    # ------------------------------------------------------------------- announce

    def announce(self) -> None:
        """Publish an announce now (the heartbeat thread does it every ``announce_interval_ms``)."""
        if self.state != "started":
            return
        try:
            attributes = self.codec.base(plugin_source(self.plugin_id, self.instance_id), ANNOUNCE_TYPE, lfmanifest=self.manifest_hash)
            body: dict[str, Any] = {
                "protocol": PROTOCOL_VERSION,
                "pluginId": self.plugin_id,
                "version": self.version,
                "instanceId": self.instance_id,
                "manifestHash": self.manifest_hash,
                "endpoint": self.endpoint,
                "maxConcurrency": self.max_concurrency,
                "ttlSeconds": self.ttl_seconds,
            }
            if self.transports:
                body["transports"] = list(self.transports)
            if self.registry_secret:
                body["registryProof"] = registry_proof(self.registry_secret, self.plugin_id, attributes.id)
            packed = self.codec.pack(self.plugin_id, attributes, body, False)
            self.driver.publish(self.names.registry(), packed.wire, PublishOptions(ttl_ms=60_000))
            self._count("announces")
        except Exception as exc:  # noqa: BLE001
            self.log.warning("announce failed: %s", exc)

    def _withdraw(self) -> None:
        try:
            attributes = self.codec.base(plugin_source(self.plugin_id, self.instance_id), WITHDRAW_TYPE)
            body = {"pluginId": self.plugin_id, "instanceId": self.instance_id, "endpoint": self.endpoint}
            packed = self.codec.pack(self.plugin_id, attributes, body, False)
            self.driver.publish(self.names.registry(), packed.wire, PublishOptions(ttl_ms=60_000))
        except Exception as exc:  # noqa: BLE001
            self.log.warning("withdraw failed: %s", exc)

    # ------------------------------------------------------------------- requests

    def _on_request(self, wire: WireEvent, delivery: Delivery) -> None:
        self._count("received")

        def drop(why: str, **fields: Any) -> None:
            self._count("dropped")
            self.log.warning("dropped a request: %s %s", why, fields)
            delivery.nack(requeue=False)

        try:
            raw = self.codec.peek(wire)
        except Exception as exc:  # noqa: BLE001
            return drop("malformed", error=str(exc))
        parsed = parse_type(raw.attributes.type)
        if parsed is None or parsed.kind != "request":
            return drop("not a request", type=raw.attributes.type)
        try:
            attributes, data = self.codec.unpack(raw, self.plugin_id)
        except Exception as exc:  # noqa: BLE001
            return drop("failed verification", id=raw.attributes.id, error=str(exc))
        method = parsed.method or ""

        def requeue() -> None:
            self.codec.forget_replay(attributes.id)
            self._count("requeued")
            delivery.nack(requeue=True)

        if self.state != "started":
            return requeue()
        now = self.now()
        deadline = attributes.deadline_ms()
        if deadline is not None and deadline <= now:
            self._count("expired")
            return delivery.ack()
        self._sweep_cancelled(now)
        if self._take_cancelled(attributes.id):
            self._count("cancelled")
            return delivery.ack()
        if attributes.lfmanifest and attributes.lfmanifest != self.manifest_hash:
            self._count("mismatched")
            if delivery.attempt < 2 and self.driver.capabilities.nack:
                return requeue()
            delivery.ack()
            self._reply(attributes, delivery, {"error": f"manifest mismatch: this plugin runs {self.manifest_hash}", "manifestHash": self.manifest_hash}, "manifest_mismatch")
            return
        requested = attributes.lfdelivery or (AT_MOST_ONCE if method == "Execute" else AT_LEAST_ONCE)
        repeatable = method != "Execute" or bool(attributes.lfidempotency) or self._safe_to_repeat(data)
        mode = AT_LEAST_ONCE if requested == AT_LEAST_ONCE and repeatable else AT_MOST_ONCE

        # A slot; while waiting, a stopping plugin hands the request back.
        while not self._slots.acquire(timeout=0.1):
            if self.state != "started":
                return requeue()
        try:
            if self.state != "started":
                return requeue()
            started = self.now()
            if self._take_cancelled(attributes.id):
                self._count("cancelled")
                return delivery.ack()
            if deadline is not None and deadline <= started:
                self._count("expired")
                return delivery.ack()
            if mode == AT_MOST_ONCE:
                delivery.ack()
            token = _HostCancelToken(time.monotonic() + (deadline - started) / 1000 if deadline is not None else None)
            entry = _InFlight(token, threading.Event())
            with self._lock:
                self._in_flight[attributes.id] = entry
            try:
                sent = self._run(method, data, attributes, delivery, token, mode)
            finally:
                with self._lock:
                    self._in_flight.pop(attributes.id, None)
                entry.done.set()
            if mode == AT_LEAST_ONCE:
                if sent:
                    delivery.ack()
                else:
                    requeue()
        finally:
            self._slots.release()

    def _run(self, method: str, data: Any, attributes: Attributes, delivery: Delivery, token: _HostCancelToken, mode: str) -> bool:
        self._count("dispatched")
        code: str | None = None
        context = DispatchContext(
            call_id=attributes.id, deadline_ms=attributes.deadline_ms(), cancel=token, idempotency_key=attributes.lfidempotency,
            attempt=delivery.attempt, delivery=mode, traceparent=attributes.traceparent, tracestate=attributes.tracestate,
            source=attributes.source, channel=self.request_channel,
        )
        try:
            body = self.dispatch(method, data, context)
        except Exception as exc:  # noqa: BLE001
            if token.is_set():
                # The deadline makes it `expired`; the host's cancel and a stopping plugin make it `cancelled`.
                code = "cancelled" if token.host_cancelled else ("expired" if token.expired() else "cancelled")
                body = {"error": token.reason or code}
            elif isinstance(exc, DispatchError):
                code = exc.code
                body = {"error": str(exc), **(exc.details or {})}
            else:
                code = "internal"
                body = {"error": str(exc) or type(exc).__name__}
                self.log.exception("dispatch of %s failed", method)
        return self._reply(attributes, delivery, body, code)

    def _safe_to_repeat(self, data: Any) -> bool:
        try:
            return bool(self.is_idempotent(data))
        except Exception:  # noqa: BLE001
            return False

    def _reply(self, request: Attributes, delivery: Delivery, body: Any, code: str | None) -> bool:
        """Send a response; ``False`` when it could not be sent (the host gets its deadline)."""
        parsed = parse_type(request.type)
        if parsed is None or parsed.kind != "request":
            return False
        deadline = request.deadline_ms()
        if deadline is not None and deadline <= self.now():
            self._count("expired")
            return True
        native = self.driver.capabilities.replies == "native"
        if not native and not request.lfreplyto:
            self.log.warning("request %s has no lfreplyto and the broker has no native replies", request.id)
            return False
        attributes = self.codec.base(
            plugin_source(self.plugin_id, self.instance_id), response_type(parsed.method or ""),
            lfcorrelation=request.id, lfmanifest=self.manifest_hash, subject=request.subject, traceparent=request.traceparent,
            tracestate=request.tracestate, lferror=code,
        )
        try:
            packed = self.codec.pack(self.plugin_id, attributes, body, True)
        except EnvelopeError as exc:
            if exc.reason != "too_large":
                raise
            attributes.lferror = "too_large"
            packed = self.codec.pack(self.plugin_id, attributes, {"error": str(exc)}, True)
        try:
            if native:
                delivery.reply(packed.wire)
            else:
                self.driver.publish(request.lfreplyto or "", packed.wire, PublishOptions(ttl_ms=5 * 60_000))
            self._count("replied")
            return True
        except Exception as exc:  # noqa: BLE001
            self.log.warning("reply to %s could not be published: %s", request.id, exc)
            return False

    # -------------------------------------------------------------------- control

    def _on_control(self, wire: WireEvent) -> None:
        try:
            raw = self.codec.peek(wire)
        except Exception:  # noqa: BLE001
            return
        parsed = parse_type(raw.attributes.type)
        if parsed is None or parsed.kind != "cancel" or not raw.attributes.lfcorrelation:
            return
        try:
            self.codec.unpack(raw, self.plugin_id, replay=False)
        except Exception as exc:  # noqa: BLE001
            self.log.warning("ignored a cancel that failed verification: %s", exc)
            return
        call_id = raw.attributes.lfcorrelation
        with self._lock:
            entry = self._in_flight.get(call_id)
            if entry is None:
                self._sweep_cancelled(self.now())
                self._cancelled[call_id] = self.now() + _CANCELLED_MEMORY_MS
                return
            self.counters["cancelled"] += 1
        entry.token.cancel("cancelled by the host")

    def _take_cancelled(self, call_id: str) -> bool:
        with self._lock:
            return self._cancelled.pop(call_id, None) is not None

    def _sweep_cancelled(self, now: int) -> None:
        with self._lock:
            for call_id, expires in list(self._cancelled.items()):
                if expires <= now:
                    del self._cancelled[call_id]
