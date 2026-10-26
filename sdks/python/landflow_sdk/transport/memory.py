"""An in-process broker and its driver, for tests and for running the core without a broker (the counterpart of
``@landflow/transports/memory`` and ``sdks/go/transport/memory``).

One ``MemoryBroker`` is shared by any number of driver instances (a "host" and several "plugin replicas" in one
process); its capabilities are configurable so tests can simulate a broker without headers, without native replies,
with a small message limit, that cannot report undeliverable events, or with latency. Semantics (the reference the
conformance suite compares every real driver with): work sharing by group (round robin among consumers under their
prefetch, FIFO per channel), buffering while no consumer is attached, ``nack(requeue=True)`` back at the head with
``attempt + 1``, a closed subscription requeues what it held, native replies when ``replies == 'native'``, TTL checked
at dequeue. Handlers run on a thread pool per consumer, as a real driver's would.
"""

from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Callable

from .driver import (
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
    Subscription,
    WireEvent,
)

MEMORY_CAPABILITIES = Capabilities(
    replies="reply-channel", work_sharing=True, buffering=True, ttl=True, undeliverable="reported", persistence="memory",
    max_message_bytes=1024 * 1024, latency="low", headers=True, ordering_keys=True, nack=True, attempts=True,
)

Tap = Callable[[str, WireEvent], "WireEvent | None"]


def _clone(event: WireEvent) -> WireEvent:
    return WireEvent(dict(event.headers), bytes(event.body))


@dataclass(eq=False)
class _Message:
    event: WireEvent
    attempt: int = 1
    expires_at: float | None = None
    ordering_key: str | None = None
    reply_to: Callable[[WireEvent], None] | None = None


@dataclass
class _Consumer:
    id: int
    driver: "MemoryDriver"
    options: ConsumeOptions
    handler: ConsumeHandler
    group: str | None
    pool: ThreadPoolExecutor
    in_flight: set = field(default_factory=set)
    closed: bool = False


@dataclass
class _Group:
    name: str
    queue: list = field(default_factory=list)
    consumers: list = field(default_factory=list)
    next: int = 0


@dataclass
class _Channel:
    spec: ChannelSpec | None = None
    groups: dict = field(default_factory=dict)
    broadcast: list = field(default_factory=list)
    pending: list = field(default_factory=list)


