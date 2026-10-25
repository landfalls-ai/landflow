"""Webhook signature verification: HMAC-SHA256 over the raw request body.

As GitHub (``X-Hub-Signature-256: sha256=<hex>``), Stripe (``Stripe-Signature: t=<ts>,v1=<hex>``) and Slack
(``X-Slack-Signature: v0=<hex>`` with ``X-Slack-Request-Timestamp``) sign their calls. App webhook triggers
(docs/protocol.md §12) call these from ``Node.webhook(ctx)`` with ``ctx.get_raw_body()``; the TypeScript and Go SDKs
have the same helpers. Comparisons are constant-time, and timestamped schemes reject calls outside the tolerance, so
a captured request cannot be replayed later::

    from landflow_sdk.signatures import verify_github_signature

    if not verify_github_signature(secret, ctx.get_raw_body(), ctx.get_header("X-Hub-Signature-256")):
        return {"response": {"status": 401}}
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import time

#: How far a signed timestamp may be from now (Stripe's and Slack's default: five minutes).
DEFAULT_SIGNATURE_TOLERANCE_SECONDS = 300


def _bytes(value: str | bytes | bytearray | memoryview) -> bytes:
    return value.encode("utf-8") if isinstance(value, str) else bytes(value)


def hmac_sha256(secret: str | bytes, payload: str | bytes, encoding: str = "hex") -> str:
    """HMAC-SHA256 of ``payload`` with ``secret``, ``"hex"`` (default) or ``"base64"``."""
    digest = hmac.new(_bytes(secret), _bytes(payload), hashlib.sha256).digest()
    return base64.b64encode(digest).decode("ascii") if encoding == "base64" else digest.hex()


def safe_equal(a: str, b: str) -> bool:
    """Constant-time string comparison."""
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


def verify_hmac_sha256(
    secret: str | bytes, payload: str | bytes, signature: str | None, *, encoding: str = "hex", prefix: str = ""
) -> bool:
    """Whether ``signature`` (after ``prefix``, e.g. ``"sha256="``) is the HMAC-SHA256 of ``payload``.

    Hex is compared case-insensitively. An empty secret or signature never verifies.
    """
    text = (signature or "").strip()
    if not text or not _bytes(secret):
        return False
    if prefix:
        if not text.lower().startswith(prefix.lower()):
            return False
        text = text[len(prefix):]
    expected = hmac_sha256(secret, payload, encoding)
    return safe_equal(text.lower(), expected) if encoding == "hex" else safe_equal(text, expected)


def _fresh(timestamp: int, tolerance_seconds: float, now: float | None) -> bool:
    current = time.time() if now is None else now
    return abs(current - timestamp) <= tolerance_seconds


# ---- GitHub ---------------------------------------------------------------


def github_signature(secret: str | bytes, body: str | bytes) -> str:
    """GitHub's ``X-Hub-Signature-256`` value for a body: ``sha256=<hex>``."""
    return "sha256=" + hmac_sha256(secret, body)


def verify_github_signature(secret: str | bytes, body: str | bytes, header: str | None) -> bool:
    """Whether ``header`` (``X-Hub-Signature-256``) signs ``body`` with the webhook's secret."""
    return verify_hmac_sha256(secret, body, header, prefix="sha256=")


# ---- Stripe-style: t=<unix seconds>,v1=<hex> ------------------------------


def stripe_signature(secret: str | bytes, body: str | bytes, timestamp: int | None = None) -> str:
    """A ``Stripe-Signature`` value: ``t=<timestamp>,v1=<hmac of "<timestamp>.<body>">``."""
    ts = int(time.time()) if timestamp is None else int(timestamp)
    return f"t={ts},v1={hmac_sha256(secret, f'{ts}.'.encode() + _bytes(body))}"


def verify_stripe_signature(
    secret: str | bytes,
    body: str | bytes,
    header: str | None,
    *,
    tolerance_seconds: float = DEFAULT_SIGNATURE_TOLERANCE_SECONDS,
    now: float | None = None,
    scheme: str = "v1",
) -> bool:
    """Whether a ``Stripe-Signature``-style header signs ``body``, with ``t`` within the tolerance of ``now`` (seconds).

    Several ``v1`` entries (secret rotation) are accepted.
    """
    timestamp = None
    signatures: list[str] = []
    for part in (header or "").split(","):
        key, _, value = part.strip().partition("=")
        if key == "t":
            timestamp = value
        elif key == scheme and value:
            signatures.append(value)
    if not timestamp or not timestamp.isdigit() or not signatures or not _fresh(int(timestamp), tolerance_seconds, now):
        return False
    payload = f"{timestamp}.".encode() + _bytes(body)
    return any(verify_hmac_sha256(secret, payload, signature) for signature in signatures)


# ---- Slack: v0=<hex of "v0:<timestamp>:<body>"> ---------------------------


def slack_signature(signing_secret: str | bytes, body: str | bytes, timestamp: int | str) -> str:
    """Slack's ``X-Slack-Signature`` for a body sent at ``timestamp`` (the ``X-Slack-Request-Timestamp`` header)."""
    return "v0=" + hmac_sha256(signing_secret, f"v0:{timestamp}:".encode() + _bytes(body))


def verify_slack_signature(
    signing_secret: str | bytes,
    body: str | bytes,
    timestamp: str | int | None,
    signature: str | None,
    *,
    tolerance_seconds: float = DEFAULT_SIGNATURE_TOLERANCE_SECONDS,
    now: float | None = None,
) -> bool:
    """Whether Slack's ``X-Slack-Signature`` signs ``body`` with the app's signing secret, sent within the tolerance."""
    ts = str(timestamp if timestamp is not None else "").strip()
    if not ts.isdigit() or not _fresh(int(ts), tolerance_seconds, now):
        return False
    return verify_hmac_sha256(signing_secret, f"v0:{ts}:".encode() + _bytes(body), signature, prefix="v0=")
