"""HTTP+JSON binding: a zero-dependency server built on ``http.server``.

Also serves ``GET /metrics`` (Prometheus text, unless ``LANDFLOW_METRICS_PROMETHEUS=false``).
Request headers are handed to the dispatcher so server spans continue the caller's
W3C trace; health, manifest and metrics requests open no spans. Every call goes through the
plugin's ``Dispatcher`` (concurrency limit, ``landflow.transport = "http"``); the call's deadline
comes in the ``x-landflow-deadline`` header (epoch ms; absent = none). A capacity refusal is 429 with
``Retry-After: 1``, a deadline that passed 504, a cancelled call 499 (nginx's "client closed request").
"""

from __future__ import annotations

import json
import logging
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable

from ._version import __version__
from .dispatcher import CallCancelledError, CancelToken, Dispatcher, OverloadedError
from .errors import ProtocolError, UnknownCredentialTypeError, UnknownMethodError, UnknownNodeError
from .plugin import Plugin
from .protocol import HTTP_PATHS, METRICS_PATH, dumps
from .registry_proof import REGISTRY_CHALLENGE_HEADER, REGISTRY_PROOF_HEADER, answer_registry_challenge

log = logging.getLogger("landflow_sdk.http")

MAX_BODY_BYTES = 64 * 1024 * 1024
_GET_PATHS = {HTTP_PATHS["wellKnown"], HTTP_PATHS["manifest"], HTTP_PATHS["health"], METRICS_PATH}
_POST_PATHS = {
    HTTP_PATHS["execute"],
    HTTP_PATHS["loadOptions"],
    HTTP_PATHS["testCredentials"],
    HTTP_PATHS["webhookMethod"],
    HTTP_PATHS["webhook"],
}
PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8"
DEADLINE_HEADER = "x-landflow-deadline"
"""Request header: epoch ms after which the call must not run (and must stop). Absent or unparsable: no deadline."""
STATUS_CLIENT_CLOSED_REQUEST = 499


def deadline_from_header(value: str | None) -> float | None:
    """The ``x-landflow-deadline`` header (epoch ms) as a ``time.monotonic()`` instant, ``None`` when absent or invalid."""
    if not value:
        return None
    try:
        epoch_ms = int(value.strip())
    except ValueError:
        return None
    if epoch_ms <= 0:
        return None
    return time.monotonic() + (epoch_ms / 1000.0 - time.time())


