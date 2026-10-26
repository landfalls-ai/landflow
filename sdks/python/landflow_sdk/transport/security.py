"""Security over brokers (docs/protocol.md §14.7): keys, encryption, signing, replay protection, registry proofs.

Byte-compatible with ``packages/transports/src/security.ts`` and ``sdks/go/transport/security.go``:

- ``encKey`` / ``sigKey`` = HKDF-SHA256(secret, no salt, info ``"landflow transport v1\\n<pluginId>\\nenc|sig"``), 32 bytes;
  ``lfkeyid`` = ``hex(SHA-256("landflow transport keyid v1\\n" + secret))[0..16]``.
- The whole body is AES-256-GCM encrypted, ``nonce(12) ‖ ciphertext ‖ tag(16)``, AAD ``id + "\\n" + type``.
- ``lfsig`` = ``hex(HMAC-SHA256(sigKey, canonical))`` where ``canonical`` is ``name=value\\n`` per attribute present in
  ``KNOWN_ATTRIBUTES`` order (never ``lfsig``) followed by ``hex(SHA-256(body))\\n`` over the on-wire body bytes.

HKDF, HMAC and SHA-256 come from the standard library; AES-GCM needs the ``cryptography`` package (the SDK's
``transport`` extra), imported lazily so the envelope and signing work without it.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import threading
from dataclasses import dataclass
from typing import Any, Callable, Mapping

from ..registry_proof import registry_proof, verify_registry_proof
from .envelope import ENC_AES_GCM, ENCRYPTED_CONTENT_TYPE, JSON_CONTENT_TYPE, KNOWN_ATTRIBUTES, Attributes, RawEvent, parse_time_ms

TRANSPORT_SECRET_ENV = "LANDFLOW_TRANSPORT_SECRET"
TRANSPORT_SECRET_PREVIOUS_ENV = "LANDFLOW_TRANSPORT_SECRET_PREVIOUS"
REGISTRY_SECRET_ENV = "LANDFLOW_REGISTRY_SECRET"
HKDF_INFO_PREFIX = "landflow transport v1"
_KEY_ID_PREFIX = "landflow transport keyid v1"
NONCE_BYTES = 12
TAG_BYTES = 16
#: A clock difference between sender and receiver up to this is tolerated.
DEFAULT_CLOCK_SKEW_MS = 5 * 60_000

__all__ = [
    "DEFAULT_CLOCK_SKEW_MS", "DerivedKeys", "Keyring", "MissingSecretError", "ReplayGuard", "SecurityError", "canonical_form",
    "decrypt_body", "derive_keys", "encrypt_body", "key_id_of", "open_event", "registry_proof", "seal", "signature", "verify_registry_proof",
]


class SecurityError(Exception):
    """A received event failed verification (``reason``: ``unsigned``, ``unknown_key``, ``bad_signature``, ``clock_skew``,
    ``replay``, ``decrypt_failed``). The core drops the event, never processes it."""

    def __init__(self, message: str, reason: str) -> None:
        super().__init__(message)
        self.reason = reason


class MissingSecretError(Exception):
    """Messaging cannot start without a shared secret."""

    def __init__(self) -> None:
        super().__init__(
            f"messaging over brokers needs a shared secret: set {TRANSPORT_SECRET_ENV} (or {REGISTRY_SECRET_ENV}) "
            "to the same value on the host and on every plugin"
        )


def key_id_of(secret: str) -> str:
    return hashlib.sha256(f"{_KEY_ID_PREFIX}\n{secret}".encode()).hexdigest()[:16]


def _hkdf_sha256(ikm: bytes, info: bytes, length: int) -> bytes:
    """RFC 5869 with an empty salt (``HashLen`` zero bytes), as ``hkdfSync`` and Go's ``hkdf.New`` do."""
    prk = hmac.new(b"\x00" * 32, ikm, hashlib.sha256).digest()
    out = b""
    block = b""
    counter = 1
    while len(out) < length:
        block = hmac.new(prk, block + info + bytes([counter]), hashlib.sha256).digest()
        out += block
        counter += 1
    return out[:length]


@dataclass(frozen=True)
class DerivedKeys:
    key_id: str
    enc: bytes
    sig: bytes