class MemoryBroker:
    def __init__(self, capabilities: Capabilities | None = None, latency_ms: int = 0, **overrides: object) -> None:
        base = capabilities or MEMORY_CAPABILITIES
        self.capabilities = base.copy(**overrides) if overrides else base.copy()
        self.latency_ms = latency_ms
        self._lock = threading.RLock()
        self._channels: dict[str, _Channel] = {}
        self._taps: list[Tap] = []
        self._ids = 0
        #: Events accepted by ``publish()`` / ``request()`` so far.
        self.published = 0

    def driver(self) -> "MemoryDriver":
        """A new, unconnected driver on this broker."""
        return MemoryDriver(self)

    def tap(self, tap: Tap) -> Callable[[], None]:
        """See (and alter or drop, by returning ``None``) every event in flight; native replies under ``<channel>:reply``."""
        self._taps.append(tap)
        return lambda: self._taps.remove(tap)

    def _channel(self, name: str) -> _Channel:
        channel = self._channels.get(name)
        if channel is None:
            channel = self._channels[name] = _Channel()
        return channel

    def declare(self, specs: list[ChannelSpec]) -> None:
        with self._lock:
            for spec in specs:
                self._channel(spec.name).spec = spec

    def stats(self, name: str) -> ChannelStats:
        with self._lock:
            channel = self._channels.get(name)
            if channel is None:
                return ChannelStats(depth=0, consumers=0)
            depth = len(channel.pending)
            consumers = len(channel.broadcast)
            for group in channel.groups.values():
                depth = max(depth, len(group.queue))
                consumers += len(group.consumers)
            return ChannelStats(depth=depth, consumers=consumers)

    def has_consumers(self, name: str) -> bool:
        return (self.stats(name).consumers or 0) > 0

    def publish(self, name: str, event: WireEvent, options: PublishOptions | None = None, reply_to: Callable[[WireEvent], None] | None = None) -> str:
        options = options or PublishOptions()
        size = sum(len(k.encode()) + len(v.encode()) for k, v in event.headers.items()) + len(event.body)
        if size > self.capabilities.max_message_bytes:
            raise ValueError(f"message of {size} bytes exceeds the broker limit of {self.capabilities.max_message_bytes}")
        carried: WireEvent | None = _clone(event)
        for tap in list(self._taps):
            carried = tap(name, carried)
            if carried is None:
                return "accepted"
        if not self.capabilities.headers:
            content_type = carried.headers.get("content-type")
            carried = WireEvent({"content-type": content_type} if content_type else {}, carried.body)
        expires = time.monotonic() + options.ttl_ms / 1000 if self.capabilities.ttl and options.ttl_ms is not None else None
        message = _Message(carried, 1, expires, options.ordering_key, reply_to)
        with self._lock:
            channel = self._channel(name)
            if not self.has_consumers(name):
                if self.capabilities.undeliverable == "reported":
                    return "unroutable"
                if self.capabilities.buffering:
                    channel.pending.append(message)
                self.published += 1
                return "accepted"
            self.published += 1
            for consumer in list(channel.broadcast):
                self._deliver(consumer, _Message(_clone(message.event), 1, expires, options.ordering_key, reply_to), None)
            for group in channel.groups.values():
                group.queue.append(message if len(channel.groups) == 1 else _Message(_clone(message.event), 1, expires, options.ordering_key, reply_to))
                self._pump(name, group)
        return "accepted"

    def consume(self, driver: "MemoryDriver", name: str, options: ConsumeOptions, handler: ConsumeHandler) -> _Consumer:
        with self._lock:
            channel = self._channel(name)
            self._ids += 1
            group_name = options.group if self.capabilities.work_sharing else None
            pool = ThreadPoolExecutor(max_workers=max(1, options.prefetch), thread_name_prefix=f"memory-{name}")
            consumer = _Consumer(self._ids, driver, options, handler, group_name, pool)
            if group_name:
                group = channel.groups.get(group_name)
                if group is None:
                    group = channel.groups[group_name] = _Group(name)
                group.consumers.append(consumer)
                if channel.pending:
                    group.queue.extend(channel.pending)
                    channel.pending = []
                self._pump(name, group)
            else:
                channel.broadcast.append(consumer)
                pending, channel.pending = channel.pending, []
                for message in pending:
                    self._deliver(consumer, message, None)
            return consumer

    def unsubscribe(self, name: str, consumer: _Consumer) -> None:
        with self._lock:
            if consumer.closed:
                return
            consumer.closed = True
            channel = self._channel(name)
            if consumer.group:
                group = channel.groups.get(consumer.group)
                if group is None:
                    return
                group.consumers = [c for c in group.consumers if c is not consumer]
                for message in list(consumer.in_flight):
                    group.queue.insert(0, _Message(message.event, message.attempt + 1, message.expires_at, message.ordering_key, message.reply_to))
                consumer.in_flight.clear()
                if not group.consumers:
                    channel.pending.extend(group.queue)
                    del channel.groups[consumer.group]
                else:
                    self._pump(name, group)
            else:
                channel.broadcast = [c for c in channel.broadcast if c is not consumer]
        consumer.pool.shutdown(wait=False, cancel_futures=False)

    def _pump(self, name: str, group: _Group) -> None:
        while group.queue:
            candidates = [c for c in group.consumers if not c.closed and len(c.in_flight) < c.options.prefetch]
            if not candidates:
                return
            message = group.queue.pop(0)
            if message.expires_at is not None and message.expires_at <= time.monotonic():
                continue
            consumer = candidates[group.next % len(candidates)]
            group.next += 1
            self._deliver(consumer, message, group)

    def _deliver(self, consumer: _Consumer, message: _Message, group: _Group | None) -> None:
        manual = consumer.options.ack_mode == "manual" and group is not None
        if manual:
            consumer.in_flight.add(message)
        broker = self
        state = {"settled": not manual}

        def settle() -> bool:
            with broker._lock:
                if state["settled"]:
                    return False
                state["settled"] = True
                consumer.in_flight.discard(message)
                return True

        class _MemoryDelivery(Delivery):
            attempt = message.attempt

            def ack(self) -> None:
                if settle() and group is not None:
                    with broker._lock:
                        broker._pump(group.name, group)

            def nack(self, *, requeue: bool = False) -> None:
                if not settle() or group is None:
                    return
                with broker._lock:
                    if requeue and broker.capabilities.nack:
                        group.queue.insert(0, _Message(message.event, message.attempt + 1, message.expires_at, message.ordering_key, message.reply_to))
                    broker._pump(group.name, group)

            def reply(self, event: WireEvent) -> None:
                if broker.capabilities.replies != "native":
                    raise NotImplementedError("this broker has no native replies")
                if not consumer.driver.connected:
                    raise NotConnectedError("memory driver is not connected")
                carried: WireEvent | None = _clone(event)
                for tap in list(broker._taps):
                    carried = tap(f"{group.name if group else ''}:reply", carried)
                    if carried is None:
                        return
                if message.reply_to is not None:
                    message.reply_to(carried)

        delivery = _MemoryDelivery()

        def run() -> None:
            if consumer.closed or not consumer.driver.connected:
                return
            try:
                consumer.handler(_clone(message.event), delivery)
            except Exception:  # noqa: BLE001
                delivery.nack(requeue=False)

        def submit() -> None:
            try:
                consumer.pool.submit(run)
            except RuntimeError:
                pass

        if self.latency_ms:
            threading.Timer(self.latency_ms / 1000, submit).start()
        else:
            submit()


