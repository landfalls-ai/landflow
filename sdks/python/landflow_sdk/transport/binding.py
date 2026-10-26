"""The messaging binding: a plugin's face on a message broker (docs/transports.md "Generic messaging").

One ``MessagingBinding`` per broker wraps a ``MessagingServer`` (the envelope, signing and encryption, delivery modes,
deadlines, cancel, announce over the broker) around the SDK's ``Dispatcher``, so node code sees the same deadline,
``CancelToken``, spans and concurrency limit as over HTTP or gRPC::

    from landflow_sdk.transport.drivers.nats import nats
    serve(plugin, http=7105, brokers=[nats("nats://127.0.0.1:54222")])

or without code: ``LANDFLOW_TRANSPORTS=http,nats LANDFLOW_NATS_URL=nats://127.0.0.1:54222`` (plus
``LANDFLOW_NATS_USERNAME``, ``_PASSWORD``, ``_TLS=true``, ``_PREFIX`` when the broker needs them), which loads the native
driver for the kind and builds the connection ``env-<kind>``, the id the host gives the connection it reads from
``LANDFLOW_TRANSPORT_<KIND>_URL``. Messaging needs the shared secret (``LANDFLOW_TRANSPORT_SECRET``, else
``LANDFLOW_REGISTRY_SECRET``). The brokered endpoint is announced over the broker's registry channel, not through the
HTTP announce (§14.8), so ``start()`` returns no endpoints.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Any, Callable, Mapping

from ..announce import INSTANCE_ID
from ..binding import Binding, BindingContext, BindingInfo
from ..dispatcher import CallCancelledError, Dispatcher, OverloadedError
from ..errors import ProtocolError, UnknownCredentialTypeError, UnknownMethodError, UnknownNodeError
from .channels import ChannelNames
from .driver import BrokerDriver
from .drivers import driver_available, load_driver, native_driver_kinds
from .security import Keyring
from .server import DispatchContext, DispatchError, MessagingServer, idempotency_from_manifest

log = logging.getLogger("landflow_sdk")

#: Broker kinds ``serve()`` reads from ``LANDFLOW_TRANSPORTS`` and ``LANDFLOW_<KIND>_URL`` (an open list).
BROKER_KINDS: tuple[str, ...] = ("kafka", "amqp", "nats", "jetstream", "valkey", "mqtt", "sqs", "pubsub", "servicebus", "amqp1", "pulsar")


def broker_url_env(kind: str) -> str:
    """``LANDFLOW_<KIND>_URL`` for a kind (``kafka`` -> ``LANDFLOW_KAFKA_URL``)."""
    return f"LANDFLOW_{kind.upper()}_URL"


@dataclass
class BrokerTarget:
    """A broker to serve over: the kind, a fresh-driver factory and the connection config (``kafka(...)``, ``nats(...)``… build one)."""

    kind: str
    config: Any
    driver: Callable[[], BrokerDriver]


def messaging_dispatcher(dispatcher: Dispatcher, *, kind: str, observe: Callable[[str, DispatchContext], None] | None = None) -> Callable[[str, Any, DispatchContext], Any]:
    """The ``MessagingServer`` dispatcher over the SDK dispatcher: the method's JSON body in, the response body out; a
    refused call becomes the matching ``lferror`` code (``not_found``, ``bad_request``, ``expired``, ``cancelled``). Brokered calls
    pass ``wait=True``: the server already holds at most its prefetch and the rest waits in the broker, so the dispatcher's queue
    limit never answers ``capacity`` here (direct faces still get it)."""

    def call(method: str, body: Any, context: DispatchContext) -> Any:
        if observe is not None:
            observe(method, context)
        headers: dict[str, str] = {}
        if context.traceparent:
            headers["traceparent"] = context.traceparent
        if context.tracestate:
            headers["tracestate"] = context.tracestate
        try:
            if method == "GetManifest":
                return dispatcher.manifest()
            if method == "Health":
                return dispatcher.health()
            if method == "Execute":
                return dispatcher.execute(body, headers, cancel=context.cancel, transport=kind, wait=True)
            if method == "LoadOptions":
                return dispatcher.load_options_request(body, headers, cancel=context.cancel, transport=kind, wait=True)
            if method == "TestCredentials":
                return dispatcher.test_credentials_request(body, headers, cancel=context.cancel, transport=kind, wait=True)
            if method == "WebhookMethod":
                return dispatcher.webhook_method(body, headers, cancel=context.cancel, transport=kind, wait=True)
            if method == "ReceiveWebhook":
                return dispatcher.receive_webhook(body, headers, cancel=context.cancel, transport=kind, wait=True)
        except ProtocolError as exc:
            raise DispatchError(str(exc), "bad_request") from exc
        except (UnknownNodeError, UnknownMethodError, UnknownCredentialTypeError) as exc:
            raise DispatchError(str(exc), "not_found") from exc
        except OverloadedError as exc:
            raise DispatchError(str(exc), "capacity") from exc
        except CallCancelledError as exc:
            raise DispatchError(str(exc), "expired" if exc.deadline else "cancelled") from exc
        raise DispatchError(f"Unknown method {method!r}", "not_found")

    return call


class MessagingBinding(Binding):
    """The messaging face for one broker; ``serve(brokers=[…])`` builds one per target. ``server`` is the running
    ``MessagingServer`` while started (its counters, instance id, channel names)."""

    def __init__(
        self,
        target: BrokerTarget,
        *,
        keyring: Keyring | None = None,
        registry_secret: str | None | bool = None,
        drain_timeout_ms: int = 30_000,
        announce_interval_ms: int | None = None,
        ttl_seconds: int | None = None,
        observe: Callable[[str, DispatchContext], None] | None = None,
    ) -> None:
        self.kind = target.kind
        self.target = target
        self.keyring = keyring
        self.registry_secret = registry_secret
        self.drain_timeout_ms = drain_timeout_ms
        self.announce_interval_ms = announce_interval_ms
        self.ttl_seconds = ttl_seconds
        self.observe = observe
        self.server: MessagingServer | None = None
        self._dispatcher: Dispatcher | None = None

    def start(self, context: BindingContext) -> BindingInfo:
        self._dispatcher = context.dispatcher
        keyring = self.keyring or Keyring.from_env()
        plugin, manifest = context.plugin, context.manifest
        server = MessagingServer(
            driver=self.target.driver(),
            config=self.target.config,
            keyring=keyring,
            plugin_id=plugin.id,
            version=plugin.version,
            manifest=manifest,
            dispatch=messaging_dispatcher(context.dispatcher, kind=self.target.kind, observe=self.observe),
            is_idempotent=idempotency_from_manifest(manifest),
            max_concurrency=context.dispatcher.max_concurrency or manifest.get("maxConcurrency"),
            instance_id=INSTANCE_ID,
            transports=manifest.get("transports"),
            registry_secret=self.registry_secret,
            drain_timeout_ms=self.drain_timeout_ms,
            announce_interval_ms=self.announce_interval_ms,
            ttl_seconds=self.ttl_seconds,
            logger=context.logger,
        )
        server.start()
        self.server = server
        context.logger.info("%s connected (%s, consuming %s)", self.target.kind, server.endpoint, ChannelNames(getattr(self.target.config, "prefix", None)).request(plugin.id))
        return BindingInfo([])

    def stop(self) -> None:
        server, self.server = self.server, None
        if server is None:
            return
        server.stop()
        if self._dispatcher is not None:
            self._dispatcher.drain(self.drain_timeout_ms / 1000)


def connection_options_from_env(kind: str, env: Mapping[str, str] | None = None) -> dict[str, Any]:
    """``LANDFLOW_<KIND>_USERNAME`` / ``_PASSWORD`` / ``_TLS`` / ``_PREFIX`` (and ``LANDFLOW_TRANSPORT_PREFIX``) as driver options."""
    env = os.environ if env is None else env
    upper = kind.upper()
    options: dict[str, Any] = {}
    for suffix, name in (("USERNAME", "username"), ("PASSWORD", "password")):
        value = env.get(f"LANDFLOW_{upper}_{suffix}")
        if value:
            options[name] = value
    flag = env.get(f"LANDFLOW_{upper}_TLS")
    if flag is not None and flag != "":
        options["tls"] = flag.strip().lower() in ("true", "1", "yes", "on")
    prefix = env.get(f"LANDFLOW_{upper}_PREFIX") or env.get("LANDFLOW_TRANSPORT_PREFIX")
    if prefix:
        options["prefix"] = prefix
    # Driver-specific fields: LANDFLOW_<KIND>_<FIELD> (LANDFLOW_KAFKA_MODE, LANDFLOW_AMQP_QUEUE_TYPE, LANDFLOW_JETSTREAM_ACK_WAIT_MS...).
    head = f"LANDFLOW_{upper}_"
    reserved = {"URL", "USERNAME", "PASSWORD", "TLS", "PREFIX", "PORT"}
    for name, value in env.items():
        if name.startswith(head) and name[len(head):] not in reserved and value:
            options.setdefault(_camel(name[len(head):]), value)
    return options


def _camel(name: str) -> str:
    parts = name.lower().split("_")
    return parts[0] + "".join(p.capitalize() for p in parts[1:])


def broker_target_from_env(kind: str, env: Mapping[str, str] | None = None) -> BrokerTarget | None:
    """A ``BrokerTarget`` for one kind from ``LANDFLOW_<KIND>_URL`` and friends; ``None`` when the URL is not set. Raises
    when this SDK has no native driver for the kind (the caller may fall back to ``landflow-bridge``) or the URL is malformed."""
    env = os.environ if env is None else env
    url = env.get(broker_url_env(kind))
    if not url:
        return None
    module = load_driver(kind)
    if module is None:
        raise RuntimeError(f"serve(): no native Python driver for {kind!r} (set {broker_url_env(kind)} only for {', '.join(native_driver_kinds())}, or run landflow-bridge)")
    reason = driver_available(kind)
    if reason:
        raise RuntimeError(f"serve(): {kind}: {reason}")
    config = module.config_from(f"env-{kind}", url, connection_options_from_env(kind, env))
    return BrokerTarget(module.kind, config, module.create)


def native_binding_from_env(kind: str, env: Mapping[str, str] | None = None) -> MessagingBinding | None:
    """``serve()``'s lookup (through ``landflow_sdk.bridge.native_binding_for``): a ``MessagingBinding`` for a kind named in
    ``LANDFLOW_TRANSPORTS`` when this SDK has its driver, the client library is installed and ``LANDFLOW_<KIND>_URL`` is set;
    ``None`` otherwise (the kind is then bridged or reported). A missing client library is a warning, not an error."""
    env = os.environ if env is None else env
    if load_driver(kind) is None or not env.get(broker_url_env(kind)):
        return None
    reason = driver_available(kind)
    if reason:
        log.warning("%s: %s; the broker face is not started natively", kind, reason)
        return None
    target = broker_target_from_env(kind, env)
    return MessagingBinding(target) if target is not None else None


def messaging_bindings_from_env(selected: set[str] | None, configured_kinds: set[str], env: Mapping[str, str] | None = None) -> list[MessagingBinding]:
    """The bindings ``serve()`` adds for the broker kinds named in ``LANDFLOW_TRANSPORTS`` (``selected``) that have a
    ``LANDFLOW_<KIND>_URL`` and a native driver, skipping kinds already configured in code. Kinds without a native driver
    are left for the bridge (a warning says so)."""
    env = os.environ if env is None else env
    out: list[MessagingBinding] = []
    for kind in sorted(selected or ()):
        if kind in configured_kinds or kind in ("http", "grpc", "mcp"):
            continue
        binding = native_binding_from_env(kind, env)
        if binding is not None:
            out.append(binding)
    return out
