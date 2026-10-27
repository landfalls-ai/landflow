"""The NATS drivers (kinds ``nats`` and ``jetstream``) on ``nats-py``, docs/protocol.md §14.9 "NATS core" / "NATS JetStream".

The same wire as ``@landflow/transports/nats`` + ``/jetstream`` and ``sdks/go/transport/nats``:

- ``nats`` (core): a channel is a subject; replicas share it through a queue group; requests use NATS inboxes
  (``nc.request()``, no responders → ``unroutable``); nothing is buffered. Prefetch is honoured by holding deliveries in
  the driver. ``nack(requeue=True)`` and a closed consumer's unacknowledged deliveries are **republished** on the subject
  with a ``Landflow-Attempt`` header (and the requester's inbox in ``Landflow-Reply``), so another queue member takes them.
- ``jetstream``: a durable shared channel (the request channel) is a work-queue stream plus one durable pull consumer
  per group; the driver pulls at most ``prefetch`` messages per instance, acks and naks (``num_delivered`` = attempt),
  sends progress acks while a call runs, and carries the requester's inbox in ``Landflow-Reply`` so ``Delivery.reply()``
  still answers natively; ``Nats-TTL`` is set from the deadline as a first filter. Every other channel is core NATS.
  In jetstream mode every subject is the channel name behind a fixed ``js.`` token (``js.landflow.v1.plugin.<id>``, stream ``js_landflow_v1_plugin_<id>``), so it never meets a ``nats`` driver on the same server.

CloudEvents go in binary mode with the NATS binding's ``ce-`` prefix; driver headers (``Landflow-*``) never reach the
core. ``nats-py`` is asyncio, so the driver runs one event loop on a thread of its own and every blocking method
bridges to it with ``run_coroutine_threadsafe``; subscription callbacks hand events to a pool of ``prefetch`` workers.
"""

from __future__ import annotations

import asyncio
import logging
import math
import re
import ssl
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Callable, Coroutine
from urllib.parse import parse_qs, unquote

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

log = logging.getLogger("landflow_sdk.transport.nats")

NATS_HEADER_PREFIX = "ce-"
_REPLY_HEADER = "Landflow-Reply"
_ATTEMPT_HEADER = "Landflow-Attempt"
_TTL_HEADER = "Nats-TTL"
_REQUEUE_DELAY_S = 0.025
# How long a core publish waits past its flush for the server's "no responders" (the Go driver's 1 ms).
_NO_RESPONDERS_WAIT_S = 0.001
DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024
DEFAULT_ACK_WAIT_MS = 30_000
DEFAULT_MAX_AGE_MS = 60 * 60_000
_PULL_EXPIRES_S = 30.0
_CALL_TIMEOUT_S = 30.0

NATS_CORE_CAPABILITIES = Capabilities(
    replies="native", work_sharing=True, buffering=False, ttl=False, undeliverable="reported", persistence="memory",
    max_message_bytes=DEFAULT_MAX_MESSAGE_BYTES, latency="low", headers=True, ordering_keys=False, nack=True, attempts=True,
)
JETSTREAM_CAPABILITIES = Capabilities(
    replies="native", work_sharing=True, buffering=True, ttl=False, undeliverable="inferred", persistence="disk",
    max_message_bytes=DEFAULT_MAX_MESSAGE_BYTES, latency="low", headers=True, ordering_keys=False, nack=True, attempts=True,
)


@dataclass
class NatsConfig(BrokerConfig):
    servers: list[str] = field(default_factory=list)
    user: str | None = None
    password: str | None = None
    token: str | None = None
    tls: bool = False
    name: str | None = None
    connect_timeout_ms: int = 10_000
    max_message_bytes: int = DEFAULT_MAX_MESSAGE_BYTES
    # JetStream only.
    stream_prefix: str = ""
    ack_wait_ms: int = DEFAULT_ACK_WAIT_MS
    max_age_ms: int = DEFAULT_MAX_AGE_MS
    storage: str = "file"
    replicas: int = 1


