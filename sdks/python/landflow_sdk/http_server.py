"""HTTP+JSON binding: a zero-dependency server built on ``http.server``.

Also serves ``GET /metrics`` (Prometheus text, unless ``LANDFLOW_METRICS_PROMETHEUS=false``).
Request headers are handed to the plugin so server spans continue the caller's
W3C trace; health, manifest and metrics requests open no spans.
"""

from __future__ import annotations

import json
import logging
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from ._version import __version__
from .errors import ProtocolError, UnknownCredentialTypeError, UnknownMethodError, UnknownNodeError
from .plugin import Plugin
from .protocol import HTTP_PATHS, METRICS_PATH, dumps

log = logging.getLogger("landflow_sdk.http")

MAX_BODY_BYTES = 64 * 1024 * 1024
_GET_PATHS = {HTTP_PATHS["wellKnown"], HTTP_PATHS["manifest"], HTTP_PATHS["health"], METRICS_PATH}
_POST_PATHS = {HTTP_PATHS["execute"], HTTP_PATHS["loadOptions"], HTTP_PATHS["testCredentials"]}
PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8"


class _BadRequest(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


class _Server(ThreadingHTTPServer):
    daemon_threads = True
    plugin: Plugin


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"  # keep-alive; every response carries Content-Length
    server_version = f"landflow-sdk-python/{__version__}"
    timeout = 60  # seconds an idle keep-alive connection may hold a thread
    server: _Server

    # ---------------------------------------------------------------- verbs

    def do_GET(self) -> None:  # noqa: N802 - http.server naming
        path = self._route()
        plugin = self.server.plugin
        if path == HTTP_PATHS["wellKnown"]:
            self._send(200, plugin.well_known())
        elif path == HTTP_PATHS["manifest"]:
            self._send(200, plugin.manifest())
        elif path == HTTP_PATHS["health"]:
            self._send(200, plugin.health())
        elif path == METRICS_PATH and plugin.telemetry.prometheus:
            self._send_raw(200, plugin.telemetry.render_prometheus().encode("utf-8"), PROMETHEUS_CONTENT_TYPE)
        elif path in _POST_PATHS:
            self._send_error(405, f"use POST for {path}", allow="POST")
        else:
            self._send_error(404, f"no such endpoint: {path}")

    def do_POST(self) -> None:  # noqa: N802
        path = self._route()
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

        plugin = self.server.plugin
        try:
            if path == HTTP_PATHS["execute"]:
                response: Any = plugin.execute(request, self.headers)
            elif path == HTTP_PATHS["testCredentials"]:
                response = plugin.test_credentials_request(request, self.headers)
            else:
                response = plugin.load_options_request(request, self.headers)
        except ProtocolError as exc:
            self._send_error(400, str(exc))
        except (UnknownNodeError, UnknownMethodError, UnknownCredentialTypeError) as exc:
            self._send_error(404, str(exc.args[0] if exc.args else exc))
        except Exception as exc:  # noqa: BLE001 - load_options failures and server bugs
            log.exception("error handling %s", path)
            self._send_error(500, f"{type(exc).__name__}: {exc}")
        else:
            self._send(200, response)

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

    def _send(self, status: int, payload: Any, allow: str | None = None) -> None:
        self._send_raw(status, dumps(payload), "application/json; charset=utf-8", allow)

    def _send_raw(self, status: int, body: bytes, content_type: str, allow: str | None = None) -> None:
        try:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            if allow:
                self.send_header("Allow", allow)
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
    """Serves ``plugin`` on ``host:port`` (port 0 = OS-assigned) from a daemon thread."""

    def __init__(self, plugin: Plugin, host: str = "127.0.0.1", port: int = 0) -> None:
        server_cls = _Server
        if ":" in host:  # IPv6 literal
            server_cls = type("_Server6", (_Server,), {"address_family": socket.AF_INET6})
        self.httpd = server_cls((host, port), _Handler)
        self.httpd.plugin = plugin
        self.host = host
        self.port: int = self.httpd.server_address[1]
        self._thread: threading.Thread | None = None

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
