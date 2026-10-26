"""``landflow_sdk.transport``: the Python messaging core (docs/protocol.md §14) and the native broker drivers.

Byte-compatible with ``@landflow/transports`` (TypeScript) and ``sdks/go/transport`` (Go): the same CloudEvents
envelope, channels, encryption and signing, delivery rules and announce, so a TypeScript host calls a Python plugin
over Kafka, RabbitMQ, NATS (core and JetStream) or Valkey Streams exactly as it calls a TypeScript or Go one.

- ``MessagingBinding`` / ``BrokerTarget``: the plugin's face on a broker, built by ``serve(brokers=[...])`` or from
  ``LANDFLOW_TRANSPORTS`` + ``LANDFLOW_<KIND>_URL``.
- ``native_driver_kinds()`` / ``load_driver(kind)`` / ``driver_available(kind)``: the drivers this SDK ships
  (``landflow-bridge`` covers the rest).
- ``MessagingServer`` (plugin side), ``MessagingClient`` (host side, for tests and tooling), ``Codec``, ``Keyring``,
  the envelope and the in-memory broker for tests; ``landflow_sdk.transport.conformance`` checks a driver.
"""

from __future__ import annotations

from .binding import BROKER_KINDS, BrokerTarget, MessagingBinding, broker_target_from_env, broker_url_env, messaging_bindings_from_env, messaging_dispatcher
from .channels import ChannelNames, broker_endpoint, parse_broker_endpoint
from .client import AnnouncedInstance, AnnouncedPlugin, CallReply, MessagingClient, PluginEvent
from .codec import Codec
from .driver import (
    BrokerConfig,
    BrokerDriver,
    Capabilities,
    ChannelSpec,
    ChannelStats,
    ConsumeOptions,
    Delivery,
    DriverModule,
    HandlerPool,
    NotConnectedError,
    PublishOptions,
    RequestOutcome,
    Subscription,
    prefix_headers,
    unprefix_headers,
)
from .drivers import driver_available, load_driver, native_driver_kinds
from .envelope import Attributes, EnvelopeError, RawEvent, WireEvent, json_stringify
from .errors import (
    CancelledError,
    ConnectionLostError,
    ManifestMismatchError,
    MessagingError,
    RemoteError,
    TimeoutError_,
    UndeliverableError,
    UsageError,
    is_provably_undelivered,
)
from .memory import MEMORY_CAPABILITIES, MemoryBroker, MemoryDriver
from .security import Keyring, MissingSecretError, ReplayGuard, SecurityError
from .server import DispatchContext, DispatchError, MessagingServer, idempotency_from_manifest, manifest_hash_of

__all__ = [
    "AnnouncedInstance", "AnnouncedPlugin", "Attributes", "BROKER_KINDS", "BrokerConfig", "BrokerDriver", "BrokerTarget", "CallReply",
    "CancelledError", "Capabilities", "ChannelNames", "ChannelSpec", "ChannelStats", "Codec", "ConnectionLostError", "ConsumeOptions",
    "Delivery", "DispatchContext", "DispatchError", "DriverModule", "EnvelopeError", "HandlerPool", "Keyring", "MEMORY_CAPABILITIES",
    "ManifestMismatchError", "MemoryBroker", "MemoryDriver", "MessagingBinding", "MessagingClient", "MessagingError", "MessagingServer",
    "MissingSecretError", "NotConnectedError", "PluginEvent", "PublishOptions", "RawEvent", "RemoteError", "ReplayGuard", "RequestOutcome",
    "SecurityError", "Subscription", "TimeoutError_", "UndeliverableError", "UsageError", "WireEvent", "broker_endpoint",
    "broker_target_from_env", "broker_url_env", "driver_available", "idempotency_from_manifest", "is_provably_undelivered", "json_stringify",
    "load_driver", "manifest_hash_of", "messaging_bindings_from_env", "messaging_dispatcher", "native_driver_kinds", "parse_broker_endpoint",
    "prefix_headers", "unprefix_headers",
]
