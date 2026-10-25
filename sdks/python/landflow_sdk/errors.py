"""Exceptions raised by node code and by the request dispatcher."""

from __future__ import annotations


class NodeOperationError(Exception):
    """A node failed in a way the workflow author should see.

    Becomes ``ExecuteResponse.error`` = ``{message, description?, itemIndex?}``.
    """

    def __init__(self, message: str, description: str | None = None, item_index: int | None = None):
        super().__init__(message)
        self.message = message
        self.description = description
        self.item_index = item_index

    def to_payload(self) -> dict:
        payload: dict = {"message": self.message}
        if self.description:
            payload["description"] = self.description
        if self.item_index is not None:
            payload["itemIndex"] = int(self.item_index)
        return payload


class DescriptorError(ValueError):
    """A NodeDescriptor or the plugin metadata is invalid (raised at startup)."""


class ProtocolError(ValueError):
    """The request is malformed (HTTP 400 / gRPC INVALID_ARGUMENT)."""


class UnknownNodeError(LookupError):
    """The request names a node type this plugin does not provide (HTTP 404 / gRPC NOT_FOUND)."""


class UnknownMethodError(LookupError):
    """A load-options method the node does not implement (HTTP 404 / gRPC NOT_FOUND)."""


class UnknownCredentialTypeError(LookupError):
    """TestCredentials for a credential type the plugin does not declare, or one without a test (HTTP 404 / gRPC NOT_FOUND)."""
