"""``Binding``: one face of a plugin (HTTP, gRPC, a broker, MCP) over the shared ``Dispatcher``.

A binding converts its wire format to the protocol dicts and calls the dispatcher it was started
with; it holds no node logic. ``PluginServer`` starts bindings in order, announces the endpoints
they return, and stops them in reverse order. The SDK's model is threaded: ``start()`` returns once
the binding accepts calls (serving from its own daemon thread) and ``stop()`` drains and closes.
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Callable, Sequence

from .dispatcher import Dispatcher
from .plugin import Plugin
from .telemetry import Telemetry


@dataclass
class BindingInfo:
    """What ``Binding.start`` returns: the endpoints to announce (``"http://host:port"``,
    ``"grpc://host:port"`` or a logical ``"<kind>://<connectionId>/<pluginId>"``); empty for a binding
    that announces itself (over a broker's registry channel)."""

    endpoints: list[str] = field(default_factory=list)


@dataclass
class BindingContext:
    """What ``PluginServer`` hands every binding.

    ``announce(endpoints)`` registers endpoints learned after ``start`` (a no-op when announce is off);
    ``fail(exc)`` reports a fatal failure after ``start`` (the listener died, the broker connection
    is gone for good): the server logs it and shuts down.
    """

    plugin: Plugin
    dispatcher: Dispatcher
    manifest: dict[str, Any]
    logger: logging.Logger
    telemetry: Telemetry
    bind_host: str = "127.0.0.1"
    advertise_host: str = "127.0.0.1"
    announce: Callable[[Sequence[str]], None] = lambda endpoints: None  # noqa: E731, ARG005
    fail: Callable[[BaseException], None] = lambda exc: None  # noqa: E731, ARG005


class Binding(ABC):
    """One transport face. ``kind`` names it (``"http"``, ``"grpc"``, ``"mcp"``, a broker kind); ``LANDFLOW_TRANSPORTS`` selects by it."""

    kind: str = ""

    @abstractmethod
    def start(self, context: BindingContext) -> BindingInfo:
        """Listen or connect; return the endpoints to announce. Must return once the binding accepts calls."""

    @abstractmethod
    def stop(self) -> None:
        """Drain in-flight calls, then close."""


def _url_host(host: str) -> str:
    return f"[{host}]" if ":" in host and not host.startswith("[") else host


class HttpBinding(Binding):
    """The HTTP+JSON face on ``port`` (0 = any free port). ``PluginServer`` builds one from ``http_port``."""

    kind = "http"

    def __init__(self, port: int = 0) -> None:
        self.port = port
        self.server: Any = None

    def start(self, context: BindingContext) -> BindingInfo:
        from .http_server import HttpPluginServer

        self.server = HttpPluginServer(context.dispatcher, context.bind_host, self.port)
        self.server.start()
        self.port = self.server.port
        return BindingInfo([f"http://{_url_host(context.advertise_host)}:{self.port}"])

    def stop(self) -> None:
        if self.server is not None:
            self.server.stop()
            self.server = None


class GrpcBinding(Binding):
    """The gRPC face on ``port`` (needs the ``grpc`` extra; importing fails without grpcio)."""

    kind = "grpc"

    def __init__(self, port: int = 0, max_workers: int = 16) -> None:
        self.port = port
        self.max_workers = max_workers
        self.server: Any = None

    def start(self, context: BindingContext) -> BindingInfo:
        from .grpc_server import GrpcPluginServer

        self.server = GrpcPluginServer(context.dispatcher, context.bind_host, self.port, max_workers=self.max_workers)
        self.server.start()
        self.port = self.server.port
        return BindingInfo([f"grpc://{_url_host(context.advertise_host)}:{self.port}"])

    def stop(self) -> None:
        if self.server is not None:
            self.server.stop()
            self.server = None
