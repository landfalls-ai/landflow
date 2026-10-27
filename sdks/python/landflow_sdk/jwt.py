"""RS256 JWTs in pure Python (standard library only), for services that authenticate a *client* with a signed token.

GitHub Apps are the main case: the app signs a short-lived JWT with its private key and trades it for an installation
token. There is no dependency on ``cryptography``: the PEM key (PKCS#1 ``RSA PRIVATE KEY`` or PKCS#8 ``PRIVATE KEY``)
is read with a minimal ASN.1 reader and the signature is EMSA-PKCS1-v1_5 over SHA-256 computed with ``pow(m, d, n)``::

    from landflow_sdk import github_app_jwt

    token = github_app_jwt(ctx_credentials["appId"], ctx_credentials["privateKey"])
    ctx.http.get("https://api.github.com/app", headers={"Authorization": f"Bearer {token}"})

``pow`` is not constant-time, which is fine for signing with a key you own on your own host; do not use this module to
process keys or messages chosen by an attacker. Encrypted keys (``ENCRYPTED PRIVATE KEY``) are refused.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import re
import time
from typing import Any, Mapping

#: DER prefix of ``DigestInfo`` for SHA-256 (RFC 8017 section 9.2, note 1).
_SHA256_PREFIX = bytes.fromhex("3031300d060960864801650304020105000420")
_PEM_RE = re.compile(r"-----BEGIN ([A-Z ]+)-----(.*?)-----END \1-----", re.DOTALL)


class JwtError(ValueError):
    """The key could not be read or the payload could not be signed."""


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


# ---- minimal ASN.1 DER reader -------------------------------------------------


def _read(der: bytes, pos: int) -> tuple[int, bytes, int]:
    """``(tag, value, next position)`` of the DER element at ``pos``."""
    if pos + 2 > len(der):
        raise JwtError("truncated private key")
    tag = der[pos]
    length = der[pos + 1]
    pos += 2
    if length & 0x80:
        count = length & 0x7F
        if count == 0 or count > 4 or pos + count > len(der):
            raise JwtError("unsupported ASN.1 length in the private key")
        length = int.from_bytes(der[pos:pos + count], "big")
        pos += count
    if pos + length > len(der):
        raise JwtError("truncated private key")
    return tag, der[pos:pos + length], pos + length


def _elements(der: bytes) -> list[tuple[int, bytes]]:
    out: list[tuple[int, bytes]] = []
    pos = 0
    while pos < len(der):
        tag, value, pos = _read(der, pos)
        out.append((tag, value))
    return out


def _sequence(der: bytes) -> list[tuple[int, bytes]]:
    tag, value, _ = _read(der, 0)
    if tag != 0x30:
        raise JwtError("not a private key (expected an ASN.1 sequence)")
    return _elements(value)


def _pem_to_der(pem: str) -> tuple[str, bytes]:
    text = pem.strip().replace("\\n", "\n")  # a key pasted into a single-line field keeps literal \n
    match = _PEM_RE.search(text)
    if not match:
        raise JwtError("the private key is not PEM (expected -----BEGIN RSA PRIVATE KEY----- or -----BEGIN PRIVATE KEY-----)")
    label = match.group(1)
    try:
        return label, base64.b64decode("".join(match.group(2).split()), validate=True)
    except (binascii.Error, ValueError):
        raise JwtError("the private key PEM is not valid base64") from None


def parse_rsa_private_key(pem: str) -> tuple[int, int]:
    """``(n, d)`` of a PEM RSA private key (PKCS#1 or PKCS#8)."""
    label, der = _pem_to_der(pem)
    if label == "ENCRYPTED PRIVATE KEY":
        raise JwtError("the private key is encrypted; remove the passphrase first (openssl rsa -in key.pem -out plain.pem)")
    if label not in ("RSA PRIVATE KEY", "PRIVATE KEY"):
        raise JwtError(f"unsupported key type {label!r}; an RSA private key is required")
    fields = _sequence(der)
    if label == "PRIVATE KEY":  # PKCS#8: version, AlgorithmIdentifier, OCTET STRING holding the PKCS#1 key
        if len(fields) < 3 or fields[2][0] != 0x04:
            raise JwtError("malformed PKCS#8 private key")
        if fields[1][0] != 0x30 or not fields[1][1].startswith(b"\x06\x09\x2a\x86\x48\x86\xf7\x0d\x01\x01\x01"):
            raise JwtError("the private key is not an RSA key")
        fields = _sequence(fields[2][1])
    # RSAPrivateKey: version, n, e, d, p, q, dp, dq, qinv
    if len(fields) < 4 or any(tag != 0x02 for tag, _ in fields[:4]):
        raise JwtError("malformed RSA private key")
    n = int.from_bytes(fields[1][1], "big")
    d = int.from_bytes(fields[3][1], "big")
    if n <= 0 or d <= 0:
        raise JwtError("malformed RSA private key")
    return n, d


# ---- RS256 --------------------------------------------------------------------


def rs256_raw(private_key_pem: str, message: bytes) -> bytes:
    """The RSASSA-PKCS1-v1_5 SHA-256 signature of ``message``."""
    n, d = parse_rsa_private_key(private_key_pem)
    size = (n.bit_length() + 7) // 8
    digest_info = _SHA256_PREFIX + hashlib.sha256(message).digest()
    if size < len(digest_info) + 11:
        raise JwtError("the RSA key is too short for RS256 (use at least 2048 bits)")
    encoded = b"\x00\x01" + b"\xff" * (size - len(digest_info) - 3) + b"\x00" + digest_info
    return pow(int.from_bytes(encoded, "big"), d, n).to_bytes(size, "big")


def rs256_sign(private_key_pem: str, payload: Mapping[str, Any], headers: Mapping[str, Any] | None = None) -> str:
    """A compact JWS (``header.payload.signature``) with ``alg: RS256``; ``headers`` adds to ``{"alg", "typ"}``."""
    header = {"alg": "RS256", "typ": "JWT", **(headers or {})}
    header["alg"] = "RS256"
    signing_input = ".".join(
        _b64url(json.dumps(part, separators=(",", ":"), sort_keys=False).encode("utf-8")) for part in (header, dict(payload))
    )
    return f"{signing_input}.{_b64url(rs256_raw(private_key_pem, signing_input.encode('ascii')))}"


def github_app_jwt(app_id: str | int, private_key_pem: str, now: float | None = None) -> str:
    """A GitHub App JWT: ``iss`` = app id (a client id works too), ``iat`` = now - 60 s (clock drift), ``exp`` = now + 540 s (GitHub's
    limit is ten minutes)."""
    issued = int(time.time() if now is None else now)
    return rs256_sign(private_key_pem, {"iat": issued - 60, "exp": issued + 540, "iss": str(app_id).strip()})
