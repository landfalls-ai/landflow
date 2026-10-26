"""``serve()``: start the plugin's bindings (HTTP, gRPC, more), announce, block until signalled."""

from __future__ import annotations

import logging
import os
import signal
import threading
from typing import Any, Iterable, Sequence

from .announce import Announcer, HttpRegistryClient, _is_loopback, parse_registry_url
from .binding import Binding, BindingContext, GrpcBinding, HttpBinding
from .dispatcher import Dispatcher, max_concurrency_from_env
from .logs import configure_logging
from .plugin import Plugin

log = logging.getLogger("landflow_sdk")

_OFF = {"off", "false", "no", "none", "disabled", "-1"}


def _resolve_port(env_name: str, argument: int | bool | None, default: int | None) -> int | None:
    """``env`` beats the argument (deployment override); ``off`` disables the transport."""
    raw = os.environ.get(env_name, "").strip()
    if raw:
        if raw.lower() in _OFF:
            return None
        try:
            port = int(raw)
        except ValueError:
            raise ValueError(f"{env_name} must be a port number or 'off', got {raw!r}") from None
    elif argument is None:
        return default
    elif argument is False:
        return None
    else:
        port = int(argument)
    if not 0 <= port <= 65535:
        raise ValueError(f"{env_name}: port {port} out of range")
    return port


def transports_from_env(argument: Iterable[str] | None) -> set[str] | None:
    """``LANDFLOW_TRANSPORTS`` (comma-separated kinds; beats the argument) -> the kinds to run, ``None`` = all."""
    raw = os.environ.get("LANDFLOW_TRANSPORTS", "").strip()
    kinds: Iterable[str]
    if raw:
        kinds = raw.split(",")
    elif argument:
        kinds = argument
    else:
        return None
    return {k.strip().lower() for k in kinds if k and k.strip()}