def derive_keys(secret: str, plugin_id: str) -> DerivedKeys:
    """The per-plugin encryption and signing keys for ``secret``."""
    ikm = secret.encode("utf-8")
    enc = _hkdf_sha256(ikm, f"{HKDF_INFO_PREFIX}\n{plugin_id}\nenc".encode(), 32)
    sig = _hkdf_sha256(ikm, f"{HKDF_INFO_PREFIX}\n{plugin_id}\nsig".encode(), 32)
    return DerivedKeys(key_id_of(secret), enc, sig)


class Keyring:
    """The secrets a process holds: one current (signs and encrypts) and any number of previous ones (verify and decrypt
    only). Derived keys are cached per plugin."""

    def __init__(self, current: str, previous: list[str] | tuple[str, ...] = ()) -> None:
        if not current:
            raise MissingSecretError()
        self.current_key_id = key_id_of(current)
        self._secrets: dict[str, str] = {self.current_key_id: current}
        for secret in previous:
            if secret:
                self._secrets[key_id_of(secret)] = secret
        self._cache: dict[tuple[str, str], DerivedKeys] = {}
        self._lock = threading.Lock()

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> Keyring:
        """From ``LANDFLOW_TRANSPORT_SECRET`` (else ``LANDFLOW_REGISTRY_SECRET``) and ``LANDFLOW_TRANSPORT_SECRET_PREVIOUS``;
        raises ``MissingSecretError``."""
        env = os.environ if env is None else env
        current = env.get(TRANSPORT_SECRET_ENV) or env.get(REGISTRY_SECRET_ENV)
        if not current:
            raise MissingSecretError()
        previous = [s.strip() for s in (env.get(TRANSPORT_SECRET_PREVIOUS_ENV) or "").split(",") if s.strip()]
        return cls(current, previous)

    def has(self, key_id: str) -> bool:
        return key_id in self._secrets

    def keys(self, plugin_id: str, key_id: str | None = None) -> DerivedKeys | None:
        """The keys for ``plugin_id`` under ``key_id`` (default: the current key); ``None`` for an unknown key id."""
        key_id = key_id or self.current_key_id
        secret = self._secrets.get(key_id)
        if secret is None:
            return None
        with self._lock:
            keys = self._cache.get((key_id, plugin_id))
            if keys is None:
                keys = derive_keys(secret, plugin_id)
                self._cache[(key_id, plugin_id)] = keys
            return keys


def canonical_form(attributes: Attributes, body: bytes) -> str:
    lines = []
    for name in KNOWN_ATTRIBUTES:
        if name == "lfsig":
            continue
        value = getattr(attributes, name)
        if value is not None and value != "":
            lines.append(f"{name}={value}\n")
    return "".join(lines) + hashlib.sha256(body).hexdigest() + "\n"


def signature(sig_key: bytes, attributes: Attributes, body: bytes) -> str:
    return hmac.new(sig_key, canonical_form(attributes, body).encode("utf-8"), hashlib.sha256).hexdigest()


def _aad(attributes: Attributes) -> bytes:
    return f"{attributes.id}\n{attributes.type}".encode("utf-8")


def _aesgcm(key: bytes) -> Any:
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except ImportError as exc:  # pragma: no cover - depends on the environment
        raise RuntimeError(
            "encrypted messaging needs the 'cryptography' package: pip install 'landflow-sdk[transport]'"
        ) from exc
    return AESGCM(key)


def encrypt_body(enc_key: bytes, attributes: Attributes, plaintext: bytes, nonce: bytes | None = None) -> bytes:
    nonce = nonce if nonce is not None else secrets.token_bytes(NONCE_BYTES)
    return nonce + _aesgcm(enc_key).encrypt(nonce, plaintext, _aad(attributes))


def decrypt_body(enc_key: bytes, attributes: Attributes, sealed: bytes) -> bytes:
    if len(sealed) < NONCE_BYTES + TAG_BYTES:
        raise SecurityError("encrypted body is too short", "decrypt_failed")
    try:
        return _aesgcm(enc_key).decrypt(sealed[:NONCE_BYTES], sealed[NONCE_BYTES:], _aad(attributes))
    except Exception:  # noqa: BLE001 - InvalidTag and friends
        raise SecurityError("encrypted body does not decrypt (wrong key or tampered)", "decrypt_failed") from None


