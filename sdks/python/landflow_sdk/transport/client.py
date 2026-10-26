"""The host side of generic messaging, in Python: ``MessagingClient`` calls plugins over one broker connection.

The Landflow host is TypeScript (``packages/transports/src/client.ts``); this client exists for the SDK's tests and
conformance suite, and for tooling that wants to call a brokered plugin from Python. It publishes a signed, encrypted
request on the plugin's request channel and correlates the reply (native request/reply or this client's reply channel),
fails the call at the deadline, sends a cancel event on the control channel when the caller cancels, and discovers
plugins on the registry channel.
"""

from __future__ import annotations

import logging
import os
import secrets
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable

from ..dispatcher import CancelToken
from .channels import ChannelNames, broker_endpoint, control_spec, instance_spec, registry_spec, reply_spec, request_spec
from .claim import DEFAULT_CLAIM_TTL_MS, ClaimError, ClaimStore, start_claim_sweeper
from .codec import Codec, is_drop_reason
from .driver import BrokerDriver, ChannelSpec, ChannelStats, ConsumeOptions, Delivery, NotConnectedError, PublishOptions, Subscription, WireEvent
from .envelope import AT_LEAST_ONCE, AT_MOST_ONCE, CANCEL_TYPE, Attributes, EnvelopeError, host_source, now_ms, parse_plugin_source, parse_type, request_type, subject_of
from .errors import CancelledError, ClaimUnavailableError, ConnectionLostError, ManifestMismatchError, RemoteError, TimeoutError_, UndeliverableError, UsageError
from .security import Keyring, verify_registry_proof
from .server import DEFAULT_ANNOUNCE_TTL_SECONDS

log = logging.getLogger("landflow_sdk.transport")

DEFAULT_CALL_TIMEOUT_MS = 30_000
DEFAULT_STATS_INTERVAL_MS = 5_000


@dataclass
class AnnouncedInstance:
    instance_id: str
    version: str
    manifest_hash: str
    max_concurrency: int | None
    last_seen: int
    expires_at: int


@dataclass
class AnnouncedPlugin:
    plugin_id: str
    version: str
    manifest_hash: str
    endpoint: str
    instances: list[AnnouncedInstance] = field(default_factory=list)
    last_seen: int = 0


@dataclass
class PluginEvent:
    type: str  # announced | updated | withdrawn | expired
    plugin: AnnouncedPlugin
    instance_id: str


@dataclass
class CallReply:
    body: Any
    attributes: Attributes
    instance_id: str
    elapsed_ms: int


@dataclass
class _Pending:
    plugin_id: str
    method: str
    done: threading.Event = field(default_factory=threading.Event)
    reply: tuple[Attributes, Any] | None = None
    error: Exception | None = None

    def resolve(self, reply: tuple[Attributes, Any]) -> None:
        if not self.done.is_set():
            self.reply = reply
            self.done.set()

    def reject(self, error: Exception) -> None:
        if not self.done.is_set():
            self.error = error
            self.done.set()


