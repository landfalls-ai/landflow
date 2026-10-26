"""The Valkey / Redis Streams driver (kind ``valkey``) on ``valkey`` (valkey-py), docs/protocol.md §14.9.

The same wire as ``@landflow/transports/valkey`` and ``sdks/go/transport/valkey``:

- A channel is a stream (``<key_prefix><channel>``); an entry's fields carry the CloudEvents headers (``h:<name>``)
  and the body (``b``), so the core runs in binary mode and stream tooling can read the attributes.
- **Shared** channels use a consumer group per ``group`` (created at ``0``, so events published before the first consumer
  wait for it): ``XREADGROUP`` with ``COUNT`` = free prefetch slots on a connection of the subscription's own (blocking
  reads), ``XACK`` on ack. Pending entries of a consumer that died are reclaimed with ``XAUTOCLAIM`` after
  ``claim_idle_ms``; in-flight entries send a keep-alive (``XCLAIM … JUSTID`` by their owner) so a slow call is not
  stolen. ``nack(requeue=True)`` and a closing consumer hand their entries to the parking consumer ``_orphans`` with
  their idle time already past ``claim_idle_ms``; the delivery count from ``XPENDING`` is the attempt.
- **Broadcast** channels (reply, registry, control) are read with ``XREAD`` from the id current at subscribe time.
- Streams are trimmed on every ``XADD``: ``MINID ~ now - ttl_ms`` for channels declared with a TTL, else ``MAXLEN ~ max_len``.
- ``stats()``: ``XINFO GROUPS`` lag as depth, live consumers (``XINFO CONSUMERS``, idle below a threshold) as consumers.

valkey-py's synchronous client is thread-safe (a connection pool); each subscription runs a read loop on a thread of
its own with a dedicated connection and hands entries to a pool of ``prefetch`` workers.
"""

from __future__ import annotations

import logging
import os
import secrets
import socket
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable
from urllib.parse import unquote, urlsplit

from ..driver import (
    BrokerConfig,
    BrokerDriver,
    Capabilities,
    ChannelSpec,
    ChannelStats,
    ConsumeHandler,
    ConsumeOptions,
    Delivery,
    HandlerPool,
    NotConnectedError,
    PublishOptions,
    SimpleDriverModule,
    Subscription,
    WireEvent,
)
from . import _import_client

log = logging.getLogger("landflow_sdk.transport.valkey")

DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024
DEFAULT_MAX_LEN = 10_000
DEFAULT_CLAIM_IDLE_MS = 30_000
DEFAULT_BLOCK_MS = 1_000
ORPHANS_CONSUMER = "_orphans"
_HEADER_FIELD = b"h:"
_BODY_FIELD = b"b"

VALKEY_CAPABILITIES = Capabilities(
    replies="reply-channel", work_sharing=True, buffering=True, ttl=False, undeliverable="inferred", persistence="disk",
    max_message_bytes=DEFAULT_MAX_MESSAGE_BYTES, latency="low", headers=True, ordering_keys=False, nack=True, attempts=True,
)


@dataclass
class ValkeyConfig(BrokerConfig):
    #: ``redis://host:6379``, ``rediss://`` (TLS), ``valkey://``, ``valkeys://``; the database may follow (``/0``).
    url: str = ""
    username: str | None = None
    password: str | None = None
    db: int | None = None
    tls: bool = False
    key_prefix: str = ""
    max_message_bytes: int = DEFAULT_MAX_MESSAGE_BYTES
    max_len: int = DEFAULT_MAX_LEN
    claim_idle_ms: int = DEFAULT_CLAIM_IDLE_MS
    block_ms: int = DEFAULT_BLOCK_MS


def to_fields(event: WireEvent) -> dict[bytes, bytes]:
    """The stream entry fields for an event: ``h:<header>`` per header and ``b`` for the body."""
    fields: dict[bytes, bytes] = {}
    for name, value in event.headers.items():
        fields[_HEADER_FIELD + name.lower().encode()] = value.encode("utf-8")
    fields[_BODY_FIELD] = bytes(event.body)
    return fields


