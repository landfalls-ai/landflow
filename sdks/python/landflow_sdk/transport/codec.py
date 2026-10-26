"""The codec the core uses on both sides: picks the CloudEvents mode from the driver's capabilities, seals (encrypts and
signs) outgoing events, and decodes, verifies and decrypts incoming ones."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from .driver import Capabilities
from .envelope import (
    JSON_CONTENT_TYPE,
    Attributes,
    EnvelopeError,
    RawEvent,
    WireEvent,
    WireSize,
    decode_wire,
    encode_wire,
    format_time,
    new_event_id,
    now_ms,
    parse_body,
    serialize_body,
)
from .security import Keyring, ReplayGuard, SecurityError, open_event, seal

Logger = Callable[..., None]


@dataclass
class PackedEvent:
    attributes: Attributes
    wire: WireEvent
    size: WireSize


class Codec:
    def __init__(
        self,
        keyring: Keyring,
        capabilities: Capabilities,
        *,
        clock_skew_ms: int | None = None,
        replay: ReplayGuard | None = None,
        now: Callable[[], int] | None = None,
    ) -> None:
        self.keyring = keyring
        self.capabilities = capabilities
        self.mode = "binary" if capabilities.headers else "structured"
        self.clock_skew_ms = clock_skew_ms
        self.replay = replay
        self.now = now or now_ms

    def base(self, source: str, type_: str, **extra: Any) -> Attributes:
        """Attributes every event starts from."""
        attributes = Attributes(id=new_event_id(), source=source, type=type_, time=format_time(self.now()), datacontenttype=JSON_CONTENT_TYPE)
        for name, value in extra.items():
            if value is not None:
                setattr(attributes, name, value)
        return attributes

    def pack(self, plugin_id: str, attributes: Attributes, data: Any, encrypt: bool) -> PackedEvent:
        """Serialise, seal under ``plugin_id``'s key and encode; raises ``EnvelopeError('too_large')`` over the broker's limits."""
        sealed = seal(self.keyring, plugin_id, RawEvent(attributes, serialize_body(data)), encrypt=encrypt)
        wire, size = encode_wire(sealed, self.mode)
        caps = self.capabilities
        if size.total_bytes > caps.max_message_bytes:
            raise EnvelopeError(f"event is {size.total_bytes} bytes; the broker takes at most {caps.max_message_bytes}", "too_large")
        if caps.max_header_bytes is not None and size.header_bytes > caps.max_header_bytes:
            raise EnvelopeError(f"event headers are {size.header_bytes} bytes; the broker takes at most {caps.max_header_bytes}", "too_large")
        return PackedEvent(sealed.attributes, wire, size)

    def peek(self, wire: WireEvent) -> RawEvent:
        """Decode without verifying: the attributes are needed to know which plugin's key applies."""
        return decode_wire(wire, max_bytes=self.capabilities.max_message_bytes)

    def forget_replay(self, event_id: str) -> None:
        if self.replay is not None:
            self.replay.forget(event_id)

    def unpack(self, raw: RawEvent, plugin_id: str, replay: ReplayGuard | None | bool = True) -> tuple[Attributes, Any]:
        """Verify a peeked event under ``plugin_id``'s key and parse its body. ``replay=False`` skips the replay guard."""
        guard = self.replay if replay is True else (replay or None)
        opened = open_event(self.keyring, plugin_id, raw, now=self.now(), clock_skew_ms=self.clock_skew_ms, replay=guard)
        return opened.attributes, parse_body(opened.body)


def is_drop_reason(error: BaseException) -> bool:
    return isinstance(error, (EnvelopeError, SecurityError))
