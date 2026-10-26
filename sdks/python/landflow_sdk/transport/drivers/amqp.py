"""The RabbitMQ driver (kind ``amqp``, AMQP 0-9-1) on ``pika``, docs/protocol.md §14.9.

Mapping, the same wire as ``@landflow/transports/amqp`` and ``sdks/go/transport/amqp``:

- **Shared channels** (request, instance) are **queues** published to through the default exchange. Request queues are
  durable **quorum queues** (``x-queue-type: quorum``, so ``x-delivery-count`` gives true attempts; ``queue_type="classic"``
  for brokers without them) with ``x-message-ttl`` from the spec and ``x-expires`` (default 24 h). Instance queues are
  durable classic queues that auto-delete when their one consumer leaves. Consumers compete with ``prefetch`` on a
  channel of their own; ``nack(requeue=True)`` is ``basic.nack`` with requeue; a closed subscription closes its channel,
  which hands its unacknowledged deliveries back.
- **Broadcast channels** (registry, control) are durable **fanout exchanges**; each consumer binds an exclusive,
  auto-delete, server-named queue with ``x-message-ttl`` from the spec.
- **Replies are native**: ``request()`` publishes with ``reply_to = amq.rabbitmq.reply-to`` (direct reply-to, consumed
  ``auto_ack`` on the publishing channel) and a driver-private ``correlation_id``; ``Delivery.reply()`` publishes to
  the request's ``reply_to``. Pseudo-queues die with the connection, so a connection loss fails the requests in flight.
- **Undeliverable is reported**: every publish is ``mandatory`` on a confirm channel (a ``basic.return`` →
  ``unroutable``) and a publish to a queue first asks the broker for its consumer count (passive declare).
- **CloudEvents AMQP binding**, binary mode: headers ``cloudEvents_<name>``, ``content-type`` as the ``content_type``
  property; ``max_header_bytes`` keeps the content header frame under ``frame_max``.

**Why pika, not aio-pika.** The SDK is threaded: pika's ``BlockingConnection`` runs on one I/O thread of the driver's
own and every other thread reaches it through ``add_callback_threadsafe`` (acks, replies, publishes), which is the
documented way to use pika from several threads; aio-pika would need the same loop thread plus asyncio bridging and
pulls in aiormq and yarl, for no gain here. Consumer callbacks arrive on the I/O thread and are handed to a pool of
``prefetch`` workers (the broker's ``basic.qos`` bounds what is outstanding), so the I/O thread never blocks in node code.
"""

from __future__ import annotations

import logging
import secrets
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any, Callable
from urllib.parse import quote, urlsplit, urlunsplit

from ..driver import (
    BrokerConfig,
    BrokerDriver,
    Capabilities,
    ChannelSpec,
    ChannelStats,
    ConsumeHandler,
    ConsumeOptions,
    Delivery,
    NotConnectedError,
    PublishOptions,
    RequestOutcome,
    SimpleDriverModule,
    Subscription,
    WireEvent,
    prefix_headers,
    unprefix_headers,
)
from . import _import_client

log = logging.getLogger("landflow_sdk.transport.amqp")

AMQP_HEADER_PREFIX = "cloudEvents_"
DIRECT_REPLY_TO = "amq.rabbitmq.reply-to"
DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024 * 1024
DEFAULT_MAX_HEADER_BYTES = 120 * 1024
_DEFAULT_QUEUE_EXPIRES_MS = 24 * 60 * 60_000
_RECONNECT_MIN_S = 1.0
_RECONNECT_MAX_S = 30.0
_CALL_TIMEOUT_S = 30.0

AMQP_CAPABILITIES = Capabilities(
    replies="native", work_sharing=True, buffering=True, ttl=True, undeliverable="reported", persistence="disk",
    max_message_bytes=DEFAULT_MAX_MESSAGE_BYTES, latency="medium", headers=True, max_header_bytes=DEFAULT_MAX_HEADER_BYTES,
    ordering_keys=False, nack=True, attempts=True,
)


