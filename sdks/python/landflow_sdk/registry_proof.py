"""Registry proofs (docs/protocol.md §13).

A host that finds plugins itself (Kubernetes discovery) gets no announce on which to check
``LANDFLOW_REGISTRY_SECRET``, so it sends a random challenge with GetManifest (HTTP header or gRPC
metadata ``x-landflow-registry-challenge``) and the plugin answers with ``x-landflow-registry-proof``:
an HMAC of the challenge and its plugin id, keyed with the secret. The secret itself never travels.
The HTTP and gRPC servers answer automatically when ``LANDFLOW_REGISTRY_SECRET`` is set.
"""

from __future__ import annotations

import hashlib
import hmac
import os

REGISTRY_CHALLENGE_HEADER = "x-landflow-registry-challenge"
REGISTRY_PROOF_HEADER = "x-landflow-registry-proof"
#: Longer challenges are ignored (hosts send 43 characters).
MAX_REGISTRY_CHALLENGE_LENGTH = 256


def registry_proof(secret: str, plugin_id: str, challenge: str) -> str:
    """Hex HMAC-SHA256 of ``landflow-registry-proof/v1\\n<plugin_id>\\n<challenge>``, keyed with ``secret``."""
    message = f"landflow-registry-proof/v1\n{plugin_id}\n{challenge}".encode()
    return hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()


def verify_registry_proof(secret: str, plugin_id: str, challenge: str, proof: str | None) -> bool:
    """Whether ``proof`` answers ``challenge`` for ``plugin_id`` under ``secret`` (constant-time)."""
    return bool(proof) and hmac.compare_digest(registry_proof(secret, plugin_id, challenge), proof or "")


def answer_registry_challenge(plugin_id: str, challenge: str | None, secret: str | None = None) -> str | None:
    """The proof for ``challenge`` when ``LANDFLOW_REGISTRY_SECRET`` (or ``secret``) is set, else ``None``."""
    secret = secret if secret is not None else os.environ.get("LANDFLOW_REGISTRY_SECRET")
    if not secret or not challenge or len(challenge) > MAX_REGISTRY_CHALLENGE_LENGTH:
        return None
    return registry_proof(secret, plugin_id, challenge)
