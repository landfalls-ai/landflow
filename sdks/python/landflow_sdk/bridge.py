"""Brokers through ``landflow-bridge``: when ``LANDFLOW_TRANSPORTS`` (or ``serve(transports=...)``) names a broker
kind the Python SDK has no native driver for, ``serve()`` starts the bridge (``services/landflow-bridge``, a Go
sidecar) as a child process pointed at this plugin's gRPC (or HTTP) port. The bridge serves the plugin over every
broker it has a driver for, announces it on the broker's registry channel and forwards each brokered call back here
(docs/transports.md "How each language gets every broker").

Configuration:
  LANDFLOW_BRIDGE=off        never start the bridge (the kinds are then reported as unconfigured and ignored)
  LANDFLOW_BRIDGE_BIN        the binary (else ``landflow-bridge`` on PATH, else the checkout's
                             ``services/landflow-bridge/bin/landflow-bridge``)
  LANDFLOW_<KIND>_URL ...    the broker connections, passed through unchanged; LANDFLOW_TRANSPORT_SECRET and
                             LANDFLOW_REGISTRY_SECRET likewise (the bridge needs the transport secret)

The child inherits the environment with ``LANDFLOW_BRIDGE_TARGET``, ``LANDFLOW_TRANSPORTS`` (the bridged kinds only),
``LANDFLOW_BRIDGE_INSTANCE_ID`` (this process's instance id, so the host sees one plugin with several endpoints) and
``LANDFLOW_MCP=off`` (this plugin serves its own MCP face) set. It is stopped on shutdown and restarted with backoff
when it dies; a missing binary is one clear error line and the plugin keeps serving HTTP/gRPC.

Native drivers (stream H): ``NATIVE_BROKER_BINDINGS`` maps a kind to a factory returning a ``Binding``; a kind with
an entry is served natively and never bridged.
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import sys
import threading
from pathlib import Path
from typing import Callable, Sequence

from .announce import INSTANCE_ID
from .binding import Binding, BindingContext, BindingInfo, GrpcBinding, HttpBinding

log = logging.getLogger("landflow_sdk.bridge")

_OFF = {"off", "false", "no", "0", "none", "disabled"}

#: Native broker bindings by kind (``"kafka"``, ``"nats"``, ...): a factory returning an unstarted ``Binding`` for the
#: kind configured from the environment (``LANDFLOW_<KIND>_URL``). Driver modules register here on import; ``serve()``
#: consults it through ``native_binding_for()`` before falling back to the bridge.
NATIVE_BROKER_BINDINGS: dict[str, Callable[[], Binding]] = {}

#: Faces the plugin serves itself; never bridged.
DIRECT_KINDS = frozenset({"http", "grpc", "mcp"})

#: How long ``stop()`` gives the bridge to drain before killing it.
STOP_TIMEOUT_SECONDS = 15.0
_BACKOFF_MIN, _BACKOFF_MAX = 1.0, 30.0


def register_native_binding(kind: str, factory: Callable[[], Binding]) -> None:
    """Register a native driver for ``kind`` (stream H's drivers call this on import)."""
    NATIVE_BROKER_BINDINGS[kind.lower()] = factory


def has_native_driver(kind: str) -> bool:
    """Whether the Python SDK serves ``kind`` natively (so it is not bridged): a registered factory, or one of
    ``landflow_sdk.transport``'s drivers whose client library is installed (``driver_available``)."""
    from .transport.drivers import driver_available

    return kind.lower() in NATIVE_BROKER_BINDINGS or driver_available(kind) is None


def native_binding_for(kind: str) -> Binding | None:
    """A new native ``Binding`` for ``kind``, or ``None`` when there is no native driver (or its ``LANDFLOW_<KIND>_URL`` is unset).
    A registered factory wins; else the SDK's own driver (``landflow_sdk.transport``) configured from the environment."""
    factory = NATIVE_BROKER_BINDINGS.get(kind.lower())
    if factory is not None:
        return factory()
    from .transport.binding import native_binding_from_env

    return native_binding_from_env(kind)


def bridge_enabled(env: dict[str, str] | None = None) -> bool:
    """``LANDFLOW_BRIDGE`` is not ``off``."""
    env = os.environ if env is None else env
    return env.get("LANDFLOW_BRIDGE", "").strip().lower() not in _OFF


def find_bridge_binary(env: dict[str, str] | None = None) -> str | None:
    """``LANDFLOW_BRIDGE_BIN``, else ``landflow-bridge`` on PATH, else the checkout's built binary."""
    env = os.environ if env is None else env
    explicit = env.get("LANDFLOW_BRIDGE_BIN", "").strip()
    if explicit:
        return explicit if Path(explicit).exists() else None
    found = shutil.which("landflow-bridge")
    if found:
        return found
    checkout = Path(__file__).resolve().parents[3] / "services" / "landflow-bridge" / "bin" / "landflow-bridge"
    if checkout.exists():
        return str(checkout)
    return None


def bridge_binding_for(kinds: Sequence[str], configured: Sequence[Binding], env: dict[str, str] | None = None) -> BridgeBinding | None:
    """The ``BridgeBinding`` for the broker kinds in ``kinds`` that have no native driver and a ``LANDFLOW_<KIND>_URL``,
    or ``None`` when there is nothing to bridge or ``LANDFLOW_BRIDGE=off``. ``configured`` are the plugin's own bindings (the HTTP and gRPC ones
    give the bridge its target once they have started)."""
    env = os.environ if env is None else env
    # Only kinds that have a connection (LANDFLOW_<KIND>_URL) are bridged, as the Go SDK does; a kind without a URL
    # is left to serve()'s "no such binding" warning.
    bridged = [k.lower() for k in kinds if k.lower() not in DIRECT_KINDS and not has_native_driver(k) and env.get(url_env(k), "").strip()]
    if not bridged or not bridge_enabled(env):
        return None
    return BridgeBinding(bridged, configured, env=env)


def url_env(kind: str) -> str:
    """``LANDFLOW_<KIND>_URL`` for a kind."""
    return "LANDFLOW_" + kind.upper().replace("-", "_") + "_URL"


class BridgeBinding(Binding):
    """One ``landflow-bridge`` child process serving ``kinds`` for this plugin.

    ``kind`` is ``"bridge"`` for ``LANDFLOW_TRANSPORTS`` purposes; ``kinds`` are the broker kinds it serves (listed in
    the manifest's ``transports`` hint). The target is the plugin's gRPC binding (preferred) or its HTTP binding.
    """

    kind = "bridge"

    def __init__(self, kinds: Sequence[str], siblings: Sequence[Binding] = (), *, env: dict[str, str] | None = None,
                 binary: str | None = None) -> None:
        self.kinds = [k.lower() for k in kinds]
        self.siblings = list(siblings)
        self.env = dict(os.environ if env is None else env)
        self.binary = binary
        self.process: subprocess.Popen[bytes] | None = None
        self.restarts = 0
        self._stopping = threading.Event()
        self._thread: threading.Thread | None = None
        self._context: BindingContext | None = None
        self._lock = threading.Lock()

    # ------------------------------------------------------------ target

    def target(self) -> str | None:
        """``grpc://127.0.0.1:<port>`` or ``http://127.0.0.1:<port>`` from the started sibling bindings."""
        host = "127.0.0.1"
        if self._context is not None and self._context.bind_host not in ("0.0.0.0", "::", ""):
            host = self._context.bind_host
        if ":" in host and not host.startswith("["):
            host = f"[{host}]"
        for binding in self.siblings:
            if isinstance(binding, GrpcBinding) and binding.server is not None:
                return f"grpc://{host}:{binding.port}"
        for binding in self.siblings:
            if isinstance(binding, HttpBinding) and binding.server is not None:
                return f"http://{host}:{binding.port}"
        return None

    def child_env(self, target: str) -> dict[str, str]:
        env = dict(self.env)
        env["LANDFLOW_BRIDGE_TARGET"] = target
        env["LANDFLOW_TRANSPORTS"] = ",".join(self.kinds)
        env["LANDFLOW_BRIDGE_INSTANCE_ID"] = INSTANCE_ID
        env["LANDFLOW_MCP"] = "off"
        env.pop("LANDFLOW_HTTP_PORT", None)
        env.pop("LANDFLOW_GRPC_PORT", None)
        return env

    # ------------------------------------------------------------ binding

    def start(self, context: BindingContext) -> BindingInfo:
        self._context = context
        if self.binary is None:
            self.binary = find_bridge_binary(self.env)
        if self.binary is None:
            log.error(
                "%s: no landflow-bridge binary (set LANDFLOW_BRIDGE_BIN, put landflow-bridge on PATH, or build "
                "services/landflow-bridge); serving without it",
                ", ".join(self.kinds),
            )
            return BindingInfo([])
        target = self.target()
        if target is None:
            log.error("%s: the bridge needs the plugin's gRPC or HTTP face to forward to; serving without it", ", ".join(self.kinds))
            return BindingInfo([])
        if not self.env.get("LANDFLOW_TRANSPORT_SECRET", "").strip() and not self.env.get("LANDFLOW_REGISTRY_SECRET", "").strip():
            log.error("%s: LANDFLOW_TRANSPORT_SECRET is not set; the bridge cannot serve a broker without it; serving without it", ", ".join(self.kinds))
            return BindingInfo([])
        self._spawn(target)
        self._thread = threading.Thread(target=self._supervise, name="landflow-bridge", daemon=True)
        self._thread.start()
        log.info("landflow-bridge serving %s for %s (pid %s)", ", ".join(self.kinds), target, self.process.pid if self.process else "?")
        # Brokered endpoints are announced by the bridge on the broker's registry channel, not through the HTTP announce.
        return BindingInfo([])

    def _spawn(self, target: str) -> None:
        assert self.binary is not None
        self.process = subprocess.Popen(  # noqa: S603 - the bridge binary, chosen by the deployment
            [self.binary], env=self.child_env(target), stdin=subprocess.DEVNULL, stdout=sys.stdout, stderr=sys.stderr,
        )

    def _supervise(self) -> None:
        backoff = _BACKOFF_MIN
        while not self._stopping.is_set():
            process = self.process
            if process is None:
                return
            code = process.wait()
            if self._stopping.is_set():
                return
            target = self.target()
            log.error("landflow-bridge exited with status %s; restarting in %.0f s", code, backoff)
            if self._stopping.wait(backoff):
                return
            backoff = min(backoff * 2, _BACKOFF_MAX)
            if target is None:
                continue
            try:
                self._spawn(target)
                self.restarts += 1
            except OSError as exc:
                log.error("landflow-bridge could not be restarted: %s", exc)
                return

    def stop(self) -> None:
        self._stopping.set()
        process = self.process
        self.process = None
        if process is None:
            return
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(STOP_TIMEOUT_SECONDS)
            except subprocess.TimeoutExpired:
                log.warning("landflow-bridge did not stop within %.0f s; killing it", STOP_TIMEOUT_SECONDS)
                process.kill()
                process.wait(5)
        if self._thread is not None:
            self._thread.join(2)
            self._thread = None
        log.info("landflow-bridge stopped")

    def alive(self) -> bool:
        """Whether the child is running now."""
        return self.process is not None and self.process.poll() is None