@dataclass
class AmqpConfig(BrokerConfig):
    #: ``amqp://user:pass@host:5672/vhost`` or ``amqps://…``.
    url: str = ""
    username: str | None = None
    password: str | None = None
    tls: bool = False
    heartbeat_seconds: int = 30
    #: Request queues: ``quorum`` (default) or ``classic``.
    queue_type: str = "quorum"
    queue_expires_ms: int = _DEFAULT_QUEUE_EXPIRES_MS
    max_message_bytes: int = DEFAULT_MAX_MESSAGE_BYTES
    reconnect_min_s: float = _RECONNECT_MIN_S
    reconnect_max_s: float = _RECONNECT_MAX_S


def amqp_headers_to_wire(headers: dict[str, Any] | None, content_type: str | None) -> dict[str, str]:
    raw: dict[str, str] = {}
    for name, value in (headers or {}).items():
        if value is None:
            continue
        raw[name] = value.decode("utf-8", "replace") if isinstance(value, (bytes, bytearray)) else str(value)
    if content_type:
        raw["content-type"] = content_type
    return unprefix_headers(raw, AMQP_HEADER_PREFIX)


def wire_to_amqp_headers(headers: dict[str, str]) -> tuple[dict[str, str], str | None]:
    prefixed = prefix_headers(headers, AMQP_HEADER_PREFIX)
    content_type = prefixed.pop("content-type", None)
    return prefixed, content_type


def attempt_of(properties: Any, redelivered: bool) -> int:
    count = (properties.headers or {}).get("x-delivery-count") if properties is not None else None
    if isinstance(count, int):
        return count + 1
    return 2 if redelivered else 1


def infer_role(name: str) -> str:
    segments = name.split(".")
    return "exchange" if len(segments) > 2 and segments[2] in ("reply", "registry", "control") else "queue"


def connection_url(config: AmqpConfig) -> str:
    parts = urlsplit(config.url)
    scheme = "amqps" if config.tls or parts.scheme == "amqps" else "amqp"
    host = parts.hostname or "127.0.0.1"
    netloc = f"[{host}]" if ":" in host else host
    if parts.port:
        netloc += f":{parts.port}"
    username = config.username if config.username is not None else parts.username
    password = config.password if config.password is not None else parts.password
    if username is not None:
        netloc = f"{quote(username, safe='')}:{quote(password or '', safe='')}@{netloc}"
    return urlunsplit((scheme, netloc, parts.path or "/", parts.query, ""))


def _redact(url: str) -> str:
    parts = urlsplit(url)
    if parts.password:
        return url.replace(f":{parts.password}@", ":***@")
    return url


class _LiveSubscription:
    def __init__(self, channel: str, options: ConsumeOptions, on_event: ConsumeHandler) -> None:
        self.channel = channel
        self.options = options
        self.on_event = on_event
        self.amqp: Any = None
        self.closed = False
        self.pool = ThreadPoolExecutor(max_workers=max(1, options.prefetch), thread_name_prefix=f"amqp-{channel}")


class _AmqpSubscription(Subscription):
    def __init__(self, driver: "AmqpDriver", live: _LiveSubscription) -> None:
        self.channel = live.channel
        self._driver = driver
        self._live = live

    def close(self) -> None:
        live = self._live
        if live.closed:
            return
        live.closed = True
        self._driver._subscriptions.discard(live)
        amqp, live.amqp = live.amqp, None
        if amqp is not None:
            self._driver._run(lambda: amqp.close(), swallow=True)
        live.pool.shutdown(wait=False)


