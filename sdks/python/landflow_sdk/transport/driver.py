"""The broker driver contract (the Python counterpart of ``@landflow/transports/driver`` and ``sdks/go/transport/driver.go``).

A driver knows one broker and nothing about Landflow: it moves opaque ``WireEvent``s (headers + bytes) between named
channels, shares a channel's events between competing consumers, acknowledges, and reports what it can observe. The
core (``MessagingServer``, ``MessagingClient``) adds everything Landflow-specific on top. A driver must never read or
change event headers or bodies, except to carry them.

**Threading.** The SDK is threaded, so is this contract: every method blocks until the broker answered. ``consume()``
delivers from threads the driver owns and may call ``on_event`` up to ``prefetch`` times concurrently in ``manual``
ack mode; the handler returns once it has acked, nacked or decided to hold the delivery (the server holds it until the
reply is out), so a driver bounds its outstanding handlers by ``prefetch``. ``Delivery`` methods may be called from
any thread.

Layout for driver authors: one module per broker kind in ``landflow_sdk/transport/drivers/<kind>.py`` with a
``DriverModule`` at module level named ``MODULE`` (``kind``, ``capabilities``, ``create()``, ``config_from()``); the
broker's client library is an optional extra imported lazily inside ``connect()``.
"""

from __future__ import annotations

import threading
from abc import ABC, abstractmethod
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field, replace
from typing import Any, Callable, Protocol

from .envelope import WireEvent

__all__ = [
    "BrokerConfig", "BrokerDriver", "Capabilities", "ChannelSpec", "ChannelStats", "ConsumeOptions", "Delivery", "DriverModule",
    "HandlerPool", "NotConnectedError", "PublishOptions", "RequestOutcome", "Subscription", "WireEvent", "prefix_headers", "unprefix_headers",
]


@dataclass
class Capabilities:
    """What the core and the selector may rely on; the conformance suite checks every claim."""

    #: ``native`` (the broker answers on the same connection: NATS inboxes, RabbitMQ direct reply-to) or ``reply-channel``.
    replies: str = "reply-channel"
    work_sharing: bool = True
    buffering: bool = True
    ttl: bool = False
    #: ``reported`` (publish returns ``unroutable`` at once), ``inferred`` (``stats().consumers`` is reliable) or ``unknown``.
    undeliverable: str = "unknown"
    persistence: str = "memory"
    max_message_bytes: int = 1024 * 1024
    latency: str = "medium"
    #: String headers per message: CloudEvents binary mode; else structured mode.
    headers: bool = True
    max_header_bytes: int | None = None
    ordering_keys: bool = False
    nack: bool = False
    attempts: bool = False

    def copy(self, **changes: Any) -> Capabilities:
        return replace(self, **changes)

    def to_dict(self) -> dict[str, Any]:
        """The camelCase form the TS/Go cores use (for logs and the conformance suite)."""
        return {
            "replies": self.replies, "workSharing": self.work_sharing, "buffering": self.buffering, "ttl": self.ttl,
            "undeliverable": self.undeliverable, "persistence": self.persistence, "maxMessageBytes": self.max_message_bytes,
            "latency": self.latency, "headers": self.headers, "maxHeaderBytes": self.max_header_bytes,
            "orderingKeys": self.ordering_keys, "nack": self.nack, "attempts": self.attempts,
        }


@dataclass
class BrokerConfig:
    """The common part of every driver's connection config; drivers extend it (``KafkaConfig(BrokerConfig)``)."""

    #: The host-side name of this broker connection (``kafka-main``): the authority of brokered endpoints.
    connection_id: str = "env"
    #: Channel-name prefix (default ``landflow``).
    prefix: str | None = None


@dataclass
class ChannelSpec:
    """What a channel is for; drivers map roles to the broker's own primitives (queue, topic, subject, stream)."""

    name: str
    role: str  # request | instance | reply | registry | control
    delivery: str  # shared | broadcast
    durable: bool
    ttl_ms: int | None = None


@dataclass
class PublishOptions:
    ordering_key: str | None = None
    ttl_ms: int | None = None


@dataclass
class ConsumeOptions:
    """``group``: consumers with the same group compete (absent: every consumer gets every event); ``prefetch``: most
    deliveries held unacknowledged at once; ``ack_mode``: ``manual`` or ``auto``."""

    prefetch: int = 16
    ack_mode: str = "manual"
    group: str | None = None


@dataclass
class ChannelStats:
    depth: int | None = None
    consumers: int | None = None
    lag: int | None = None


@dataclass
class RequestOutcome:
    """``outcome``: ``replied`` (with ``event``), ``unroutable`` or ``timeout``."""

    outcome: str
    event: WireEvent | None = None


class Delivery(ABC):
    """One delivery of an event to one consumer. Methods are no-ops after the first ack/nack and in ``auto`` ack mode."""

    #: 1 on the first delivery; a redelivery increments it when ``capabilities.attempts``.
    attempt: int = 1

    @abstractmethod
    def ack(self) -> None: ...

    @abstractmethod
    def nack(self, *, requeue: bool = False) -> None: ...

    def reply(self, event: WireEvent) -> None:
        """Native reply to this event's requester; only drivers with ``replies == 'native'`` implement it."""
        raise NotImplementedError("this driver has no native replies")


ConsumeHandler = Callable[[WireEvent, Delivery], None]