JetStreamConfig = NatsConfig


# The token ``jetstream`` mode puts in front of every channel name, so the two NATS kinds never share a subject on one server.
JETSTREAM_SUBJECT_TOKEN = "js"


def stream_name_of(channel: str, prefix: str = "") -> str:
    """Stream and consumer names may not contain ``.``, ``*`` or ``>``."""
    return prefix + channel.replace(".", "_")


def _ttl_header(ms: int) -> str:
    return f"{max(1, math.ceil(ms / 1000))}s"


class _NatsDelivery(Delivery):
    def __init__(self, attempt: int, ack: Callable[[], None], nack: Callable[[bool], None], reply: Callable[[WireEvent], None]) -> None:
        self.attempt = attempt
        self._ack, self._nack, self._reply = ack, nack, reply
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

    def reply(self, event: WireEvent) -> None:
        self._reply(event)


class _NatsSubscription(Subscription):
    def __init__(self, channel: str, close: Callable[[], None]) -> None:
        self.channel = channel
        self._close = close

    def close(self) -> None:
        self._close()


class NatsDriver(BrokerDriver):
    """One driver class for both kinds; the module decides the kind and the capabilities."""

    def __init__(self, kind: str, mode: str, capabilities: Capabilities) -> None:
        self.kind = kind
        self.mode = mode
        self.capabilities = capabilities.copy()
        self._config: NatsConfig | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._nc: Any = None
        self._js: Any = None
        self._online = False
        self._closing = False
        self._specs: dict[str, ChannelSpec] = {}
        self._streams: set[str] = set()
        self._subscriptions: set[_NatsSubscription] = set()
        self._inbox = ""
        self._inbox_sub: Any = None
        self._inbox_seq = 0
        # A core publish's inbox token → the future its 503 (no responders) resolves.
        self._no_responders: dict[str, asyncio.Future[None]] = {}
        self._waiters: dict[str, Callable[[WireEvent], None]] = {}
        self._lock = threading.Lock()

    @property
    def connection(self) -> Any:
        return self._nc

    # --- the loop thread --------------------------------------------------------------------------------------------------

    def _run(self, coro: Coroutine[Any, Any, Any], timeout: float = _CALL_TIMEOUT_S) -> Any:
        loop = self._loop
        if loop is None:
            coro.close()
            raise NotConnectedError(f"{self.kind} driver is not connected")
        if threading.current_thread() is self._thread:
            raise RuntimeError("blocking call on the NATS loop thread")
        return asyncio.run_coroutine_threadsafe(coro, loop).result(timeout)

    def connect(self, config: NatsConfig) -> None:
        if self._nc is not None:
            raise RuntimeError("NATS driver is already connected")
        nats = _import_client(self.kind)
        self._config = config
        loop = asyncio.new_event_loop()
        self._loop = loop
        self._thread = threading.Thread(target=loop.run_forever, name=f"nats-{config.connection_id}", daemon=True)
        self._thread.start()

        async def open_connection() -> None:
            servers = [s if "://" in s else f"nats://{s}" for s in config.servers]
            options: dict[str, Any] = {
                "servers": servers, "name": config.name or f"landflow-{config.connection_id}", "connect_timeout": max(1, int(config.connect_timeout_ms / 1000)),
                "max_reconnect_attempts": -1, "reconnect_time_wait": 1, "allow_reconnect": True,
                "disconnected_cb": self._on_disconnected, "reconnected_cb": self._on_reconnected, "closed_cb": self._on_closed, "error_cb": self._on_error,
            }
            if config.user is not None:
                options["user"], options["password"] = config.user, config.password or ""
            if config.token:
                options["token"] = config.token
            if config.tls:
                options["tls"] = ssl.create_default_context()
            nc = await nats.connect(**options)
            try:
                if self.mode == "jetstream":
                    self._js = nc.jetstream(timeout=max(1, config.connect_timeout_ms / 1000))
                    await self._js.account_info()
            except Exception:
                await nc.close()
                raise
            self._nc = nc
            self._online = True
            server_max = getattr(nc, "max_payload", 0) or 0
            wanted = config.max_message_bytes or self.capabilities.max_message_bytes
            self.capabilities.max_message_bytes = min(wanted, server_max) if server_max > 0 else wanted
            self._inbox = nc.new_inbox()
            self._inbox_sub = await nc.subscribe(f"{self._inbox}.*", cb=self._on_inbox)

        try:
            self._run(open_connection(), timeout=config.connect_timeout_ms / 1000 + 5)
        except Exception as exc:  # noqa: BLE001
            self._stop_loop()
            raise RuntimeError(f"{self.kind}: cannot connect to {','.join(config.servers)}: {exc}") from exc

    async def _on_disconnected(self) -> None:
        self._online = False

    async def _on_reconnected(self) -> None:
        self._online = True

    async def _on_closed(self) -> None:
        self._online = False

    async def _on_error(self, error: Exception) -> None:
        log.debug("nats: %s", error)

    def _stop_loop(self) -> None:
        loop, self._loop = self._loop, None
        if loop is not None:
            loop.call_soon_threadsafe(loop.stop)
            if self._thread is not None and threading.current_thread() is not self._thread:
                self._thread.join(5)
            loop.close()

    def close(self) -> None:
        nc = self._nc
        if nc is None or self._closing:
            return
        self._closing = True
        for subscription in list(self._subscriptions):
            try:
                subscription.close()
            except Exception:  # noqa: BLE001
                pass
        self._subscriptions.clear()
        self._waiters.clear()

        async def shutdown() -> None:
            try:
                if self._online:
                    await asyncio.wait_for(nc.flush(), 1.0)
            except Exception:  # noqa: BLE001
                pass
            await nc.close()

        try:
            self._run(shutdown(), timeout=10)
        except Exception:  # noqa: BLE001
            pass
        self._online = False
        self._nc = None
        self._js = None
        self._stop_loop()

    def _ensure(self) -> Any:
        if self._nc is None or not self._online or self._closing:
            raise NotConnectedError(f"{self.kind} driver is not connected")
        return self._nc

    # --- channels ---------------------------------------------------------------------------------------------------------

    def declare(self, channels: list[ChannelSpec]) -> None:
        self._ensure()
        for spec in channels:
            self._specs[spec.name] = spec
            if self.mode == "jetstream" and spec.delivery == "shared" and spec.durable:
                self._run(self._ensure_stream(spec))

    def _subject_of(self, channel: str) -> str:
        """The NATS subject of a channel: the channel itself for ``nats``, ``js.<channel>`` for ``jetstream``."""
        return f"{JETSTREAM_SUBJECT_TOKEN}.{channel}" if self.mode == "jetstream" else channel

    def _channel_of(self, subject: str) -> str:
        """The channel name of a subject produced by ``_subject_of``."""
        head = f"{JETSTREAM_SUBJECT_TOKEN}."
        return subject[len(head):] if self.mode == "jetstream" and subject.startswith(head) else subject

    def _stream_name(self, channel: str) -> str:
        return stream_name_of(self._subject_of(channel), self._config.stream_prefix if self._config else "")

    async def _ensure_stream(self, spec: ChannelSpec) -> None:
        from nats.js import api

        config = self._config
        assert config is not None
        name = self._stream_name(spec.name)
        stream_config = api.StreamConfig(
            name=name, subjects=[self._subject_of(spec.name)], retention=api.RetentionPolicy.WORK_QUEUE,
            storage=api.StorageType.MEMORY if config.storage == "memory" else api.StorageType.FILE, discard=api.DiscardPolicy.OLD,
            max_age=(spec.ttl_ms if spec.ttl_ms is not None else config.max_age_ms) / 1000, max_msg_size=self.capabilities.max_message_bytes,
            num_replicas=config.replicas, allow_msg_ttl=True,
        )
        try:
            await self._js.add_stream(stream_config)
        except Exception as exc:  # noqa: BLE001
            # 10058: a stream with this name exists with another configuration: use it as is.
            if getattr(exc, "err_code", None) != 10058 and "already in use" not in str(exc):
                raise
            await self._js.stream_info(name)

    async def _is_stream(self, channel: str) -> bool:
        if self.mode != "jetstream":
            return False
        spec = self._specs.get(channel)
        if spec is not None:
            return spec.delivery == "shared" and spec.durable
        if channel in self._streams:
            return True
        try:
            await self._js.find_stream_name_by_subject(self._subject_of(channel))
            self._streams.add(channel)
            return True
        except Exception as exc:  # noqa: BLE001
            if getattr(exc, "err_code", None) == 10059 or "not found" in str(exc).lower():
                return False
            raise

    # --- headers ----------------------------------------------------------------------------------------------------------

    @staticmethod
    def _to_headers(headers: dict[str, str]) -> dict[str, str]:
        return dict(prefix_headers(headers, NATS_HEADER_PREFIX))

    @staticmethod
    def _from_msg(msg: Any) -> WireEvent:
        return WireEvent(unprefix_headers(dict(msg.headers or {}), NATS_HEADER_PREFIX), bytes(msg.data))

    async def _on_inbox(self, msg: Any) -> None:
        token = msg.subject[len(self._inbox) + 1:]
        status = (msg.headers or {}).get("Status")
        if status == "503":
            future = self._no_responders.get(token)
            if future is not None and not future.done():
                future.set_result(None)
            return
        waiter = self._waiters.get(token)
        if waiter is not None:
            waiter(self._from_msg(msg))

    # --- publish / request ------------------------------------------------------------------------------------------------

    def publish(self, channel: str, event: WireEvent, options: PublishOptions | None = None) -> str:
        nc = self._ensure()
        headers = self._to_headers(event.headers)

        async def do() -> str:
            if await self._is_stream(channel):
                if options and options.ttl_ms:
                    headers[_TTL_HEADER] = _ttl_header(options.ttl_ms)
                await self._js.publish(self._subject_of(channel), event.body, headers=headers, timeout=10)
                return "accepted"
            # Core: publish with a reply inbox of ours and flush; the server answers a publish nobody subscribes to with a
            # 503 on that inbox. The 503 can arrive just after the flush's PONG, so wait for it up to
            # _NO_RESPONDERS_WAIT_S past the flush, as the Go driver does (replies and requests don't pay this).
            self._inbox_seq += 1
            token = str(self._inbox_seq)
            no_responders = asyncio.get_running_loop().create_future()
            self._no_responders[token] = no_responders
            try:
                await nc.publish(self._subject_of(channel), event.body, reply=f"{self._inbox}.{token}", headers=headers)
                await nc.flush()
                await asyncio.wait_for(no_responders, _NO_RESPONDERS_WAIT_S)
                return "unroutable"
            except asyncio.TimeoutError:
                return "accepted"
            finally:
                self._no_responders.pop(token, None)

        return self._run(do())

    def request(self, channel: str, event: WireEvent, timeout_ms: int, ordering_key: str | None = None) -> RequestOutcome:
        nc = self._ensure()
        import nats.errors as errors

        headers = self._to_headers(event.headers)
        timeout_s = timeout_ms / 1000

        async def do() -> RequestOutcome:
            if await self._is_stream(channel):
                self._inbox_seq += 1
                token = str(self._inbox_seq)
                headers[_REPLY_HEADER] = f"{self._inbox}.{token}"
                headers[_TTL_HEADER] = _ttl_header(timeout_ms)
                future: asyncio.Future = asyncio.get_running_loop().create_future()
                self._waiters[token] = lambda reply: (not future.done()) and future.set_result(reply)
                try:
                    await self._js.publish(self._subject_of(channel), event.body, headers=headers, timeout=min(timeout_s, 10))
                    reply = await asyncio.wait_for(future, timeout_s)
                    return RequestOutcome("replied", reply)
                except asyncio.TimeoutError:
                    return RequestOutcome("timeout")
                finally:
                    self._waiters.pop(token, None)
            try:
                msg = await nc.request(self._subject_of(channel), event.body, timeout=timeout_s, headers=headers)
                return RequestOutcome("replied", self._from_msg(msg))
            except errors.NoRespondersError:
                return RequestOutcome("unroutable")
            except (errors.TimeoutError, asyncio.TimeoutError):
                return RequestOutcome("timeout")

        return self._run(do(), timeout=timeout_s + 5)

    # --- consume ----------------------------------------------------------------------------------------------------------

    def consume(self, channel: str, options: ConsumeOptions, on_event: ConsumeHandler) -> Subscription:
        self._ensure()

        async def do() -> _NatsSubscription:
            if await self._is_stream(channel):
                return await self._consume_stream(channel, options, on_event)
            subscription = await self._consume_core(channel, options, on_event)
            await self._nc.flush()  # the server has the subscription before this returns
            return subscription

        subscription = self._run(do())
        self._subscriptions.add(subscription)
        return subscription

    async def _consume_core(self, channel: str, options: ConsumeOptions, on_event: ConsumeHandler) -> _NatsSubscription:
        nc = self._nc
        loop = asyncio.get_running_loop()
        manual = options.ack_mode == "manual"
        in_flight: dict[int, Any] = {}  # id(msg) -> msg (Msg is not hashable)
        backlog: list[Any] = []
        closed = {"value": False}
        pool = ThreadPoolExecutor(max_workers=max(1, options.prefetch), thread_name_prefix=f"nats-{channel}")

        def attempt_of(msg: Any) -> int:
            raw = (msg.headers or {}).get(_ATTEMPT_HEADER)
            return int(raw) if raw and raw.isdigit() and int(raw) > 0 else 1

        def reply_of(msg: Any) -> str | None:
            return (msg.headers or {}).get(_REPLY_HEADER) or msg.reply or None

        async def republish(msg: Any, attempt: int) -> None:
            if not self._online or self._nc is None:
                return
            headers = dict(msg.headers or {})
            headers[_ATTEMPT_HEADER] = str(attempt)
            reply = reply_of(msg)
            if reply:
                headers[_REPLY_HEADER] = reply
            else:
                headers.pop(_REPLY_HEADER, None)
            try:
                await self._nc.publish(msg.subject, msg.data, headers=headers)
                await self._nc.flush()
            except Exception:  # noqa: BLE001
                pass

        def pump() -> None:
            while not closed["value"] and backlog and len(in_flight) < options.prefetch:
                deliver(backlog.pop(0))

        def deliver(msg: Any) -> None:
            if manual:
                in_flight[id(msg)] = msg
            attempt = attempt_of(msg)

            def settle() -> None:
                def done() -> None:
                    in_flight.pop(id(msg), None)
                    pump()

                loop.call_soon_threadsafe(done)

            def nack(requeue: bool) -> None:
                settle()
                if requeue and not closed["value"]:
                    async def later() -> None:
                        await asyncio.sleep(_REQUEUE_DELAY_S)
                        await republish(msg, attempt + 1)

                    asyncio.run_coroutine_threadsafe(later(), loop)

            def reply(event: WireEvent) -> None:
                to = reply_of(msg)
                if not to:
                    return
                self._ensure()
                self._run(nc.publish(to, event.body, headers=self._to_headers(event.headers)))

            delivery = _NatsDelivery(attempt, settle, nack, reply)
            event = self._from_msg(msg)

            def handle() -> None:
                try:
                    on_event(event, delivery)
                except Exception:  # noqa: BLE001
                    delivery.nack(requeue=False)

            try:
                pool.submit(handle)
            except RuntimeError:
                pass

        async def callback(msg: Any) -> None:
            if closed["value"]:
                return
            if manual and len(in_flight) >= options.prefetch:
                backlog.append(msg)
            else:
                deliver(msg)

        sub = await nc.subscribe(self._subject_of(channel), queue=options.group or "", cb=callback)

        def close() -> None:
            if closed["value"]:
                return
            closed["value"] = True
            self._subscriptions.discard(subscription)

            async def do_close() -> None:
                try:
                    await sub.unsubscribe()
                except Exception:  # noqa: BLE001
                    pass
                orphans = list(in_flight.values()) + backlog[:]
                in_flight.clear()
                backlog.clear()
                for msg in orphans:
                    await republish(msg, attempt_of(msg) + 1)

            try:
                self._run(do_close(), timeout=10)
            except Exception:  # noqa: BLE001
                pass
            pool.shutdown(wait=False)

        subscription = _NatsSubscription(channel, close)
        return subscription

    async def _consume_stream(self, channel: str, options: ConsumeOptions, on_event: ConsumeHandler) -> _NatsSubscription:
        from nats.js import api
        from nats.js.errors import FetchTimeoutError

        config = self._config
        assert config is not None
        loop = asyncio.get_running_loop()
        stream = self._stream_name(channel)
        name = stream_name_of(options.group or channel)
        ack_wait_s = config.ack_wait_ms / 1000
        consumer_config = api.ConsumerConfig(
            durable_name=name, filter_subject=self._subject_of(channel), ack_policy=api.AckPolicy.EXPLICIT, deliver_policy=api.DeliverPolicy.ALL,
            replay_policy=api.ReplayPolicy.INSTANT, ack_wait=ack_wait_s, max_ack_pending=-1, max_deliver=-1,
        )
        try:
            await self._js.add_consumer(stream, config=consumer_config)
        except Exception as exc:  # noqa: BLE001
            try:
                await self._js.consumer_info(stream, name)
            except Exception:
                raise exc from None
        psub = await self._js.pull_subscribe(self._subject_of(channel), durable=name, stream=stream)
        manual = options.ack_mode == "manual"
        in_flight: dict[int, Any] = {}
        closed = {"value": False}
        wake = asyncio.Event()
        pool = ThreadPoolExecutor(max_workers=max(1, options.prefetch), thread_name_prefix=f"jetstream-{channel}")
        progress_tasks: dict[int, asyncio.Task] = {}

        async def progress(msg: Any) -> None:
            interval = max(1.0, ack_wait_s / 3)
            while True:
                await asyncio.sleep(interval)
                try:
                    await msg.in_progress()
                except Exception:  # noqa: BLE001
                    return

        def deliver(msg: Any) -> None:
            if manual:
                in_flight[id(msg)] = msg
                progress_tasks[id(msg)] = loop.create_task(progress(msg))
            attempt = int(getattr(msg.metadata, "num_delivered", 1) or 1)

            def finish() -> None:
                task = progress_tasks.pop(id(msg), None)
                if task is not None:
                    task.cancel()
                in_flight.pop(id(msg), None)
                wake.set()

            def ack() -> None:
                async def do() -> None:
                    finish()
                    try:
                        await asyncio.wait_for(msg.ack_sync(), 5)
                    except Exception:  # noqa: BLE001
                        try:
                            await msg.ack()
                        except Exception:  # noqa: BLE001
                            pass

                try:
                    self._run(do(), timeout=10)
                except Exception:  # noqa: BLE001
                    pass

            def nack(requeue: bool) -> None:
                async def do() -> None:
                    finish()
                    try:
                        if requeue:
                            await msg.nak(delay=_REQUEUE_DELAY_S)
                        else:
                            await msg.term()
                    except Exception:  # noqa: BLE001
                        pass

                try:
                    self._run(do(), timeout=10)
                except Exception:  # noqa: BLE001
                    pass

            def reply(event: WireEvent) -> None:
                to = (msg.headers or {}).get(_REPLY_HEADER)
                if not to:
                    return
                nc = self._ensure()
                self._run(nc.publish(to, event.body, headers=self._to_headers(event.headers)))

            delivery = _NatsDelivery(attempt, ack, nack, reply)
            event = self._from_msg(msg)
            if not manual:
                loop.create_task(msg.ack())

            def handle() -> None:
                try:
                    on_event(event, delivery)
                except Exception:  # noqa: BLE001
                    delivery.nack(requeue=False)

            try:
                pool.submit(handle)
            except RuntimeError:
                pass

        async def fetch_loop() -> None:
            while not closed["value"]:
                free = options.prefetch - len(in_flight)
                if free <= 0:
                    wake.clear()
                    await wake.wait()
                    continue
                try:
                    msgs = await psub.fetch(free, timeout=_PULL_EXPIRES_S)
                except (FetchTimeoutError, asyncio.TimeoutError):
                    continue
                except Exception:  # noqa: BLE001
                    if not closed["value"]:
                        await asyncio.sleep(0.25 if self._online else 1.0)
                    continue
                for msg in msgs:
                    if closed["value"]:
                        try:
                            await msg.nak()
                        except Exception:  # noqa: BLE001
                            pass
                    else:
                        deliver(msg)

        task = loop.create_task(fetch_loop())

        def close() -> None:
            if closed["value"]:
                return
            closed["value"] = True
            self._subscriptions.discard(subscription)

            async def do_close() -> None:
                wake.set()
                task.cancel()
                try:
                    await psub.unsubscribe()
                except Exception:  # noqa: BLE001
                    pass
                for held in list(in_flight.values()):
                    progress_task = progress_tasks.pop(id(held), None)
                    if progress_task is not None:
                        progress_task.cancel()
                    try:
                        await held.nak()
                    except Exception:  # noqa: BLE001
                        pass
                in_flight.clear()
                if self._online:
                    try:
                        await asyncio.wait_for(self._nc.flush(), 1.0)
                    except Exception:  # noqa: BLE001
                        pass

            try:
                self._run(do_close(), timeout=10)
            except Exception:  # noqa: BLE001
                pass
            pool.shutdown(wait=False)

        subscription = _NatsSubscription(channel, close)
        return subscription

    # --- stats ------------------------------------------------------------------------------------------------------------

    def stats(self, channel: str) -> ChannelStats:
        self._ensure()
        if self.mode != "jetstream":
            return ChannelStats()
        stream = self._stream_name(channel)
        consumer = stream_name_of(channel)

        async def sample() -> ChannelStats:
            try:
                info = await self._js.consumer_info(stream, consumer)
                waiting = getattr(info, "num_waiting", 0) or 0
                pending_ack = getattr(info, "num_ack_pending", 0) or 0
                return ChannelStats(depth=getattr(info, "num_pending", 0) or 0, consumers=waiting + (1 if pending_ack > 0 else 0))
            except Exception as exc:  # noqa: BLE001
                if getattr(exc, "err_code", None) not in (10014, None) and "not found" not in str(exc).lower():
                    raise
            try:
                info = await self._js.stream_info(stream)
                return ChannelStats(depth=info.state.messages, consumers=0)
            except Exception as exc:  # noqa: BLE001
                if getattr(exc, "err_code", None) == 10059 or "not found" in str(exc).lower():
                    return ChannelStats(depth=0, consumers=0)
                raise

        async def do() -> ChannelStats:
            first = await sample()
            if first.consumers != 0:
                return first
            await asyncio.sleep(0.05)
            return await sample()

        return self._run(do())