class PluginServer:
    """Owns the bindings, the dispatcher and the announcer. ``serve()`` is ``start()`` + ``wait()``.

    ``http_port`` / ``grpc_port`` build the HTTP and gRPC bindings (``http=`` / ``grpc=`` are aliases);
    ``bindings`` adds more faces (a broker binding, the MCP face, your own ``Binding``); ``transports``
    limits the kinds that run; ``max_concurrency`` bounds the calls one instance runs at once (the
    manifest's ``maxConcurrency``) and ``max_queue`` how many may wait for a slot (default
    ``max_concurrency``; beyond it calls are refused at once with 429 / ``RESOURCE_EXHAUSTED``).

    Environment (overrides the arguments):
      LANDFLOW_HTTP_PORT / LANDFLOW_GRPC_PORT  listen ports ("off" disables, 0 = any free port)
      LANDFLOW_TRANSPORTS                      comma-separated binding kinds to run (http,grpc,kafka,...)
      LANDFLOW_MAX_CONCURRENCY                 calls one instance takes at once (0 = unlimited)
      LANDFLOW_ADVERTISE_HOST                  host put in announced endpoints (default 127.0.0.1)
      LANDFLOW_BIND_HOST                       listen address (default 127.0.0.1 when the advertised
                                               host is loopback, else 0.0.0.0)
      LANDFLOW_REGISTRY_URL                    http(s)://host:port | grpc://host:port | off
    """

    def __init__(
        self,
        plugin: Plugin,
        http_port: int | bool | None = None,
        grpc_port: int | bool | None = None,
        announce: bool = True,
        *,
        http: int | bool | None = None,
        grpc: int | bool | None = None,
        bindings: Sequence[Binding] = (),
        transports: Iterable[str] | None = None,
        max_concurrency: int | None = None,
        max_queue: int | None = None,
    ) -> None:
        self.plugin = plugin
        self.http_port = _resolve_port("LANDFLOW_HTTP_PORT", http if http is not None else http_port, default=0)
        self.grpc_port = _resolve_port("LANDFLOW_GRPC_PORT", grpc if grpc is not None else grpc_port, default=None)
        self.max_concurrency = max_concurrency_from_env(max_concurrency)
        self.max_queue = max_queue
        self.advertise_host = os.environ.get("LANDFLOW_ADVERTISE_HOST", "").strip() or "127.0.0.1"
        self.bind_host = os.environ.get("LANDFLOW_BIND_HOST", "").strip() or (
            "127.0.0.1" if _is_loopback(self.advertise_host) else "0.0.0.0"
        )
        self.announce = announce
        self.extra_bindings = list(bindings)
        for binding in self.extra_bindings:
            if not isinstance(binding, Binding) or not binding.kind:
                raise TypeError(f"{binding!r} is not a landflow_sdk.Binding with a kind")
        self.selected = transports_from_env(transports)
        self.bindings: list[Binding] = []
        self.transports: list[str] = []
        self.dispatcher: Dispatcher | None = None
        self.announcer: Announcer | None = None
        self.endpoints: list[str] = []
        self._started: list[Binding] = []
        self._stop_requested = threading.Event()
        self._failure: BaseException | None = None
        self._stopped = False

    # Compatibility with code that looked at the servers directly.
    @property
    def http(self) -> Any:
        return next((b.server for b in self.bindings if isinstance(b, HttpBinding)), None)

    @property
    def grpc(self) -> Any:
        return next((b.server for b in self.bindings if isinstance(b, GrpcBinding)), None)

    # ----------------------------------------------------------------- start

    def start(self) -> None:
        self._configure()
        try:
            self._start_bindings()
        except Exception:
            self._stop_bindings()
            raise
        log.info(
            "%s %s serving %d node(s) [%s] over %s on %s",
            self.plugin.id,
            self.plugin.version,
            len(self.plugin.node_names),
            ", ".join(self.plugin.node_names),
            ", ".join(self.transports),
            "  ".join(self.endpoints) or "no announced endpoint",
        )
        if self.max_concurrency:
            log.info("max concurrency %d", self.max_concurrency)
        if self.announce:
            self._start_announcer()
        else:
            log.info("announce disabled")

    def _configure(self) -> None:
        """Pick the bindings to run (HTTP, gRPC, then the extra ones; filtered by ``LANDFLOW_TRANSPORTS``)."""
        configured: list[Binding] = []
        if self.http_port is not None:
            configured.append(HttpBinding(self.http_port))
        if self.grpc_port is not None:
            try:
                from . import grpc_server  # noqa: F401 - probe the extra
            except Exception as exc:  # noqa: BLE001 - ImportError, or stub/runtime version mismatch
                log.warning(
                    "gRPC disabled (%s: %s); serving without it. Install with: pip install 'landflow-sdk[grpc]'",
                    type(exc).__name__,
                    exc,
                )
                self.grpc_port = None
            else:
                configured.append(GrpcBinding(self.grpc_port))
        configured.extend(self.extra_bindings)
        if self.selected is None:
            self.bindings = configured
        else:
            self.bindings = [b for b in configured if b.kind.lower() in self.selected]
            for kind in sorted(self.selected - {b.kind.lower() for b in configured}):
                log.warning("LANDFLOW_TRANSPORTS names %r but no such binding is configured; ignored", kind)
        if not self.bindings:
            raise RuntimeError(
                "no transport enabled: set an HTTP port and/or install grpcio for gRPC, pass bindings=, and check LANDFLOW_TRANSPORTS"
            )
        self.http_port = next((b.port for b in self.bindings if isinstance(b, HttpBinding)), None)
        self.grpc_port = next((b.port for b in self.bindings if isinstance(b, GrpcBinding)), None)
        self.transports = [b.kind for b in self.bindings]
        self.plugin.transports = list(self.transports)
        self.plugin.max_concurrency = self.max_concurrency
        self.dispatcher = Dispatcher(self.plugin, self.max_concurrency, self.max_queue)
        self.plugin.dispatcher = self.dispatcher

    def _context(self) -> BindingContext:
        assert self.dispatcher is not None
        return BindingContext(
            plugin=self.plugin,
            dispatcher=self.dispatcher,
            manifest=self.plugin.manifest(),
            logger=log,
            telemetry=self.plugin.telemetry,
            bind_host=self.bind_host,
            advertise_host=self.advertise_host,
            announce=self.announce_endpoints,
            fail=self.fail,
        )

    def _start_bindings(self) -> None:
        context = self._context()
        # Only bindings that started are stopped on failure / shutdown.
        self._started = []
        for binding in self.bindings:
            info = binding.start(context)
            self._started.append(binding)
            self.endpoints.extend(info.endpoints)
        self.http_port = next((b.port for b in self.bindings if isinstance(b, HttpBinding)), None)
        self.grpc_port = next((b.port for b in self.bindings if isinstance(b, GrpcBinding)), None)

    def announce_endpoints(self, endpoints: Sequence[str]) -> None:
        """Announce endpoints a binding learned after ``start`` (no-op when announce is off)."""
        new = [e for e in endpoints if e not in self.endpoints]
        if not new:
            return
        self.endpoints.extend(new)
        if self.announcer is not None:
            self.announcer.add_endpoints(new)

    def fail(self, exc: BaseException) -> None:
        """A binding failed after start: log and shut the server down (``wait()`` returns)."""
        if self._failure is None:
            self._failure = exc
        log.error("%s; shutting down", exc)
        self._stop_requested.set()

    def _start_announcer(self) -> None:
        raw = os.environ.get("LANDFLOW_REGISTRY_URL")
        try:
            registry = parse_registry_url(raw)
        except ValueError as exc:
            log.warning("announce disabled: %s", exc)
            return
        if registry is None:
            log.info("announce disabled (LANDFLOW_REGISTRY_URL=%s)", raw)
            return
        scheme, target = registry
        if scheme == "grpc":
            try:
                from .grpc_server import GrpcRegistryClient
            except Exception as exc:  # noqa: BLE001
                log.warning("announce disabled: registry %s needs grpcio (%s)", target, exc)
                return
            client: Any = GrpcRegistryClient(target)
            label = f"grpc://{target}"
        else:
            client = HttpRegistryClient(target)
            label = target
        self.announcer = Announcer(
            client, label, self.plugin.id, self.plugin.version, self.endpoints,
            transports=self.transports, max_concurrency=self.max_concurrency,
        )
        self.announcer.start()

    # ------------------------------------------------------------------ stop

    def request_stop(self) -> None:
        self._stop_requested.set()

    def stop(self) -> None:
        if self._stopped:
            return
        self._stopped = True
        if self.announcer is not None:
            self.announcer.stop(withdraw=True)
            self.announcer = None
        self._stop_bindings()
        self.plugin.telemetry.flush()
        log.info("%s stopped", self.plugin.id)

    def _stop_bindings(self) -> None:
        for binding in reversed(self._started):
            try:
                binding.stop()
            except Exception as exc:  # noqa: BLE001 - keep stopping the others
                log.warning("stop %s binding: %s", binding.kind, exc)
        self._started = []

    def wait(self) -> None:
        """Block until SIGINT/SIGTERM (or ``request_stop()`` / a binding failure), then shut down cleanly."""
        previous: dict[int, Any] = {}
        if threading.current_thread() is threading.main_thread():

            def on_signal(signum: int, _frame: Any) -> None:
                log.info("received %s, shutting down", signal.Signals(signum).name)
                self._stop_requested.set()
                for sig in previous:  # a second signal force-quits
                    signal.signal(sig, signal.SIG_DFL)

            for sig in (signal.SIGINT, signal.SIGTERM):
                previous[sig] = signal.signal(sig, on_signal)
        try:
            while not self._stop_requested.wait(0.5):
                pass
        except KeyboardInterrupt:
            pass
        finally:
            self.stop()
            for sig, handler in previous.items():
                signal.signal(sig, handler)
        if self._failure is not None:
            raise RuntimeError(f"binding failed: {self._failure}") from self._failure