class AmqpDriver(BrokerDriver):
    kind = "amqp"

    def __init__(self) -> None:
        self.capabilities = AMQP_CAPABILITIES.copy()
        self._config: AmqpConfig | None = None
        self._pika: Any = None
        self._connection: Any = None
        self._pub: Any = None
        self._ctl: Any = None
        self._state = "new"
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._declared: dict[str, ChannelSpec] = {}
        self._roles: dict[str, str] = {}
        self._subscriptions: set[_LiveSubscription] = set()
        self._pending: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()
        self._reconnect_attempt = 0

    # --- the I/O thread ---------------------------------------------------------------------------------------------------

    def _run(self, fn: Callable[[], Any], *, swallow: bool = False, timeout: float = _CALL_TIMEOUT_S) -> Any:
        """Run ``fn`` on the connection's I/O thread and wait for its result."""
        if threading.current_thread() is self._thread:
            try:
                return fn()
            except Exception:
                if swallow:
                    return None
                raise
        connection = self._connection
        if connection is None:
            if swallow:
                return None
            raise NotConnectedError("amqp connection is down")
        done = threading.Event()
        box: dict[str, Any] = {}

        def wrapped() -> None:
            try:
                box["result"] = fn()
            except BaseException as exc:  # noqa: BLE001
                box["error"] = exc
            finally:
                done.set()

        try:
            connection.add_callback_threadsafe(wrapped)
        except Exception as exc:  # noqa: BLE001
            if swallow:
                return None
            raise NotConnectedError(f"amqp connection is down: {exc}") from exc
        if not done.wait(timeout):
            if swallow:
                return None
            raise RuntimeError("amqp: the connection thread did not answer in time")
        if "error" in box:
            if swallow:
                return None
            raise box["error"]
        return box.get("result")

    def _loop(self) -> None:
        pika = self._pika
        while not self._stop.is_set():
            connection = self._connection
            if connection is None:
                self._stop.wait(0.1)
                continue
            try:
                connection.process_data_events(time_limit=0.1)
            except (pika.exceptions.AMQPConnectionError, pika.exceptions.StreamLostError, OSError) as exc:
                self._on_connection_lost(connection, exc)
            except Exception as exc:  # noqa: BLE001 - a channel error inside a callback; the connection goes on
                if self._connection is connection and getattr(connection, "is_open", False):
                    log.debug("amqp event loop: %s", exc)
                else:
                    self._on_connection_lost(connection, exc)

    def _on_connection_lost(self, connection: Any, error: BaseException) -> None:
        if self._connection is not connection:
            return
        self._connection = None
        self._pub = None
        self._ctl = None
        if self._state == "closed":
            return
        self._state = "reconnecting"
        log.warning("amqp connection lost (%s); reconnecting", error)
        self._fail_pending(RuntimeError("amqp connection lost; the call may have run"))
        for live in self._subscriptions:
            live.amqp = None
        config = self._config
        assert config is not None
        while self._state == "reconnecting" and not self._stop.is_set():
            delay = min(config.reconnect_max_s, config.reconnect_min_s * 2 ** min(self._reconnect_attempt, 10))
            self._reconnect_attempt += 1
            if self._stop.wait(delay):
                return
            try:
                self._open()
                for spec in self._declared.values():
                    try:
                        self._declare_one(spec)
                    except Exception:  # noqa: BLE001
                        pass
                for live in list(self._subscriptions):
                    if not live.closed:
                        try:
                            self._start_consumer(live)
                        except Exception as exc:  # noqa: BLE001
                            log.warning("amqp: cannot resume consuming %s: %s", live.channel, exc)
                self._reconnect_attempt = 0
                self._state = "connected"
            except Exception as exc:  # noqa: BLE001
                log.debug("amqp reconnect failed: %s", exc)

    def _fail_pending(self, error: BaseException) -> None:
        with self._lock:
            pending, self._pending = self._pending, {}
        for entry in pending.values():
            entry["error"] = error
            entry["done"].set()

    def _open(self) -> None:
        pika = self._pika
        config = self._config
        assert config is not None
        parameters = pika.URLParameters(connection_url(config))
        parameters.heartbeat = config.heartbeat_seconds
        parameters.blocked_connection_timeout = 30
        connection = pika.BlockingConnection(parameters)
        pub = connection.channel()
        pub.confirm_delivery()
        pub.basic_consume(DIRECT_REPLY_TO, self._on_reply, auto_ack=True)
        ctl = connection.channel()
        self._connection = connection
        self._pub = pub
        self._ctl = ctl

    # --- lifecycle --------------------------------------------------------------------------------------------------------

    def connect(self, config: AmqpConfig) -> None:
        if self._state != "new":
            raise RuntimeError(f"amqp driver already {self._state}")
        if not config.url:
            raise RuntimeError("amqp: no url configured")
        self._pika = _import_client("amqp")
        self._config = config
        self.capabilities.max_message_bytes = config.max_message_bytes
        try:
            self._open()
        except Exception as exc:  # noqa: BLE001
            self._state = "new"
            raise RuntimeError(f"amqp: cannot connect to {_redact(config.url)}: {exc}") from exc
        self._state = "connected"
        self._thread = threading.Thread(target=self._loop, name=f"amqp-{config.connection_id}", daemon=True)
        self._thread.start()

    def close(self) -> None:
        if self._state == "closed":
            return
        was_open = self._state != "new"
        self._state = "closed"
        self._fail_pending(RuntimeError("amqp driver closed"))
        for live in list(self._subscriptions):
            live.closed = True
            amqp, live.amqp = live.amqp, None
            if amqp is not None:
                self._run(lambda a=amqp: a.close(), swallow=True)
            live.pool.shutdown(wait=False)
        self._subscriptions.clear()
        connection = self._connection
        if was_open and connection is not None:
            self._run(lambda: connection.close(), swallow=True, timeout=5)
        self._stop.set()
        self._connection = None
        self._pub = None
        self._ctl = None
        if self._thread is not None and threading.current_thread() is not self._thread:
            self._thread.join(5)
        self._declared.clear()

    def _ensure(self) -> Any:
        if self._state != "connected" or self._pub is None:
            raise NotConnectedError(f"amqp driver is {'not connected' if self._state == 'new' else self._state}")
        return self._pub

    # --- declaring --------------------------------------------------------------------------------------------------------

    def declare(self, channels: list[ChannelSpec]) -> None:
        self._ensure()
        for spec in channels:
            if spec.name in self._declared:
                continue
            self._run(lambda s=spec: self._declare_one(s))
            self._declared[spec.name] = spec
            self._roles[spec.name] = "queue" if spec.delivery == "shared" else "exchange"

    def _control(self) -> Any:
        if self._ctl is not None and self._ctl.is_open:
            return self._ctl
        if self._connection is None:
            raise NotConnectedError("amqp connection is down")
        self._ctl = self._connection.channel()
        return self._ctl

    def _check_queue(self, name: str) -> tuple[int, int] | None:
        """Passive declare on the I/O thread; ``None`` when the queue does not exist (which closes the channel: recreated lazily)."""
        pika = self._pika
        ctl = self._control()
        try:
            method = ctl.queue_declare(name, passive=True)
            return method.method.message_count, method.method.consumer_count
        except pika.exceptions.ChannelClosedByBroker as exc:
            self._ctl = None
            if exc.reply_code == 404:
                return None
            raise

    def _declare_one(self, spec: ChannelSpec) -> None:
        config = self._config
        assert config is not None
        if spec.delivery == "broadcast":
            self._control().exchange_declare(spec.name, "fanout", durable=True, auto_delete=False)
            return
        if self._check_queue(spec.name) is not None:
            return
        ctl = self._control()
        if spec.durable:
            arguments: dict[str, Any] = {}
            if config.queue_type == "quorum":
                arguments["x-queue-type"] = "quorum"
            if spec.ttl_ms is not None:
                arguments["x-message-ttl"] = spec.ttl_ms
            if config.queue_expires_ms > 0:
                arguments["x-expires"] = config.queue_expires_ms
            ctl.queue_declare(spec.name, durable=True, arguments=arguments)
        else:
            arguments = {"x-message-ttl": spec.ttl_ms} if spec.ttl_ms is not None else {}
            ctl.queue_declare(spec.name, durable=True, auto_delete=True, arguments=arguments)

    def _role_of(self, channel: str) -> str:
        known = self._roles.get(channel)
        if known:
            return known
        role = infer_role(channel)
        if role == "exchange":
            self._control().exchange_declare(channel, "fanout", durable=True, auto_delete=False)
        self._roles[channel] = role
        return role

    # --- publishing -------------------------------------------------------------------------------------------------------

    def _send(self, role: str, channel: str, event: WireEvent, *, persistent: bool, expiration_ms: int | None = None, reply_to: str | None = None, correlation_id: str | None = None) -> str:
        """On the I/O thread: publish ``mandatory`` on the confirm channel; ``unroutable`` when the broker returned it."""
        pika = self._pika
        pub = self._pub
        if pub is None:
            raise NotConnectedError("amqp connection is down")
        headers, content_type = wire_to_amqp_headers(event.headers)
        properties = pika.BasicProperties(
            headers=headers, content_type=content_type, delivery_mode=2 if persistent else 1, message_id=secrets.token_hex(8),
            expiration=str(max(1, int(expiration_ms))) if expiration_ms is not None else None, reply_to=reply_to, correlation_id=correlation_id,
        )
        exchange, routing_key = ("", channel) if role == "queue" else (channel, "")
        try:
            pub.basic_publish(exchange, routing_key, event.body, properties, mandatory=True)
        except pika.exceptions.UnroutableError:
            return "unroutable"
        return "accepted"

    def publish(self, channel: str, event: WireEvent, options: PublishOptions | None = None) -> str:
        self._ensure()
        ttl = options.ttl_ms if options else None

        def do() -> str:
            role = self._role_of(channel)
            if role == "queue":
                check = self._check_queue(channel)
                if check is None or check[1] == 0:
                    return "unroutable"
            spec = self._declared.get(channel)
            return self._send(role, channel, event, persistent=spec.durable if spec else role == "queue", expiration_ms=ttl)

        return self._run(do)

    def request(self, channel: str, event: WireEvent, timeout_ms: int, ordering_key: str | None = None) -> RequestOutcome:
        self._ensure()
        correlation_id = secrets.token_hex(12)
        entry: dict[str, Any] = {"done": threading.Event()}
        with self._lock:
            self._pending[correlation_id] = entry

        def do() -> str:
            role = self._role_of(channel)
            if role == "queue":
                check = self._check_queue(channel)
                if check is None or check[1] == 0:
                    return "unroutable"
            spec = self._declared.get(channel)
            return self._send(role, channel, event, persistent=spec.durable if spec else role == "queue", expiration_ms=timeout_ms, reply_to=DIRECT_REPLY_TO, correlation_id=correlation_id)

        try:
            outcome = self._run(do)
        except Exception:
            with self._lock:
                self._pending.pop(correlation_id, None)
            raise
        if outcome == "unroutable":
            with self._lock:
                self._pending.pop(correlation_id, None)
            return RequestOutcome("unroutable")
        entry["done"].wait(timeout_ms / 1000)
        with self._lock:
            self._pending.pop(correlation_id, None)
        if "error" in entry:
            raise entry["error"]
        if "event" in entry:
            return RequestOutcome("replied", entry["event"])
        return RequestOutcome("timeout")

    def _on_reply(self, _channel: Any, method: Any, properties: Any, body: bytes) -> None:
        correlation_id = properties.correlation_id
        with self._lock:
            entry = self._pending.pop(correlation_id, None) if correlation_id else None
        if entry is None:
            return
        entry["event"] = WireEvent(amqp_headers_to_wire(properties.headers, properties.content_type), bytes(body))
        entry["done"].set()

    # --- consuming --------------------------------------------------------------------------------------------------------

    def consume(self, channel: str, options: ConsumeOptions, on_event: ConsumeHandler) -> Subscription:
        self._ensure()
        live = _LiveSubscription(channel, options, on_event)
        self._run(lambda: self._start_consumer(live))
        self._subscriptions.add(live)
        return _AmqpSubscription(self, live)

    def _start_consumer(self, live: _LiveSubscription) -> None:
        """On the I/O thread."""
        if self._connection is None:
            raise NotConnectedError("amqp connection is down")
        spec = self._declared.get(live.channel)
        role = ("queue" if spec.delivery == "shared" else "exchange") if spec else infer_role(live.channel)
        shared = role == "queue" and bool(live.options.group)
        amqp = self._connection.channel()
        live.amqp = amqp
        queue_name = live.channel
        if shared:
            amqp.basic_qos(prefetch_count=max(1, live.options.prefetch))
        else:
            amqp.exchange_declare(live.channel, "fanout", durable=True, auto_delete=False)
            arguments = {"x-message-ttl": spec.ttl_ms} if spec and spec.ttl_ms is not None else {}
            queue_name = amqp.queue_declare("", exclusive=True, auto_delete=True, durable=False, arguments=arguments).method.queue
            amqp.queue_bind(queue_name, live.channel, "")
        no_ack = live.options.ack_mode == "auto"
        driver = self

        def on_message(channel: Any, method: Any, properties: Any, body: bytes) -> None:
            if live.closed:
                return
            event = WireEvent(amqp_headers_to_wire(properties.headers, properties.content_type), bytes(body))
            tag = method.delivery_tag
            state = {"settled": no_ack}
            lock = threading.Lock()

            def settle() -> bool:
                with lock:
                    if state["settled"]:
                        return False
                    state["settled"] = True
                    return True

            class _AmqpDelivery(Delivery):
                attempt = attempt_of(properties, bool(method.redelivered))

                def ack(self) -> None:
                    if settle() and live.amqp is channel:
                        driver._run(lambda: channel.basic_ack(tag), swallow=True)

                def nack(self, *, requeue: bool = False) -> None:
                    if settle() and live.amqp is channel:
                        driver._run(lambda: channel.basic_nack(tag, multiple=False, requeue=requeue), swallow=True)

                def reply(self, reply: WireEvent) -> None:
                    if not properties.reply_to:
                        raise RuntimeError("the request carries no reply_to")
                    headers, content_type = wire_to_amqp_headers(reply.headers)
                    pika = driver._pika
                    props = pika.BasicProperties(headers=headers, content_type=content_type, correlation_id=properties.correlation_id)

                    def publish() -> None:
                        pub = driver._pub
                        if pub is None:
                            raise NotConnectedError("amqp connection is down")
                        # Never mandatory: a direct reply-to name is not a queue, so a return would be the normal outcome.
                        pub.basic_publish("", properties.reply_to, reply.body, props, mandatory=False)

                    driver._run(publish)

            delivery = _AmqpDelivery()

            def handle() -> None:
                try:
                    live.on_event(event, delivery)
                except Exception:  # noqa: BLE001
                    delivery.nack(requeue=False)

            try:
                live.pool.submit(handle)
            except RuntimeError:
                pass

        amqp.basic_consume(queue_name, on_message, auto_ack=no_ack)

    def stats(self, channel: str) -> ChannelStats:
        self._ensure()

        def do() -> ChannelStats:
            if self._role_of(channel) == "exchange":
                return ChannelStats()
            check = self._check_queue(channel)
            return ChannelStats(depth=check[0], consumers=check[1]) if check else ChannelStats(depth=0, consumers=0)

        return self._run(do)