def nats_config_from(connection_id: str, url: str, options: dict[str, Any] | None = None) -> NatsConfig:
    """``nats://host:4222``, a comma-separated host list, ``tls://host:4222``, ``nats://user:pass@host`` or ``nats://token@host``;
    ``username``/``password``/``tls`` in ``options`` win over the URL."""
    options = dict(options or {})
    trimmed = (url or "").strip()
    match = re.match(r"^(nats|tls|ws|wss)://(?:([^@/]*)@)?([^/?#]+)/?(?:\?(.*))?$", trimmed)
    if not match:
        raise ValueError(f'NATS URL "{url}" must look like nats://host:4222[,host2:4222] (or tls://host:4222)')
    scheme, userinfo, hosts, query = match.groups()
    servers = [h.strip() for h in hosts.split(",") if h.strip()]
    if not servers or any(not re.match(r"^[A-Za-z0-9.:_\[\]-]+$", h) for h in servers):
        raise ValueError(f'NATS URL "{url}" has an invalid host list')
    user = password = token = None
    if userinfo:
        if ":" in userinfo:
            user, password = (unquote(p) for p in userinfo.split(":", 1))
        else:
            token = unquote(userinfo)
    if options.get("username"):
        user = str(options["username"])
    if options.get("password"):
        password = str(options["password"])
    if options.get("token"):
        token = str(options["token"])
    params = parse_qs(query or "")
    if params.get("token"):
        token = params["token"][0]
    if user and token:
        raise ValueError("NATS connection: use either a username and password or a token, not both")
    tls = bool(options["tls"]) if "tls" in options else scheme in ("tls", "wss")
    config = NatsConfig(connection_id=connection_id, prefix=options.get("prefix") or None, servers=[f"{scheme}://{h}" if scheme in ("ws", "wss") else h for h in servers], tls=tls)
    if user:
        config.user, config.password = user, password or ""
    if token:
        config.token = token
    for key, attr in (("maxMessageBytes", "max_message_bytes"), ("ackWaitMs", "ack_wait_ms"), ("maxAgeMs", "max_age_ms"), ("replicas", "replicas")):
        if options.get(key) not in (None, ""):
            setattr(config, attr, int(options[key]))
    if options.get("streamPrefix"):
        config.stream_prefix = str(options["streamPrefix"])
    if options.get("storage") in ("memory", "file"):
        config.storage = str(options["storage"])
    return config