def serve(
    plugin: Plugin,
    http_port: int | bool | None = None,
    grpc_port: int | bool | None = None,
    announce: bool = True,
    *,
    http: int | bool | None = None,
    grpc: int | bool | None = None,
    bindings: Sequence[Binding] = (),
    transports: Iterable[str] | None = None,
    max_concurrency: int | None = None,
    max_queue: int | None = None,
) -> None:
    """Serve ``plugin`` until SIGINT/SIGTERM.

    ``http_port`` (alias ``http=``) defaults to an OS-assigned port; ``grpc_port`` (alias ``grpc=``;
    ``None`` = no gRPC) needs the ``grpc`` extra -- without grpcio it logs a warning and serves without
    it. ``bindings=[...]`` adds more faces (``landflow_sdk.Binding``), ``transports=[...]`` limits the
    kinds that run, ``max_concurrency=`` bounds the calls one instance runs at once and ``max_queue=`` how
    many wait for a slot before further ones are refused (default ``max_concurrency``).
    ``LANDFLOW_HTTP_PORT`` / ``LANDFLOW_GRPC_PORT`` / ``LANDFLOW_TRANSPORTS`` / ``LANDFLOW_MAX_CONCURRENCY``
    override the arguments. With ``announce=True`` each endpoint is announced to ``LANDFLOW_REGISTRY_URL``
    and re-announced on every heartbeat; on shutdown it is withdrawn.

    Logs go to stdout as JSON lines with trace ids (``LANDFLOW_LOG_FORMAT=pretty``
    for humans) unless the application configured ``logging`` itself.
    """
    configure_logging(plugin)
    server = PluginServer(
        plugin, http_port=http_port, grpc_port=grpc_port, announce=announce,
        http=http, grpc=grpc, bindings=bindings, transports=transports, max_concurrency=max_concurrency, max_queue=max_queue,
    )
    server.start()
    server.wait()