class Subscription(ABC):
    channel: str = ""

    @abstractmethod
    def close(self) -> None:
        """Stop delivering. Deliveries still unacknowledged go back to the broker (as if the consumer had died)."""


class NotConnectedError(Exception):
    """Raised by ``publish()`` / ``request()`` when the connection is down **before anything was sent**."""

    def __init__(self, message: str = "not connected to the broker") -> None:
        super().__init__(message)


class BrokerDriver(ABC):
    """A connection to one broker. One instance = one connection; ``connect()`` once, ``close()`` ends everything."""

    kind: str = ""
    capabilities: Capabilities

    @abstractmethod
    def connect(self, config: Any) -> None: ...

    @abstractmethod
    def declare(self, channels: list[ChannelSpec]) -> None: ...

    @abstractmethod
    def publish(self, channel: str, event: WireEvent, options: PublishOptions | None = None) -> str:
        """Send one event; returns ``accepted`` or ``unroutable`` (drivers with ``undeliverable == 'reported'`` only)."""

    @abstractmethod
    def consume(self, channel: str, options: ConsumeOptions, on_event: ConsumeHandler) -> Subscription: ...

    def request(self, channel: str, event: WireEvent, timeout_ms: int, ordering_key: str | None = None) -> RequestOutcome:
        """Native request/reply (required when ``capabilities.replies == 'native'``)."""
        raise NotImplementedError("this driver has no native request/reply")

    def stats(self, channel: str) -> ChannelStats:
        return ChannelStats()

    @abstractmethod
    def close(self) -> None: ...


class DriverModule(Protocol):
    """What ``landflow_sdk.transport.load_driver(kind)`` returns: a module-level ``MODULE`` object in a driver module."""

    kind: str
    label: str
    capabilities: Capabilities

    def create(self) -> BrokerDriver: ...

    def config_from(self, connection_id: str, url: str, options: dict[str, Any] | None = None) -> Any: ...


@dataclass
class SimpleDriverModule:
    kind: str
    label: str
    capabilities: Capabilities
    create: Callable[[], BrokerDriver]
    config_from: Callable[..., Any]
    example_url: str = ""
    extras: tuple[str, ...] = field(default_factory=tuple)


def prefix_headers(headers: dict[str, str], prefix: str) -> dict[str, str]:
    """Add a binding's header prefix (``ce_``) to every CloudEvents header except ``content-type``."""
    return {(name if name == "content-type" else prefix + name): value for name, value in headers.items()}


def unprefix_headers(headers: dict[str, Any], prefix: str) -> dict[str, str]:
    """The inverse of ``prefix_headers``: strips ``prefix``, lower-cases names, drops anything else but ``content-type``."""
    out: dict[str, str] = {}
    lower_prefix = prefix.lower()
    for raw_name, value in headers.items():
        if value is None:
            continue
        name = raw_name.lower()
        text = value.decode("utf-8", "replace") if isinstance(value, (bytes, bytearray)) else str(value)
        if name == "content-type":
            out[name] = text
        elif name.startswith(lower_prefix):
            out[name[len(prefix):]] = text
    return out


class HandlerPool:
    """A bounded pool of handler threads for one subscription: at most ``prefetch`` deliveries are handed to the core at
    once, and the driver's receive loop blocks in ``acquire()`` while every slot is busy. Drivers share this so the
    "hold the handler until the reply is out" rule gives the same limit everywhere."""

    def __init__(self, prefetch: int, name: str, *, release_on_return: bool = True) -> None:
        """``release_on_return=False`` (manual ack mode): the slot is freed by ``release()`` when the delivery is acked or
        nacked, not when the handler returns, so a consumer holds at most ``prefetch`` unacknowledged deliveries."""
        self.prefetch = max(1, prefetch)
        self.release_on_return = release_on_return
        self._slots = threading.BoundedSemaphore(self.prefetch)
        self._pool = ThreadPoolExecutor(max_workers=self.prefetch, thread_name_prefix=name)
        self._closed = threading.Event()

    @property
    def closed(self) -> bool:
        return self._closed.is_set()

    def acquire(self, timeout: float | None = None) -> bool:
        """Take a slot (blocking); ``False`` when the pool was closed or ``timeout`` elapsed."""
        while not self._closed.is_set():
            if self._slots.acquire(timeout=0.1 if timeout is None else min(timeout, 0.1)):
                if self._closed.is_set():
                    self._slots.release()
                    return False
                return True
            if timeout is not None:
                timeout -= 0.1
                if timeout <= 0:
                    return False
        return False

    def release(self) -> None:
        try:
            self._slots.release()
        except ValueError:
            pass

    def submit(self, fn: Callable[[], None]) -> None:
        """Run ``fn`` on a pool thread; the caller must have acquired a slot, which ``fn``'s completion releases."""
        if self._closed.is_set():
            self.release()
            return
        try:
            self._pool.submit(self._run, fn)
        except RuntimeError:
            self.release()

    def _run(self, fn: Callable[[], None]) -> None:
        try:
            fn()
        except Exception:  # noqa: BLE001 - the core never throws for a bad event; a bug must not kill the pool
            pass
        finally:
            if self.release_on_return:
                self.release()

    def close(self, wait: bool = False) -> None:
        self._closed.set()
        self._pool.shutdown(wait=wait, cancel_futures=True)