def nats_driver() -> NatsDriver:
    return NatsDriver("nats", "core", NATS_CORE_CAPABILITIES)


def jetstream_driver() -> NatsDriver:
    return NatsDriver("jetstream", "jetstream", JETSTREAM_CAPABILITIES)


def nats(url: str, *, connection_id: str = "env-nats", **options: Any) -> "BrokerTarget":
    """SDK helper: ``serve(plugin, brokers=[nats("nats://127.0.0.1:54222")])``."""
    from ..binding import BrokerTarget

    return BrokerTarget("nats", nats_config_from(connection_id, url, options), nats_driver)


def jetstream(url: str, *, connection_id: str = "env-jetstream", **options: Any) -> "BrokerTarget":
    """SDK helper: ``serve(plugin, brokers=[jetstream("nats://127.0.0.1:54222")])``."""
    from ..binding import BrokerTarget

    return BrokerTarget("jetstream", nats_config_from(connection_id, url, options), jetstream_driver)


NATS_MODULE = SimpleDriverModule(kind="nats", label="NATS (core)", capabilities=NATS_CORE_CAPABILITIES, create=nats_driver, config_from=nats_config_from,
                                 example_url="nats://127.0.0.1:54222", extras=("nats",))
JETSTREAM_MODULE = SimpleDriverModule(kind="jetstream", label="NATS JetStream", capabilities=JETSTREAM_CAPABILITIES, create=jetstream_driver, config_from=nats_config_from,
                                      example_url="nats://127.0.0.1:54222", extras=("nats",))
