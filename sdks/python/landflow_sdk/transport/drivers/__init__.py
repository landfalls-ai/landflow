"""The native Python broker drivers and their lookup.

``native_driver_kinds()`` lists the kinds this SDK has a driver for; ``load_driver(kind)`` imports the driver module
lazily (the broker's client library is imported only in ``connect()``), ``driver_available(kind)`` says whether the
client library is installed. ``landflow-bridge`` (the Go sidecar) covers the kinds without a native driver: the SDK's
``serve()`` asks these functions first and falls back to the bridge for the rest.

| Kind | Module | Client library (extra) |
|---|---|---|
| ``kafka`` | ``drivers.kafka`` | ``confluent-kafka`` (``landflow-sdk[kafka]``) |
| ``amqp`` | ``drivers.amqp`` | ``pika`` (``landflow-sdk[amqp]``) |
| ``nats``, ``jetstream`` | ``drivers.nats`` | ``nats-py`` (``landflow-sdk[nats]``) |
| ``valkey`` | ``drivers.valkey`` | ``valkey`` (``landflow-sdk[valkey]``) |
"""

from __future__ import annotations

import importlib
from typing import Any

from ..driver import DriverModule

#: kind -> (module name under this package, attribute holding the ``DriverModule``, the client library's import name, the extra).
_REGISTRY: dict[str, tuple[str, str, str, str]] = {
    "kafka": ("kafka", "MODULE", "confluent_kafka", "kafka"),
    "amqp": ("amqp", "MODULE", "pika", "amqp"),
    "nats": ("nats", "NATS_MODULE", "nats", "nats"),
    "jetstream": ("nats", "JETSTREAM_MODULE", "nats", "nats"),
    "valkey": ("valkey", "MODULE", "valkey", "valkey"),
}


def native_driver_kinds() -> tuple[str, ...]:
    """The broker kinds this SDK can serve natively (whether or not the client library is installed): see ``driver_available``."""
    return tuple(_REGISTRY)


def load_driver(kind: str) -> DriverModule | None:
    """The ``DriverModule`` for ``kind`` (``create()``, ``config_from()``, ``capabilities``), or ``None`` for a kind with no native driver."""
    entry = _REGISTRY.get(kind.lower())
    if entry is None:
        return None
    module = importlib.import_module(f"{__name__}.{entry[0]}")
    return getattr(module, entry[1])


def driver_available(kind: str) -> str | None:
    """``None`` when ``kind`` has a native driver whose client library imports; else a one-line reason (no driver, or the
    pip extra to install)."""
    entry = _REGISTRY.get(kind.lower())
    if entry is None:
        return f"no native Python driver for {kind!r} (use landflow-bridge)"
    try:
        importlib.import_module(entry[2])
    except Exception as exc:  # noqa: BLE001 - ImportError or a broken native extension
        return f"the {entry[2]} client library is not installed ({type(exc).__name__}: {exc}); pip install 'landflow-sdk[{entry[3]}]'"
    return None


def client_library_of(kind: str) -> tuple[str, str] | None:
    """``(import name, extra)`` of the client library a kind needs."""
    entry = _REGISTRY.get(kind.lower())
    return (entry[2], entry[3]) if entry else None


def _import_client(kind: str) -> Any:
    """For drivers: import the client library or raise a readable error."""
    reason = driver_available(kind)
    if reason:
        raise RuntimeError(f"{kind}: {reason}")
    return importlib.import_module(_REGISTRY[kind][2])