def amqp_config_from(connection_id: str, url: str, options: dict[str, Any] | None = None) -> AmqpConfig:
    """``amqp://[user:pass@]host[:5672][/vhost]`` or ``amqps://…`` (``amqp+ssl://`` works too); ``username``/``password``
    win over the URL's; ``tls`` forces ``amqps``."""
    options = dict(options or {})
    trimmed = (url or "").strip()
    if not trimmed:
        raise ValueError("RabbitMQ needs a URL, e.g. amqp://user:password@127.0.0.1:5672/")
    import re

    trimmed = re.sub(r"^amqp\+(ssl|tls)://", "amqps://", trimmed, flags=re.I)
    parts = urlsplit(trimmed)
    if parts.scheme not in ("amqp", "amqps"):
        raise ValueError(f'"{url}" must start with amqp:// or amqps://')
    if not parts.hostname:
        raise ValueError(f'"{url}" has no host')
    tls = bool(options.get("tls")) or parts.scheme == "amqps"
    config = AmqpConfig(connection_id=connection_id, prefix=options.get("prefix") or None, url=trimmed, tls=tls)
    if options.get("username"):
        config.username, config.password = str(options["username"]), str(options.get("password") or "")
    if options.get("queueType") == "classic":
        config.queue_type = "classic"
    if options.get("maxMessageBytes") not in (None, ""):
        config.max_message_bytes = int(options["maxMessageBytes"])
    return config


def amqp(url: str, *, connection_id: str = "env-amqp", **options: Any) -> "BrokerTarget":
    """SDK helper: ``serve(plugin, brokers=[amqp("amqp://landflow:pw@127.0.0.1:55672/")])``."""
    from ..binding import BrokerTarget

    return BrokerTarget("amqp", amqp_config_from(connection_id, url, options), AmqpDriver)


MODULE = SimpleDriverModule(kind="amqp", label="RabbitMQ (AMQP 0-9-1)", capabilities=AMQP_CAPABILITIES, create=AmqpDriver, config_from=amqp_config_from,
                            example_url="amqp://user:password@rabbitmq:5672/", extras=("amqp",))