def from_fields(fields: dict[bytes, bytes]) -> WireEvent:
    headers: dict[str, str] = {}
    body = b""
    for name, value in fields.items():
        if name == _BODY_FIELD:
            body = bytes(value)
        elif name.startswith(_HEADER_FIELD):
            headers[name[len(_HEADER_FIELD):].decode("utf-8", "replace").lower()] = value.decode("utf-8", "replace")
    return WireEvent(headers, body)


def _text(value: Any) -> str:
    return value.decode("utf-8", "replace") if isinstance(value, (bytes, bytearray)) else str(value)


def _as_record(flat: Any) -> dict[str, Any]:
    """``XINFO`` replies come back as dicts (valkey-py parses them) or flat arrays; normalise to a str-keyed dict."""
    if isinstance(flat, dict):
        return {_text(k): v for k, v in flat.items()}
    out: dict[str, Any] = {}
    if isinstance(flat, (list, tuple)):
        for i in range(0, len(flat) - 1, 2):
            out[_text(flat[i])] = flat[i + 1]
    return out


class _ValkeyDelivery(Delivery):
    def __init__(self, attempt: int, ack: Callable[[], None], nack: Callable[[bool], None]) -> None:
        self.attempt = attempt
        self._ack, self._nack = ack, nack
        self._settled = False
        self._lock = threading.Lock()

    def _settle(self) -> bool:
        with self._lock:
            if self._settled:
                return False
            self._settled = True
            return True

    def ack(self) -> None:
        if self._settle():
            self._ack()

    def nack(self, *, requeue: bool = False) -> None:
        if self._settle():
            self._nack(requeue)


class _ValkeySubscription(Subscription):
    def __init__(self, channel: str, close: Callable[[], None]) -> None:
        self.channel = channel
        self._close = close

    def close(self) -> None:
        self._close()


