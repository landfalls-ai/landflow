"""The codec the core uses on both sides: picks the CloudEvents mode from the driver's capabilities, seals (encrypts and
signs) outgoing events, and decodes, verifies and decrypts incoming ones."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from .claim import CLAIM_KEY_RE, ClaimError, ClaimStore, claim_key_for, sha256_hex
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
from .security import Keyring, ReplayGuard, SecurityError, open_event, seal, verify_claimed, with_claim

Logger = Callable[..., None]


@dataclass
class PackedEvent:
    attributes: Attributes
    wire: WireEvent
    size: WireSize
    #: The claim-store object holding the body when the event went by reference.
    claim_key: str | None = None


class Codec:
    def __init__(
        self,
        keyring: Keyring,
        capabilities: Capabilities,
        *,
        clock_skew_ms: int | None = None,
        replay: ReplayGuard | None = None,
        now: Callable[[], int] | None = None,
        claims: ClaimStore | None = None,
    ) -> None:
        self.keyring = keyring
        self.capabilities = capabilities
        self.mode = "binary" if capabilities.headers else "structured"
        self.clock_skew_ms = clock_skew_ms
        self.replay = replay
        self.now = now or now_ms
        #: When set, an event that does not fit the broker goes by reference through this store (the claim check).
        self.claims = claims

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

    def _fits(self, size: WireSize) -> bool:
        caps = self.capabilities
        return size.total_bytes <= caps.max_message_bytes and (caps.max_header_bytes is None or size.header_bytes <= caps.max_header_bytes)

    def pack_claimed(self, plugin_id: str, attributes: Attributes, data: Any, encrypt: bool) -> PackedEvent:
        """Like ``pack``, but an encrypted event that does not fit the broker's limits is stored in the claim store and sent
        by reference (``claim_key`` says where; the caller deletes it when the call fails). Without a store, or when even the
        reference does not fit, it raises ``EnvelopeError('too_large')`` like ``pack``; a store failure is a ``ClaimError``."""
        if self.claims is None or not encrypt:
            return self.pack(plugin_id, attributes, data, encrypt)
        sealed = seal(self.keyring, plugin_id, RawEvent(attributes, serialize_body(data)), encrypt=encrypt)
        wire, size = encode_wire(sealed, self.mode)
        if self._fits(size):
            return PackedEvent(sealed.attributes, wire, size)
        key = claim_key_for(self.now(), sealed.attributes.id)
        claimed = with_claim(self.keyring, plugin_id, sealed, key)
        wire, size = encode_wire(RawEvent(claimed.attributes, b""), self.mode)
        if not self._fits(size):
            raise EnvelopeError(f"even by reference the event is {size.total_bytes} bytes (headers {size.header_bytes}); the broker takes at most {self.capabilities.max_message_bytes}", "too_large")
        try:
            self.claims.put(key, claimed.body)
        except Exception as exc:  # noqa: BLE001
            raise ClaimError(f"could not store the {len(claimed.body)}-byte body in the claim store: {exc}", "store") from exc
        return PackedEvent(claimed.attributes, wire, size, key)

    def resolve_claim(self, raw: RawEvent, plugin_id: str) -> tuple[RawEvent, str | None]:
        """Complete an event that carries ``lfclaim``: check its signature (the body's digest is ``lfclaimsha256``), fetch the
        body and check its size and digest. Raises ``SecurityError`` (bad signature: drop the event) or ``ClaimError`` (store
        down, object missing or wrong: the sender can be told). Events without a claim pass through, with no key."""
        attributes = raw.attributes
        if not attributes.lfclaim:
            return raw, None
        verify_claimed(self.keyring, plugin_id, attributes)
        if self.claims is None:
            raise ClaimError("the event carries its body in a claim store and none is configured here (LANDFLOW_CLAIM_STORE)", "invalid")
        if raw.body or not CLAIM_KEY_RE.match(attributes.lfclaim):
            raise ClaimError("malformed claim reference", "invalid")
        try:
            body = self.claims.get(attributes.lfclaim)
        except Exception as exc:  # noqa: BLE001
            raise ClaimError(f"could not fetch the claim {attributes.lfclaim}: {exc}", "store") from exc
        if body is None:
            raise ClaimError(f"the claim {attributes.lfclaim} is gone (expired or already deleted)", "missing")
        if str(len(body)) != attributes.lfclaimsize:
            raise ClaimError(f"the claim {attributes.lfclaim} is {len(body)} bytes, not the {attributes.lfclaimsize} announced", "size")
        if sha256_hex(body) != attributes.lfclaimsha256:
            raise ClaimError(f"the claim {attributes.lfclaim} does not match its digest", "digest")
        return RawEvent(attributes, body), attributes.lfclaim

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