class MessagingClient:
    def __init__(
        self,
        *,
        driver: BrokerDriver,
        config: Any,
        keyring: Keyring,
        host_instance_id: str | None = None,
        stats_interval_ms: int | None = None,
        clock_skew_ms: int | None = None,
        registry_secret: str | None | bool = None,
        discovery: bool = True,
        claims: ClaimStore | None = None,
        claim_ttl_ms: int = DEFAULT_CLAIM_TTL_MS,
        now: Callable[[], int] | None = None,
        logger: logging.Logger | None = None,
    ) -> None:
        self.driver = driver
        self.config = config
        self.host_instance_id = host_instance_id or secrets.token_hex(8)
        self.names = ChannelNames(getattr(config, "prefix", None))
        self.log = logger or log
        self.now = now or now_ms
        self.codec = Codec(keyring, driver.capabilities, clock_skew_ms=clock_skew_ms, now=self.now, claims=claims)
        self.claims = claims
        self.claim_ttl_ms = claim_ttl_ms
        if registry_secret is None:
            registry_secret = os.environ.get("LANDFLOW_REGISTRY_SECRET") or None
        self.registry_secret: str | None = registry_secret if isinstance(registry_secret, str) and registry_secret else None
        self.discovery = discovery
        self.stats_interval_ms = DEFAULT_STATS_INTERVAL_MS if stats_interval_ms is None else stats_interval_ms
        self._lock = threading.Lock()
        self._pending: dict[str, _Pending] = {}
        self._known: dict[str, tuple[AnnouncedPlugin, dict[str, AnnouncedInstance]]] = {}
        self._sampled: dict[str, tuple[ChannelStats, int]] = {}
        self._listeners: list[Callable[[PluginEvent], None]] = []
        self._declared: set[str] = set()
        self._subscriptions: list[Subscription] = []
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []
        self.state = "new"

    @property
    def kind(self) -> str:
        return self.driver.kind

    @property
    def connection_id(self) -> str:
        return getattr(self.config, "connection_id", "env")

    def endpoint_of(self, plugin_id: str) -> str:
        return broker_endpoint(self.driver.kind, self.connection_id, plugin_id)

    def start(self) -> None:
        if self.state != "new":
            raise UsageError(f"client already {self.state}")
        try:
            self.driver.connect(self.config)
        except Exception as exc:  # noqa: BLE001
            raise UndeliverableError(f'cannot connect to {self.driver.kind} "{self.connection_id}": {exc}', "not_connected") from exc
        specs: list[ChannelSpec] = []
        native = self.driver.capabilities.replies == "native"
        if not native:
            specs.append(reply_spec(self.names.reply(self.host_instance_id)))
        if self.discovery:
            specs.append(registry_spec(self.names.registry()))
        self.driver.declare(specs)
        self._declared.update(spec.name for spec in specs)
        if not native:
            self._subscriptions.append(self.driver.consume(self.names.reply(self.host_instance_id), ConsumeOptions(prefetch=1024, ack_mode="auto"), lambda wire, _d: self._on_reply(wire)))
        if self.discovery:
            self._subscriptions.append(self.driver.consume(self.names.registry(), ConsumeOptions(prefetch=1024, ack_mode="auto"), lambda wire, _d: self._on_registry(wire)))
            self._threads.append(threading.Thread(target=self._expiry_loop, name="landflow-client-expiry", daemon=True))
        if self.stats_interval_ms > 0:
            self._threads.append(threading.Thread(target=self._stats_loop, name="landflow-client-stats", daemon=True))
        if self.claims is not None:
            start_claim_sweeper(self.claims, self.claim_ttl_ms, self._stop, lambda exc: self.log.debug("claim sweep failed: %s", exc), self.now)
        self.state = "started"
        for thread in self._threads:
            thread.start()

    def close(self) -> None:
        """Fail the calls in flight, withdraw the subscriptions and close the connection."""
        if self.state == "closed":
            return
        self.state = "closed"
        self._stop.set()
        with self._lock:
            pending = list(self._pending.values())
            self._pending.clear()
        for entry in pending:
            entry.reject(ConnectionLostError("client closed; the call may have run"))
        for subscription in self._subscriptions:
            try:
                subscription.close()
            except Exception:  # noqa: BLE001
                pass
        self._subscriptions = []
        self.driver.close()

    # ------------------------------------------------------------------------ calls

    def call(self, plugin_id: str, method: str, body: Any, **options: Any) -> Any:
        """Call ``method`` on ``plugin_id`` and return the reply body. See ``invoke`` for the options."""
        return self.invoke(plugin_id, method, body, **options).body

    def invoke(
        self,
        plugin_id: str,
        method: str,
        body: Any,
        *,
        deadline_ms: int | None = None,
        timeout_ms: int | None = None,
        cancel: CancelToken | None = None,
        idempotency_key: str | None = None,
        delivery: str | None = None,
        ordering_key: str | None = None,
        manifest_hash: str | None = None,
        instance_id: str | None = None,
        traceparent: str | None = None,
        tracestate: str | None = None,
        attempt: int = 1,
    ) -> CallReply:
        if self.state != "started":
            raise UndeliverableError(f"client is {self.state}", "not_connected")
        if cancel is not None and cancel.is_set():
            raise UndeliverableError("aborted before publishing", "aborted")
        started_at = self.now()
        deadline = deadline_ms if deadline_ms is not None else started_at + (timeout_ms if timeout_ms is not None else DEFAULT_CALL_TIMEOUT_MS)
        if deadline <= started_at:
            raise TimeoutError_("the deadline had already passed", deadline)
        known = self._known.get(plugin_id)
        manifest_hash = manifest_hash or (known[0].manifest_hash if known else None)
        channel = self.names.instance(plugin_id, instance_id) if instance_id else self.names.request(plugin_id)
        native = self.driver.capabilities.replies == "native"
        attributes = self.codec.base(
            host_source(self.host_instance_id), request_type(method),
            lfdeadline=str(deadline), lfattempt=str(attempt), lfdelivery=delivery or (AT_MOST_ONCE if method == "Execute" else AT_LEAST_ONCE),
            lfreplyto=None if native else self.names.reply(self.host_instance_id), lfmanifest=manifest_hash, lfidempotency=idempotency_key,
            traceparent=traceparent, tracestate=tracestate, subject=subject_of(method, body),
        )
        try:
            packed = self.codec.pack_claimed(plugin_id, attributes, body, True)
        except EnvelopeError as exc:
            if exc.reason == "too_large":
                raise UndeliverableError(str(exc), "too_large") from exc
            raise
        except ClaimError as exc:
            raise UndeliverableError(str(exc), "claim_failed") from exc
        succeeded = False
        try:
            reply = self._exchange(plugin_id, method, packed, known, manifest_hash, channel, native, started_at, deadline, ordering_key, instance_id, cancel)
            succeeded = True
            return reply
        finally:
            # A call that did not get its reply never reached the receiver's ack: nobody else will delete the request body.
            if not succeeded and packed.claim_key and self.claims is not None:
                self._drop_claim(packed.claim_key)

    def _drop_claim(self, key: str) -> None:
        try:
            self.claims.delete(key)  # type: ignore[union-attr]
        except Exception as exc:  # noqa: BLE001
            self.log.debug("could not delete a claim %s: %s", key, exc)

    def _exchange(self, plugin_id: str, method: str, packed: Any, known: Any, manifest_hash: str | None, channel: str, native: bool, started_at: int, deadline: int,
                  ordering_key: str | None, instance_id: str | None, cancel: CancelToken | None) -> CallReply:
        if known and not known[1]:
            raise UndeliverableError(f'no instance of "{plugin_id}" has announced itself in the last {DEFAULT_ANNOUNCE_TTL_SECONDS} s', "no_consumers")
        sampled = self._sampled.get(plugin_id)
        if self.driver.capabilities.undeliverable == "inferred" and sampled and sampled[0].consumers == 0 and sampled[1] > started_at - 2 * DEFAULT_STATS_INTERVAL_MS:
            raise UndeliverableError(f'"{plugin_id}" has no consumers on {channel}', "no_consumers")
        self._declare_once(instance_spec(channel) if instance_id else request_spec(channel))
        call_id = packed.attributes.id
        pending = _Pending(plugin_id, method)
        with self._lock:
            self._pending[call_id] = pending
        timeout_s = (deadline - started_at) / 1000

        def publish() -> None:
            try:
                if native:
                    outcome = self.driver.request(channel, packed.wire, deadline - started_at, ordering_key)
                    if outcome.outcome == "unroutable":
                        raise UndeliverableError(f"nobody is consuming {channel}", "unroutable")
                    if outcome.outcome == "timeout":
                        raise TimeoutError_(f'no reply from "{plugin_id}" within {deadline - started_at} ms; the call may have run', deadline)
                    assert outcome.event is not None
                    self._on_reply(outcome.event, call_id)
                else:
                    if self.driver.publish(channel, packed.wire, PublishOptions(ordering_key=ordering_key, ttl_ms=deadline - started_at)) == "unroutable":
                        raise UndeliverableError(f"nobody is consuming {channel}", "unroutable")
            except (UndeliverableError, TimeoutError_) as exc:
                pending.reject(exc)
            except NotConnectedError as exc:
                pending.reject(UndeliverableError(f'not connected to {self.driver.kind} "{self.connection_id}": {exc}', "not_connected"))
            except Exception as exc:  # noqa: BLE001
                pending.reject(ConnectionLostError(f"publishing to {channel} failed: {exc}; the call may have run"))

        if native:
            threading.Thread(target=publish, name=f"landflow-request-{call_id[:8]}", daemon=True).start()
        else:
            publish()
        try:
            until = time.monotonic() + timeout_s
            while not pending.done.is_set():
                remaining = until - time.monotonic()
                if remaining <= 0:
                    pending.reject(TimeoutError_(f'no reply from "{plugin_id}" within {deadline - started_at} ms; the call may have run', deadline))
                    break
                if cancel is not None and cancel.is_set():
                    pending.reject(CancelledError())
                    self._send_cancel(plugin_id, call_id, cancel.reason)
                    break
                pending.done.wait(min(remaining, 0.02 if cancel is not None else remaining))
        finally:
            with self._lock:
                self._pending.pop(call_id, None)
        if pending.error is not None:
            raise pending.error
        assert pending.reply is not None
        reply_attributes, data = pending.reply
        source = parse_plugin_source(reply_attributes.source)
        if reply_attributes.lferror:
            details = data if isinstance(data, dict) else {}
            message = details.get("error") if isinstance(details.get("error"), str) else f"plugin answered {reply_attributes.lferror}"
            if reply_attributes.lferror == "claim_unavailable":
                raise ClaimUnavailableError(message, "request")
            if reply_attributes.lferror == "manifest_mismatch":
                raise ManifestMismatchError(manifest_hash, reply_attributes.lfmanifest or details.get("manifestHash"))
            raise RemoteError(message, reply_attributes.lferror, details)
        return CallReply(data, reply_attributes, source[1] if source else "", self.now() - started_at)

    # -------------------------------------------------------------------- discovery

    def plugins(self) -> list[AnnouncedPlugin]:
        self._expire_instances()
        with self._lock:
            return [entry[0] for entry in self._known.values()]

    def plugin(self, plugin_id: str) -> AnnouncedPlugin | None:
        self._expire_instances()
        entry = self._known.get(plugin_id)
        return entry[0] if entry else None

    def stats(self, plugin_id: str) -> ChannelStats | None:
        sampled = self._sampled.get(plugin_id)
        return sampled[0] if sampled else None

    def sample_stats(self) -> None:
        if self.state != "started":
            return
        for plugin_id in list(self._known):
            try:
                self._sampled[plugin_id] = (self.driver.stats(self.names.request(plugin_id)), self.now())
            except Exception as exc:  # noqa: BLE001
                self.log.debug("stats for %s failed: %s", plugin_id, exc)

    def on_plugin(self, listener: Callable[[PluginEvent], None]) -> Callable[[], None]:
        self._listeners.append(listener)
        return lambda: self._listeners.remove(listener)

    # --------------------------------------------------------------------- internals

    def _declare_once(self, spec: ChannelSpec) -> None:
        if spec.name in self._declared:
            return
        self.driver.declare([spec])
        self._declared.add(spec.name)

    def _send_cancel(self, plugin_id: str, call_id: str, reason: str | None) -> None:
        try:
            channel = self.names.control(plugin_id)
            self._declare_once(control_spec(channel))
            attributes = self.codec.base(host_source(self.host_instance_id), CANCEL_TYPE, lfcorrelation=call_id)
            packed = self.codec.pack(plugin_id, attributes, {"callId": call_id, "reason": reason or "aborted by the host"}, False)
            self.driver.publish(channel, packed.wire, PublishOptions(ttl_ms=60_000))
        except Exception as exc:  # noqa: BLE001
            self.log.warning("cancel of %s on %s could not be sent: %s", call_id, plugin_id, exc)

    def _on_reply(self, wire: WireEvent, expected_call_id: str | None = None) -> None:
        try:
            raw = self.codec.peek(wire)
        except Exception as exc:  # noqa: BLE001
            return self.log.warning("dropped a malformed reply: %s", exc)
        parsed = parse_type(raw.attributes.type)
        correlation = raw.attributes.lfcorrelation
        if parsed is None or parsed.kind != "response" or not correlation:
            return self.log.warning("dropped a reply that is not a response: %s", raw.attributes.type)
        if expected_call_id is not None and correlation != expected_call_id:
            return self.log.warning("dropped a native reply with another correlation")
        pending = self._pending.get(correlation)
        if pending is None:
            return self.log.debug("dropped a reply to a call that is no longer pending: %s", correlation)
        source = parse_plugin_source(raw.attributes.source)
        if source is None or source[0] != pending.plugin_id:
            return self.log.warning("dropped a reply from another plugin: %s", raw.attributes.source)
        # A reply that went by reference: fetch it, then delete it (the reply channel acknowledges on delivery, so nothing can redeliver it).
        try:
            raw, claim_key = self.codec.resolve_claim(raw, pending.plugin_id)
        except ClaimError as exc:
            return pending.reject(ClaimUnavailableError(f"the plugin's reply could not be read from the claim store: {exc}", "response"))
        except Exception as exc:  # noqa: BLE001
            return self.log.warning("dropped a reply that failed verification: %s", exc)
        if claim_key and self.claims is not None:
            self._drop_claim(claim_key)
        try:
            attributes, data = self.codec.unpack(raw, pending.plugin_id)
        except Exception as exc:  # noqa: BLE001
            if is_drop_reason(exc):
                return self.log.warning("dropped a reply that failed verification: %s", exc)
            return pending.reject(exc)
        if parsed.method != pending.method:
            return self.log.warning("dropped a reply for another method: %s", attributes.type)
        pending.resolve((attributes, data))

    def _on_registry(self, wire: WireEvent) -> None:
        try:
            raw = self.codec.peek(wire)
        except Exception as exc:  # noqa: BLE001
            return self.log.warning("dropped a malformed registry event: %s", exc)
        parsed = parse_type(raw.attributes.type)
        source = parse_plugin_source(raw.attributes.source)
        if source is None or parsed is None or parsed.kind not in ("announce", "withdraw"):
            return
        plugin_id, instance_id = source
        try:
            _attributes, data = self.codec.unpack(raw, plugin_id)
        except Exception as exc:  # noqa: BLE001
            return self.log.warning("ignored a %s from %s that failed verification: %s", parsed.kind, plugin_id, exc)
        if not isinstance(data, dict):
            return
        if data.get("pluginId") != plugin_id or data.get("instanceId") != instance_id:
            return self.log.warning("ignored an announce whose body contradicts its source: %s", raw.attributes.source)
        if parsed.kind == "withdraw":
            return self._forget_instance(plugin_id, instance_id, "withdrawn")
        if self.registry_secret and not verify_registry_proof(self.registry_secret, plugin_id, raw.attributes.id, data.get("registryProof")):
            return self.log.warning("ignored an announce from %s/%s without a valid registry proof", plugin_id, instance_id)
        if not isinstance(data.get("manifestHash"), str) or not isinstance(data.get("version"), str):
            return
        now = self.now()
        ttl = data.get("ttlSeconds")
        ttl_ms = (ttl if isinstance(ttl, (int, float)) and ttl > 0 else DEFAULT_ANNOUNCE_TTL_SECONDS) * 1000
        with self._lock:
            entry = self._known.get(plugin_id)
            if entry is None:
                entry = (AnnouncedPlugin(plugin_id, data["version"], data["manifestHash"], self.endpoint_of(plugin_id), [], now), {})
                self._known[plugin_id] = entry
            plugin, instances = entry
            fresh = instance_id not in instances
            changed = plugin.manifest_hash != data["manifestHash"] or plugin.version != data["version"]
            max_concurrency = data.get("maxConcurrency")
            instances[instance_id] = AnnouncedInstance(instance_id, data["version"], data["manifestHash"], max_concurrency if isinstance(max_concurrency, int) else None, now, int(now + ttl_ms))
            plugin.version = data["version"]
            plugin.manifest_hash = data["manifestHash"]
            plugin.last_seen = now
            plugin.instances = list(instances.values())
        if fresh or changed:
            self._emit(PluginEvent("announced" if fresh else "updated", plugin, instance_id))

    def _forget_instance(self, plugin_id: str, instance_id: str, kind: str) -> None:
        with self._lock:
            entry = self._known.get(plugin_id)
            if entry is None or instance_id not in entry[1]:
                return
            del entry[1][instance_id]
            entry[0].instances = list(entry[1].values())
            plugin = entry[0]
        self._emit(PluginEvent(kind, plugin, instance_id))

    def _expire_instances(self) -> None:
        now = self.now()
        with self._lock:
            expired = [(plugin_id, inst.instance_id) for plugin_id, (_p, instances) in self._known.items() for inst in instances.values() if inst.expires_at <= now]
        for plugin_id, instance_id in expired:
            self._forget_instance(plugin_id, instance_id, "expired")

    def _expiry_loop(self) -> None:
        while not self._stop.wait(1.0):
            self._expire_instances()

    def _stats_loop(self) -> None:
        while not self._stop.wait(self.stats_interval_ms / 1000):
            self.sample_stats()

    def _emit(self, event: PluginEvent) -> None:
        for listener in list(self._listeners):
            try:
                listener(event)
            except Exception as exc:  # noqa: BLE001
                self.log.error("plugin listener threw: %s", exc)