class ValkeyDriver(BrokerDriver):
    kind = "valkey"

    def __init__(self) -> None:
        self.capabilities = VALKEY_CAPABILITIES.copy()
        self.consumer_name = f"{socket.gethostname()}-{os.getpid()}-{secrets.token_hex(3)}"
        self._client: Any = None
        self._config: ValkeyConfig | None = None
        self._closing = False
        self._specs: dict[str, ChannelSpec] = {}
        self._subscriptions: set[_ValkeySubscription] = set()

    def _new_client(self, single: bool = False) -> Any:
        valkey = _import_client("valkey")
        config = self._config
        assert config is not None
        parts = urlsplit(config.url)
        kwargs: dict[str, Any] = {
            "host": parts.hostname or "127.0.0.1", "port": parts.port or 6379, "client_name": f"landflow-{config.connection_id}",
            "decode_responses": False, "socket_connect_timeout": 5, "socket_keepalive": True,
        }
        if config.username:
            kwargs["username"] = config.username
        if config.password:
            kwargs["password"] = config.password
        if config.db is not None:
            kwargs["db"] = config.db
        if config.tls:
            kwargs["ssl"] = True
        if single:
            kwargs["single_connection_client"] = True
        return valkey.Valkey(**kwargs)

    def connect(self, config: ValkeyConfig) -> None:
        if self._client is not None:
            raise RuntimeError("Valkey driver is already connected")
        self._config = config
        client = self._new_client()
        try:
            client.ping()
        except Exception as exc:  # noqa: BLE001
            self._config = None
            raise RuntimeError(f"valkey: cannot connect to {config.url}: {exc}") from exc
        self._client = client
        wanted = config.max_message_bytes or self.capabilities.max_message_bytes
        server_max: int | None = None
        try:
            reply = client.config_get("proto-max-bulk-len")
            value = int(_text(next(iter(reply.values())))) if reply else 0
            if value > 0:
                server_max = value
        except Exception:  # noqa: BLE001 - CONFIG may be disabled on managed services
            pass
        self.capabilities.max_message_bytes = min(wanted, server_max) if server_max else wanted

    def close(self) -> None:
        client = self._client
        if client is None or self._closing:
            return
        self._closing = True
        for subscription in list(self._subscriptions):
            try:
                subscription.close()
            except Exception:  # noqa: BLE001
                pass
        self._subscriptions.clear()
        self._client = None
        try:
            client.close()
        except Exception:  # noqa: BLE001
            pass

    def _ensure(self) -> Any:
        if self._client is None or self._closing:
            raise NotConnectedError("valkey driver is not connected")
        return self._client

    def _key(self, channel: str) -> str:
        return (self._config.key_prefix if self._config else "") + channel

    def declare(self, channels: list[ChannelSpec]) -> None:
        self._ensure()
        for spec in channels:
            self._specs[spec.name] = spec

    def publish(self, channel: str, event: WireEvent, options: PublishOptions | None = None) -> str:
        client = self._ensure()
        config = self._config
        assert config is not None
        spec = self._specs.get(channel)
        ttl = spec.ttl_ms if spec else None
        try:
            if ttl:
                client.xadd(self._key(channel), to_fields(event), minid=str(int(time.time() * 1000) - ttl), approximate=True)
            else:
                client.xadd(self._key(channel), to_fields(event), maxlen=config.max_len, approximate=True)
        except Exception as exc:  # noqa: BLE001
            if "Connection" in type(exc).__name__ or "connect" in str(exc).lower():
                raise NotConnectedError(f"valkey: {exc}") from exc
            raise
        return "accepted"

    def consume(self, channel: str, options: ConsumeOptions, on_event: ConsumeHandler) -> Subscription:
        self._ensure()
        conn = self._new_client(single=True)
        try:
            conn.ping()
            subscription = self._consume_group(conn, channel, options, on_event) if options.group else self._consume_broadcast(conn, channel, on_event)
        except Exception:
            conn.close()
            raise
        self._subscriptions.add(subscription)
        return subscription

    def stats(self, channel: str) -> ChannelStats:
        client = self._ensure()
        config = self._config
        assert config is not None
        key = self._key(channel)
        try:
            groups = client.xinfo_groups(key)
        except Exception as exc:  # noqa: BLE001
            if "no such key" in str(exc).lower():
                return ChannelStats(depth=0, consumers=0)
            raise
        live_ms = max(3 * config.block_ms, config.claim_idle_ms // 2)
        depth = 0
        consumers = 0
        for raw in groups:
            group = _as_record(raw)
            lag = group.get("lag")
            if isinstance(lag, int):
                depth = max(depth, lag)
            for member in (_as_record(m) for m in client.xinfo_consumers(key, _text(group.get("name")))):
                if _text(member.get("name")) == ORPHANS_CONSUMER:
                    continue
                idle = member.get("idle")
                if not isinstance(idle, int) or idle <= live_ms:
                    consumers += 1
        return ChannelStats(depth=depth, consumers=consumers)

    # --- consumer groups --------------------------------------------------------------------------------------------------

    def _consume_group(self, conn: Any, channel: str, options: ConsumeOptions, on_event: ConsumeHandler) -> _ValkeySubscription:
        client = self._client
        config = self._config
        assert config is not None
        key = self._key(channel)
        group = options.group or channel
        me = self.consumer_name
        manual = options.ack_mode == "manual"
        try:
            client.xgroup_create(key, group, "0", mkstream=True)
        except Exception as exc:  # noqa: BLE001
            if "BUSYGROUP" not in str(exc):
                raise
        in_flight: dict[bytes, bool] = {}
        lock = threading.Lock()
        closed = threading.Event()
        pool = HandlerPool(max(1, options.prefetch), f"valkey-{channel}", release_on_return=not manual)

        def park(ids: list[bytes]) -> None:
            if ids:
                client.xclaim(key, group, ORPHANS_CONSUMER, 0, ids, idle=config.claim_idle_ms, justid=True)

        def keep_alive() -> None:
            while not closed.wait(max(1.0, config.claim_idle_ms / 3000)):
                with lock:
                    ids = list(in_flight)
                if ids and self._client is not None:
                    try:
                        client.xclaim(key, group, me, 0, ids, justid=True)
                    except Exception:  # noqa: BLE001
                        pass

        def deliver(entry_id: bytes, fields: dict[bytes, bytes], attempt: int) -> None:
            if manual:
                with lock:
                    in_flight[entry_id] = True

            def settle() -> bool:
                """``False`` once the subscription closed: the entry was handed back already, a late ack/nack must not touch it."""
                with lock:
                    orphaned = closed.is_set()
                    in_flight.pop(entry_id, None)
                if manual:
                    pool.release()
                return not orphaned

            def ack() -> None:
                if not settle():
                    return
                try:
                    client.xack(key, group, entry_id)
                except Exception:  # noqa: BLE001
                    pass

            def nack(requeue: bool) -> None:
                if not settle():
                    return
                try:
                    if requeue:
                        park([entry_id])
                    else:
                        client.xack(key, group, entry_id)
                except Exception:  # noqa: BLE001
                    pass

            delivery = _ValkeyDelivery(attempt, ack, nack)
            if not manual:
                try:
                    client.xack(key, group, entry_id)
                except Exception:  # noqa: BLE001
                    pass
            event = from_fields(fields)

            def handle() -> None:
                try:
                    on_event(event, delivery)
                except Exception:  # noqa: BLE001
                    delivery.nack(requeue=False)

            pool.submit(handle)

        def attempts_of(ids: list[bytes]) -> dict[bytes, int]:
            counts: dict[bytes, int] = {}
            if not ids:
                return counts
            try:
                for row in conn.xpending_range(key, group, ids[0], ids[-1], len(ids) + len(in_flight), consumername=me):
                    record = _as_record(row)
                    message_id = record.get("message_id")
                    delivered = record.get("times_delivered")
                    if message_id is not None and isinstance(delivered, int):
                        counts[message_id if isinstance(message_id, bytes) else str(message_id).encode()] = delivered
            except Exception:  # noqa: BLE001
                pass
            return counts

        def loop() -> None:
            while not closed.is_set():
                if not pool.acquire(timeout=0.5):
                    continue
                taken = 1
                try:
                    free = options.prefetch - len(in_flight)
                    # 1. Entries whose consumer died (or parked them), oldest first.
                    claimed = conn.xautoclaim(key, group, me, config.claim_idle_ms, start_id="0-0", count=max(1, free))
                    entries = [(entry_id, fields) for entry_id, fields in (claimed[1] if len(claimed) > 1 else []) if fields]
                    if entries:
                        attempts = attempts_of([entry_id for entry_id, _ in entries])
                        pool.release()
                        taken = 0
                        for entry_id, fields in entries:
                            if not pool.acquire():
                                park([entry_id])
                                continue
                            deliver(entry_id, fields, max(2, attempts.get(entry_id, 2)))
                        continue
                    # 2. New entries, blocking until one arrives.
                    reply = conn.xreadgroup(group, me, {key: ">"}, count=max(1, free), block=config.block_ms)
                    pool.release()
                    taken = 0
                    for _stream, items in reply or []:
                        for entry_id, fields in items:
                            if fields is None:
                                continue
                            if not pool.acquire():
                                park([entry_id])
                                continue
                            deliver(entry_id, fields, 1)
                except Exception as exc:  # noqa: BLE001
                    if taken:
                        pool.release()
                    if not closed.is_set():
                        log.debug("valkey read loop for %s: %s", channel, exc)
                        closed.wait(0.1 if self._client is not None else 0.5)

        thread = threading.Thread(target=loop, name=f"valkey-group-{channel}", daemon=True)
        alive = threading.Thread(target=keep_alive, name=f"valkey-keepalive-{channel}", daemon=True)
        thread.start()
        alive.start()

        def close() -> None:
            if closed.is_set():
                return
            closed.set()
            self._subscriptions.discard(subscription)
            pool.close()
            try:
                conn.close()  # interrupts the blocking read
            except Exception:  # noqa: BLE001
                pass
            thread.join(config.block_ms / 1000 + 2)
            with lock:
                held = list(in_flight)
                in_flight.clear()
            if self._client is not None:
                try:
                    park(held)
                    client.xgroup_delconsumer(key, group, me)
                except Exception:  # noqa: BLE001
                    pass

        subscription = _ValkeySubscription(channel, close)
        return subscription

    # --- broadcast --------------------------------------------------------------------------------------------------------

    def _consume_broadcast(self, conn: Any, channel: str, on_event: ConsumeHandler) -> _ValkeySubscription:
        config = self._config
        assert config is not None
        key = self._key(channel)
        last = self._client.xrevrange(key, "+", "-", count=1)
        state = {"last_id": last[0][0] if last else b"0-0"}
        closed = threading.Event()
        pool = HandlerPool(64, f"valkey-bc-{channel}")
        noop = _ValkeyDelivery(1, lambda: None, lambda _r: None)

        def loop() -> None:
            while not closed.is_set():
                try:
                    reply = conn.xread({key: state["last_id"]}, count=256, block=config.block_ms)
                    for _stream, items in reply or []:
                        for entry_id, fields in items:
                            state["last_id"] = entry_id
                            if fields and pool.acquire():
                                pool.submit(lambda e=from_fields(fields): on_event(e, noop))
                except Exception as exc:  # noqa: BLE001
                    if not closed.is_set():
                        log.debug("valkey broadcast loop for %s: %s", channel, exc)
                        closed.wait(0.1 if self._client is not None else 0.5)

        thread = threading.Thread(target=loop, name=f"valkey-broadcast-{channel}", daemon=True)
        thread.start()

        def close() -> None:
            if closed.is_set():
                return
            closed.set()
            self._subscriptions.discard(subscription)
            pool.close()
            try:
                conn.close()
            except Exception:  # noqa: BLE001
                pass
            thread.join(config.block_ms / 1000 + 2)

        subscription = _ValkeySubscription(channel, close)
        return subscription


def valkey_config_from(connection_id: str, url: str, options: dict[str, Any] | None = None) -> ValkeyConfig:
    """The config for a connection URL; ``username``/``password``/``tls``/``db``/``keyPrefix`` in ``options`` win over the URL."""
    options = dict(options or {})
    parts = urlsplit((url or "").strip())
    if parts.scheme not in ("redis", "rediss", "valkey", "valkeys"):
        raise ValueError(f'Valkey URL "{url}" must use redis://, rediss://, valkey:// or valkeys://')
    if not parts.hostname:
        raise ValueError(f'Valkey URL "{url}" has no host')
    tls = bool(options["tls"]) if "tls" in options else parts.scheme in ("rediss", "valkeys")
    path = parts.path.lstrip("/")
    db_option = options.get("db") if options.get("db") not in (None, "") else (path or None)
    db: int | None = None
    if db_option is not None:
        try:
            db = int(db_option)
        except ValueError:
            raise ValueError(f'Valkey database index "{db_option}" must be a non-negative integer') from None
        if db < 0:
            raise ValueError(f'Valkey database index "{db_option}" must be a non-negative integer')
    host = parts.hostname
    netloc = f"[{host}]" if ":" in host else host
    if parts.port:
        netloc += f":{parts.port}"
    config = ValkeyConfig(connection_id=connection_id, prefix=options.get("prefix") or None, url=f"{'rediss' if tls else 'redis'}://{netloc}", tls=tls, db=db)
    config.username = str(options["username"]) if options.get("username") else (unquote(parts.username) if parts.username else None)
    config.password = str(options["password"]) if options.get("password") else (unquote(parts.password) if parts.password else None)
    if options.get("keyPrefix"):
        config.key_prefix = str(options["keyPrefix"])
    for key, attr in (("maxMessageBytes", "max_message_bytes"), ("maxLen", "max_len"), ("claimIdleMs", "claim_idle_ms"), ("blockMs", "block_ms")):
        if options.get(key) not in (None, ""):
            setattr(config, attr, int(options[key]))
    return config


def valkey(url: str, *, connection_id: str = "env-valkey", **options: Any) -> "BrokerTarget":
    """SDK helper: ``serve(plugin, brokers=[valkey("redis://127.0.0.1:56379")])``."""
    from ..binding import BrokerTarget

    return BrokerTarget("valkey", valkey_config_from(connection_id, url, options), ValkeyDriver)


MODULE = SimpleDriverModule(kind="valkey", label="Valkey / Redis Streams", capabilities=VALKEY_CAPABILITIES, create=ValkeyDriver, config_from=valkey_config_from,
                            example_url="redis://127.0.0.1:56379/0", extras=("valkey",))