class _MemorySubscription(Subscription):
    def __init__(self, driver: "MemoryDriver", channel: str, consumer: _Consumer) -> None:
        self.channel = channel
        self._driver = driver
        self._consumer = consumer

    def close(self) -> None:
        self._driver.broker.unsubscribe(self.channel, self._consumer)
        self._driver._subscriptions.discard(self)


class MemoryDriver(BrokerDriver):
    kind = "memory"

    def __init__(self, broker: MemoryBroker) -> None:
        self.broker = broker
        self.capabilities = broker.capabilities
        self.connected = False
        self._subscriptions: set[_MemorySubscription] = set()

    def connect(self, config: BrokerConfig) -> None:
        self.connected = True

    def declare(self, channels: list[ChannelSpec]) -> None:
        self._ensure()
        self.broker.declare(channels)

    def publish(self, channel: str, event: WireEvent, options: PublishOptions | None = None) -> str:
        self._ensure()
        return self.broker.publish(channel, event, options)

    def request(self, channel: str, event: WireEvent, timeout_ms: int, ordering_key: str | None = None) -> RequestOutcome:
        self._ensure()
        if self.capabilities.replies != "native":
            raise NotImplementedError("this broker has no native request/reply")
        box: dict[str, WireEvent] = {}
        done = threading.Event()

        def reply_to(event: WireEvent) -> None:
            box["event"] = event
            done.set()

        outcome = self.broker.publish(channel, event, PublishOptions(ordering_key=ordering_key, ttl_ms=timeout_ms), reply_to)
        if outcome == "unroutable":
            return RequestOutcome("unroutable")
        if done.wait(timeout_ms / 1000):
            return RequestOutcome("replied", box["event"])
        return RequestOutcome("timeout")

    def consume(self, channel: str, options: ConsumeOptions, on_event: ConsumeHandler) -> Subscription:
        self._ensure()
        consumer = self.broker.consume(self, channel, options, on_event)
        subscription = _MemorySubscription(self, channel, consumer)
        self._subscriptions.add(subscription)
        return subscription

    def stats(self, channel: str) -> ChannelStats:
        self._ensure()
        return self.broker.stats(channel)

    def close(self) -> None:
        self.connected = False
        for subscription in list(self._subscriptions):
            subscription.close()

    def _ensure(self) -> None:
        if not self.connected:
            raise NotConnectedError("memory driver is not connected")
