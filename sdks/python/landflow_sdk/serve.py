"""``serve()``: start the HTTP (and optionally gRPC) server, announce, block until signalled."""

from __future__ import annotations

import logging
import os
import signal
import threading
from typing import Any

from .announce import Announcer, HttpRegistryClient, _is_loopback, parse_registry_url
from .http_server import HttpPluginServer
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


def _url_host(host: str) -> str:
    return f"[{host}]" if ":" in host and not host.startswith("[") else host


class PluginServer:
    """Owns the transports and the announcer. ``serve()`` is ``start()`` + ``wait()``.

    Environment (overrides the arguments):
      LANDFLOW_HTTP_PORT / LANDFLOW_GRPC_PORT  listen ports ("off" disables, 0 = any free port)
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
    ) -> None:
        self.plugin = plugin
        self.http_port = _resolve_port("LANDFLOW_HTTP_PORT", http_port, default=0)
        self.grpc_port = _resolve_port("LANDFLOW_GRPC_PORT", grpc_port, default=None)
        self.advertise_host = os.environ.get("LANDFLOW_ADVERTISE_HOST", "").strip() or "127.0.0.1"
        self.bind_host = os.environ.get("LANDFLOW_BIND_HOST", "").strip() or (
            "127.0.0.1" if _is_loopback(self.advertise_host) else "0.0.0.0"
        )
        self.announce = announce
        self.http: HttpPluginServer | None = None
        self.grpc: Any = None
        self.announcer: Announcer | None = None
        self.endpoints: list[str] = []
        self._stop_requested = threading.Event()
        self._stopped = False

    # ----------------------------------------------------------------- start

    def start(self) -> None:
        try:
            self._start_transports()
        except Exception:
            self._stop_transports()
            raise
        log.info(
            "%s %s serving %d node(s) [%s] on %s",
            self.plugin.id,
            self.plugin.version,
            len(self.plugin.node_names),
            ", ".join(self.plugin.node_names),
            "  ".join(self.endpoints),
        )
        if self.announce:
            self._start_announcer()
        else:
            log.info("announce disabled")

    def _start_transports(self) -> None:
        host = _url_host(self.advertise_host)
        if self.grpc_port is not None:
            try:
                from .grpc_server import GrpcPluginServer
            except Exception as exc:  # noqa: BLE001 - ImportError, or stub/runtime version mismatch
                log.warning(
                    "gRPC disabled (%s: %s); serving HTTP only. Install with: pip install 'landflow-sdk[grpc]'",
                    type(exc).__name__,
                    exc,
                )
                self.grpc_port = None
            else:
                self.grpc = GrpcPluginServer(self.plugin, self.bind_host, self.grpc_port)
                self.grpc.start()
                self.grpc_port = self.grpc.port
        if self.http_port is not None:
            self.http = HttpPluginServer(self.plugin, self.bind_host, self.http_port)
            self.http.start()
            self.http_port = self.http.port
            self.endpoints.append(f"http://{host}:{self.http_port}")
        if self.grpc is not None:
            self.endpoints.append(f"grpc://{host}:{self.grpc_port}")
        if not self.endpoints:
            raise RuntimeError("no transport enabled: set an HTTP port and/or install grpcio for gRPC")

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
        self.announcer = Announcer(client, label, self.plugin.id, self.plugin.version, self.endpoints)
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
        self._stop_transports()
        self.plugin.telemetry.flush()
        log.info("%s stopped", self.plugin.id)

    def _stop_transports(self) -> None:
        if self.http is not None:
            self.http.stop()
            self.http = None
        if self.grpc is not None:
            self.grpc.stop()
            self.grpc = None

    def wait(self) -> None:
        """Block until SIGINT/SIGTERM (or ``request_stop()``), then shut down cleanly."""
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


def serve(
    plugin: Plugin,
    http_port: int | bool | None = None,
    grpc_port: int | bool | None = None,
    announce: bool = True,
) -> None:
    """Serve ``plugin`` until SIGINT/SIGTERM.

    ``http_port`` defaults to an OS-assigned port; ``grpc_port`` (``None`` = no
    gRPC) needs the ``grpc`` extra -- without grpcio it logs a warning and
    serves HTTP only. ``LANDFLOW_HTTP_PORT`` / ``LANDFLOW_GRPC_PORT`` override
    the arguments. With ``announce=True`` each endpoint is announced to
    ``LANDFLOW_REGISTRY_URL`` and re-announced on every heartbeat; on shutdown
    it is withdrawn.

    Logs go to stdout as JSON lines with trace ids (``LANDFLOW_LOG_FORMAT=pretty``
    for humans) unless the application configured ``logging`` itself.
    """
    configure_logging(plugin)
    server = PluginServer(plugin, http_port=http_port, grpc_port=grpc_port, announce=announce)
    server.start()
    server.wait()