class _BadRequest(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


MountHandler = Callable[..., None]
"""A handler mounted next to the protocol paths: ``handler(request_handler, body, disconnected=Event)`` writes the response itself."""


class _Server(ThreadingHTTPServer):
    daemon_threads = True
    plugin: Plugin
    dispatcher: Dispatcher
    mounts: dict[str, MountHandler]


def _watch_disconnect(sock: Any, on_close: Callable[[], None], stop: threading.Event) -> threading.Thread:
    """Poll the client socket while a call runs: a peer that closed the connection (``recv`` of 0 bytes with
    ``MSG_PEEK``) cancels the call, as closing the request does over the other faces."""

    def run() -> None:
        while not stop.wait(0.05):
            try:
                sock.settimeout(0.0)
                data = sock.recv(1, socket.MSG_PEEK)
            except (BlockingIOError, InterruptedError):
                continue
            except OSError:
                data = b""
            finally:
                try:
                    sock.settimeout(None)
                except OSError:
                    pass
            if data == b"":
                on_close()
                return

    thread = threading.Thread(target=run, name="landflow-http-watch", daemon=True)
    thread.start()
    return thread


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"  # keep-alive; every response carries Content-Length
    server_version = f"landflow-sdk-python/{__version__}"
    timeout = 60  # seconds an idle keep-alive connection may hold a thread
    server: _Server

    # ---------------------------------------------------------------- verbs

    def _mounted(self, path: str) -> MountHandler | None:
        for prefix, handler in self.server.mounts.items():
            if path == prefix or path.startswith(prefix + "/"):
                return handler
        return None

    def _serve_mount(self, handler: MountHandler) -> None:
        try:
            body = self._read_body()
        except _BadRequest as exc:
            self.close_connection = True
            self._send_error(exc.status, exc.message)
            return
        disconnected = threading.Event()
        stop = threading.Event()
        _watch_disconnect(self.connection, disconnected.set, stop)
        try:
            handler(self, body, disconnected=disconnected)
        except Exception as exc:  # noqa: BLE001 - the mounted handler's bug
            log.exception("error handling %s", self.path)
            self._send_error(500, f"{type(exc).__name__}: {exc}")
        finally:
            stop.set()

    def do_DELETE(self) -> None:  # noqa: N802
        handler = self._mounted(self._route())
        if handler is not None:
            self._serve_mount(handler)
        else:
            self._send_error(405, "method DELETE not allowed", allow="GET, POST")

    def do_GET(self) -> None:  # noqa: N802 - http.server naming
        path = self._route()
        mounted = self._mounted(path)
        if mounted is not None:
            self._serve_mount(mounted)
            return
        plugin = self.server.plugin
        dispatcher = self.server.dispatcher
        if path == HTTP_PATHS["wellKnown"]:
            self._send(200, dispatcher.well_known())
        elif path == HTTP_PATHS["manifest"]:
            # Kubernetes discovery: prove LANDFLOW_REGISTRY_SECRET when the host sends a challenge.
            proof = answer_registry_challenge(plugin.id, self.headers.get(REGISTRY_CHALLENGE_HEADER))
            self._send(200, dispatcher.manifest(), headers={REGISTRY_PROOF_HEADER: proof} if proof else None)
        elif path == HTTP_PATHS["health"]:
            self._send(200, dispatcher.health())
        elif path == METRICS_PATH and plugin.telemetry.prometheus:
            self._send_raw(200, plugin.telemetry.render_prometheus().encode("utf-8"), PROMETHEUS_CONTENT_TYPE)
        elif path in _POST_PATHS:
            self._send_error(405, f"use POST for {path}", allow="POST")
        else:
            self._send_error(404, f"no such endpoint: {path}")

    def do_POST(self) -> None:  # noqa: N802
        path = self._route()
        mounted = self._mounted(path)
        if mounted is not None:
            self._serve_mount(mounted)
            return
        try:
            body = self._read_body()
        except _BadRequest as exc:
            self.close_connection = True
            self._send_error(exc.status, exc.message)
            return
        if path not in _POST_PATHS:
            if path in _GET_PATHS:
                self._send_error(405, f"use GET for {path}", allow="GET")
            else:
                self._send_error(404, f"no such endpoint: {path}")
            return
        try:
            request = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            self._send_error(400, f"malformed JSON body: {exc}")
            return

        dispatcher = self.server.dispatcher
        # The call's token: the x-landflow-deadline header, and the client closing the connection while the call runs.
        cancel = CancelToken(deadline_from_header(self.headers.get(DEADLINE_HEADER)))
        call: dict[str, Any] = {"transport": "http", "cancel": cancel}
        stop_watch = threading.Event()
        _watch_disconnect(self.connection, lambda: cancel.cancel("client closed the connection"), stop_watch)
        try:
            if path == HTTP_PATHS["execute"]:
                response: Any = dispatcher.execute(request, self.headers, **call)
            elif path == HTTP_PATHS["testCredentials"]:
                response = dispatcher.test_credentials_request(request, self.headers, **call)
            elif path == HTTP_PATHS["webhookMethod"]:
                response = dispatcher.webhook_method(request, self.headers, **call)
            elif path == HTTP_PATHS["webhook"]:
                response = dispatcher.receive_webhook(request, self.headers, **call)
            else:
                response = dispatcher.load_options_request(request, self.headers, **call)
        except ProtocolError as exc:
            self._send_error(400, str(exc))
        except (UnknownNodeError, UnknownMethodError, UnknownCredentialTypeError) as exc:
            self._send_error(404, str(exc.args[0] if exc.args else exc))
        except OverloadedError as exc:
            self._send(429, {"error": {"message": str(exc)}}, headers={"Retry-After": "1"})
        except CallCancelledError as exc:
            self._send_error(504 if exc.deadline else STATUS_CLIENT_CLOSED_REQUEST, str(exc))
        except Exception as exc:  # noqa: BLE001 - load_options failures and server bugs
            log.exception("error handling %s", path)
            self._send_error(500, f"{type(exc).__name__}: {exc}")
        else:
            self._send(200, response)
        finally:
            stop_watch.set()

    # -------------------------------------------------------------- helpers

    def _route(self) -> str:
        path = self.path.split("?", 1)[0].split("#", 1)[0]
        return path.rstrip("/") or "/"

    def _read_body(self) -> bytes:
        if "chunked" in self.headers.get("Transfer-Encoding", "").lower():
            return self._read_chunked()
        length = self.headers.get("Content-Length")
        if length is None:
            return b""
        try:
            size = int(length)
        except ValueError:
            raise _BadRequest(400, "invalid Content-Length") from None
        if size < 0:
            raise _BadRequest(400, "invalid Content-Length")
        if size > MAX_BODY_BYTES:
            raise _BadRequest(413, f"request body exceeds {MAX_BODY_BYTES} bytes")
        return self.rfile.read(size)

    def _read_chunked(self) -> bytes:
        chunks: list[bytes] = []
        total = 0
        while True:
            line = self.rfile.readline(65537)
            try:
                size = int(line.split(b";", 1)[0].strip(), 16)
            except ValueError:
                raise _BadRequest(400, "invalid chunked encoding") from None
            if size == 0:
                while self.rfile.readline(65537) not in (b"\r\n", b"\n", b""):
                    pass  # discard trailers
                return b"".join(chunks)
            total += size
            if total > MAX_BODY_BYTES:
                raise _BadRequest(413, f"request body exceeds {MAX_BODY_BYTES} bytes")
            chunks.append(self.rfile.read(size))
            self.rfile.readline()  # CRLF after each chunk

    def _send(self, status: int, payload: Any, allow: str | None = None, headers: dict[str, str] | None = None) -> None:
        self._send_raw(status, dumps(payload), "application/json; charset=utf-8", allow, headers)

    def _send_raw(
        self, status: int, body: bytes, content_type: str, allow: str | None = None, headers: dict[str, str] | None = None
    ) -> None:
        try:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            if allow:
                self.send_header("Allow", allow)
            for name, value in (headers or {}).items():
                self.send_header(name, value)
            if self.close_connection:
                self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    def _send_error(self, status: int, message: str, allow: str | None = None) -> None:
        self._send(status, {"error": {"message": message}}, allow=allow)

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - stdlib signature
        log.debug("%s %s", self.address_string(), format % args)


class HttpPluginServer:
    """Serves ``plugin`` (or a ``Dispatcher``) on ``host:port`` (port 0 = OS-assigned) from a daemon thread."""

    def __init__(self, plugin: Plugin | Dispatcher, host: str = "127.0.0.1", port: int = 0) -> None:
        dispatcher = plugin if isinstance(plugin, Dispatcher) else plugin.dispatcher
        server_cls = _Server
        if ":" in host:  # IPv6 literal
            server_cls = type("_Server6", (_Server,), {"address_family": socket.AF_INET6})
        self.httpd = server_cls((host, port), _Handler)
        self.httpd.plugin = dispatcher.plugin
        self.httpd.dispatcher = dispatcher
        self.httpd.mounts = {}
        self.plugin = dispatcher.plugin
        self.dispatcher = dispatcher
        self.host = host
        self.port: int = self.httpd.server_address[1]
        self._thread: threading.Thread | None = None

    def mount(self, path: str, handler: MountHandler) -> None:
        """Serve ``handler`` at ``path`` (and below) next to the protocol paths; the MCP face mounts itself at ``/mcp``."""
        self.httpd.mounts[path] = handler

    def unmount(self, path: str) -> None:
        self.httpd.mounts.pop(path, None)

    def start(self) -> None:
        self._thread = threading.Thread(
            target=self.httpd.serve_forever, kwargs={"poll_interval": 0.25}, name="landflow-http", daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        if self._thread is not None:
            self.httpd.shutdown()
            self._thread.join(timeout=5)
            self._thread = None
        self.httpd.server_close()