class ReplayGuard:
    """Remembers accepted event ids for a window, so a replayed event is refused. Sweeps lazily; bounded."""

    def __init__(self, window_ms: int = DEFAULT_CLOCK_SKEW_MS * 2, max_entries: int = 100_000) -> None:
        self.window_ms = window_ms
        self.max_entries = max_entries
        self._seen: dict[str, int] = {}
        self._lock = threading.Lock()

    def accept(self, event_id: str, now: int) -> bool:
        """``True`` the first time an id is seen inside the window; ``False`` for a replay."""
        with self._lock:
            self._sweep(now)
            if event_id in self._seen:
                return False
            self._seen[event_id] = now + self.window_ms
            return True

    def forget(self, event_id: str) -> None:
        """Forget an id (the core nacked the event without using it, so a redelivery is legitimate)."""
        with self._lock:
            self._seen.pop(event_id, None)

    @property
    def size(self) -> int:
        return len(self._seen)

    def _sweep(self, now: int) -> None:
        if len(self._seen) < self.max_entries:
            budget = 16
            for event_id, expires in list(self._seen.items()):
                if expires > now or budget <= 0:
                    break
                budget -= 1
                del self._seen[event_id]
            return
        for event_id, expires in list(self._seen.items()):
            if expires <= now:
                del self._seen[event_id]
        if len(self._seen) >= self.max_entries:
            for event_id in list(self._seen)[: self.max_entries // 2]:
                del self._seen[event_id]


def seal(keyring: Keyring, plugin_id: str, event: RawEvent, *, encrypt: bool, nonce: bytes | None = None) -> RawEvent:
    """Encrypt (optionally) and sign a plain event under ``plugin_id``'s current keys. Returns a new event."""
    keys = keyring.keys(plugin_id)
    assert keys is not None
    attributes = event.attributes.copy(lfkeyid=keys.key_id, lfsig=None)
    body = event.body
    if encrypt:
        attributes.lfenc = ENC_AES_GCM
        attributes.datacontenttype = ENCRYPTED_CONTENT_TYPE
        body = encrypt_body(keys.enc, attributes, event.body, nonce)
    else:
        attributes.lfenc = None
        attributes.datacontenttype = JSON_CONTENT_TYPE
    attributes.lfsig = signature(keys.sig, attributes, body)
    return RawEvent(attributes, body)


def open_event(
    keyring: Keyring,
    plugin_id: str,
    event: RawEvent,
    *,
    now: int | Callable[[], int] | None = None,
    clock_skew_ms: int | None = None,
    replay: ReplayGuard | None = None,
) -> RawEvent:
    """Verify a received event under ``plugin_id``'s keys and decrypt its body. Raises ``SecurityError``; on success the
    returned event has a plain JSON body and the attributes as received."""
    attributes = event.attributes
    if not attributes.lfsig or not attributes.lfkeyid:
        raise SecurityError(f"event {attributes.id} is not signed", "unsigned")
    keys = keyring.keys(plugin_id, attributes.lfkeyid)
    if keys is None:
        raise SecurityError(f"event {attributes.id} is signed with unknown key {attributes.lfkeyid}", "unknown_key")
    expected = signature(keys.sig, attributes, event.body)
    if not hmac.compare_digest(expected, attributes.lfsig.lower()):
        raise SecurityError(f"event {attributes.id} has a bad signature", "bad_signature")
    from .envelope import now_ms

    current = now() if callable(now) else (now if now is not None else now_ms())
    sent = parse_time_ms(attributes.time)
    skew = clock_skew_ms if clock_skew_ms is not None else DEFAULT_CLOCK_SKEW_MS
    if sent is None or abs(current - sent) > skew:
        raise SecurityError(f"event {attributes.id} was sent at {attributes.time}, outside the {skew} ms clock-skew window", "clock_skew")
    if replay is not None and not replay.accept(attributes.id, current):
        raise SecurityError(f"event {attributes.id} was already received (replay)", "replay")
    body = decrypt_body(keys.enc, attributes, event.body) if attributes.lfenc else event.body
    return RawEvent(attributes, body)
