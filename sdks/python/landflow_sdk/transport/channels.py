"""Channel names (docs/protocol.md §14.2): ``<prefix>.v1.<role>…``; the prefix (default ``landflow``) lets two Landflow
instances share a broker, the protocol version keeps a future ``v2`` apart."""

from __future__ import annotations

import re

from .driver import ChannelSpec

DEFAULT_PREFIX = "landflow"
CHANNEL_VERSION = "v1"
_NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
_ENDPOINT_RE = re.compile(r"^([a-z][a-z0-9]*)://([A-Za-z0-9._-]{1,64})/([A-Za-z0-9._-]{1,128})$")


def _check(what: str, value: str) -> str:
    if not _NAME_RE.match(value):
        raise ValueError(f'{what} "{value}" must be 1-128 characters of letters, digits, ".", "_" or "-"')
    return value


class ChannelNames:
    """The channel names for one prefix."""

    def __init__(self, prefix: str | None = None) -> None:
        self.prefix = prefix or DEFAULT_PREFIX
        self._base = f"{_check('channel prefix', self.prefix)}.{CHANNEL_VERSION}"

    def request(self, plugin_id: str) -> str:
        return f"{self._base}.plugin.{_check('plugin id', plugin_id)}"

    def instance(self, plugin_id: str, instance_id: str) -> str:
        return f"{self._base}.instance.{_check('plugin id', plugin_id)}.{_check('instance id', instance_id)}"

    def reply(self, host_instance_id: str) -> str:
        return f"{self._base}.reply.{_check('host instance id', host_instance_id)}"

    def registry(self) -> str:
        return f"{self._base}.registry"

    def control(self, plugin_id: str) -> str:
        return f"{self._base}.control.{_check('plugin id', plugin_id)}"


def request_spec(name: str, ttl_ms: int | None = None) -> ChannelSpec:
    return ChannelSpec(name, "request", "shared", True, ttl_ms)


def instance_spec(name: str) -> ChannelSpec:
    return ChannelSpec(name, "instance", "shared", False)


def reply_spec(name: str) -> ChannelSpec:
    return ChannelSpec(name, "reply", "broadcast", False, 5 * 60_000)


def registry_spec(name: str) -> ChannelSpec:
    return ChannelSpec(name, "registry", "broadcast", False, 60_000)


def control_spec(name: str) -> ChannelSpec:
    return ChannelSpec(name, "control", "broadcast", False, 60_000)


def broker_endpoint(kind: str, connection_id: str, plugin_id: str) -> str:
    """A brokered endpoint, ``<kind>://<connectionId>/<pluginId>``, never with hosts or passwords."""
    return f"{kind}://{connection_id}/{plugin_id}"


def parse_broker_endpoint(endpoint: str) -> tuple[str, str, str] | None:
    """``(kind, connection_id, plugin_id)`` of a brokered endpoint; ``None`` for a direct URL or anything else."""
    match = _ENDPOINT_RE.match(endpoint)
    if not match or match.group(1) in ("http", "https", "grpc", "grpcs"):
        return None
    return match.group(1), match.group(2), match.group(3)
