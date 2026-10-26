"""Typed errors of ``MessagingClient.call()`` (the Python counterpart of ``packages/transports/src/errors.ts``).

``knowledge`` says what is known about delivery: ``not-delivered`` (safe to send over another transport),
``maybe-delivered`` or ``delivered``.
"""

from __future__ import annotations

from typing import Any


class MessagingError(Exception):
    knowledge = "maybe-delivered"

    def __init__(self, message: str, code: str) -> None:
        super().__init__(message)
        self.code = code


class UndeliverableError(MessagingError):
    """Provably not delivered (``reason``: ``unroutable``, ``no_consumers``, ``not_connected``, ``too_large``, ``aborted``, ``claim_failed``)."""

    knowledge = "not-delivered"

    def __init__(self, message: str, reason: str) -> None:
        super().__init__(message, reason)
        self.reason = reason


class TimeoutError_(MessagingError):
    """The deadline passed without a reply; the plugin may have run the call."""

    knowledge = "maybe-delivered"

    def __init__(self, message: str, deadline: int) -> None:
        super().__init__(message, "deadline")
        self.deadline = deadline


TimeoutError = TimeoutError_


class CancelledError(MessagingError):
    """The caller cancelled after the request was published; a cancel event went out."""

    knowledge = "maybe-delivered"

    def __init__(self, message: str = "the call was cancelled") -> None:
        super().__init__(message, "cancelled")


class ConnectionLostError(MessagingError):
    knowledge = "maybe-delivered"

    def __init__(self, message: str = "connection lost; the call may have run") -> None:
        super().__init__(message, "connection_lost")


class RemoteError(MessagingError):
    """The plugin answered with an error code in ``lferror`` (the body is ``{ error, … }``)."""

    knowledge = "delivered"

    def __init__(self, message: str, remote_code: str, details: Any = None) -> None:
        super().__init__(message, remote_code)
        self.remote_code = remote_code
        self.details = details


class ClaimUnavailableError(MessagingError):
    """A body travelling through the claim store could not be read: expired or deleted, the store is down, or size/digest
    do not match. In the request direction the plugin refused the call before running it (``not-delivered``, so the
    selector may use another transport); in the response direction it has already run it (``delivered``)."""

    def __init__(self, message: str, direction: str = "request") -> None:
        super().__init__(message, "claim_unavailable")
        self.direction = direction
        self.knowledge = "not-delivered" if direction == "request" else "delivered"


class ManifestMismatchError(RemoteError):
    def __init__(self, expected: str | None, actual: str | None) -> None:
        super().__init__(f"manifest mismatch: the host knows {expected or 'none'}, the plugin runs {actual or 'unknown'}", "manifest_mismatch")
        self.expected = expected
        self.actual = actual


class UsageError(MessagingError):
    knowledge = "not-delivered"

    def __init__(self, message: str) -> None:
        super().__init__(message, "usage")


def is_provably_undelivered(error: BaseException) -> bool:
    return isinstance(error, MessagingError) and error.knowledge == "not-delivered"
