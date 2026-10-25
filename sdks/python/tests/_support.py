"""Shared test helpers: SDK import path, log capture, a local HTTP echo server."""

from __future__ import annotations

import io
import json
import logging
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from landflow_sdk.logs import LogFormatter  # noqa: E402
from landflow_sdk.telemetry import Telemetry  # noqa: E402

try:
    from landflow_sdk import grpc_server
except Exception:  # noqa: BLE001 - grpc extra not installed
    grpc_server = None

REMOTE_TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
REMOTE_SPAN_ID = "00f067aa0ba902b7"
TRACEPARENT = f"00-{REMOTE_TRACE_ID}-{REMOTE_SPAN_ID}-01"


def builtin_telemetry(plugin_id: str, **env: str) -> Telemetry:
    """Built-in (no OpenTelemetry) telemetry with an explicit environment."""
    return Telemetry(plugin_id, "1.0.0", env=env, use_otel=False)


class LogCapture:
    """Collect every log record as a parsed JSON line (``LANDFLOW_LOG_FORMAT=json``)."""

    def __init__(self, service: str = "test-service", fmt: str = "json") -> None:
        self.service = service
        self.fmt = fmt

    def __enter__(self) -> "LogCapture":
        self.stream = io.StringIO()
        self.handler = logging.StreamHandler(self.stream)
        self.handler.setFormatter(LogFormatter(self.service, self.fmt))
        root = logging.getLogger()
        self._level = root.level
        root.addHandler(self.handler)
        root.setLevel(logging.DEBUG)
        return self

    def __exit__(self, *exc: object) -> None:
        root = logging.getLogger()
        root.removeHandler(self.handler)
        root.setLevel(self._level)

    @property
    def text(self) -> str:
        return self.stream.getvalue()

    @property
    def lines(self) -> list[dict]:
        return [json.loads(line) for line in self.text.splitlines() if line.startswith("{")]

    def spans(self, prefix: str = "") -> list[dict]:
        return [line for line in self.lines if line.get("msg") == "span.end" and line["span"].startswith(prefix)]

    def span(self, name: str) -> dict:
        matches = [line for line in self.spans() if line["span"] == name]
        if len(matches) != 1:
            raise AssertionError(f"expected one span {name!r}, got {[s['span'] for s in self.spans()]}")
        return matches[0]


class EchoServer:
    """Records request headers; ``/status/<code>`` answers with that status, anything else 200 JSON."""

    def __init__(self) -> None:
        self.requests: list[dict] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def _handle(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length) if length else b""
                parts = urlsplit(self.path)
                outer.requests.append(
                    {"method": self.command, "path": parts.path, "query": parse_qs(parts.query),
                     "headers": {k.lower(): v for k, v in self.headers.items()}, "body": body}
                )
                status = int(parts.path.rsplit("/", 1)[1]) if parts.path.startswith("/status/") else 200
                payload = {"message": "not here"} if status >= 400 else {"ok": True, "path": parts.path}
                data = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("X-Echo", "yes")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = do_PUT = do_DELETE = _handle

            def log_message(self, *args: object) -> None:
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        self._thread = threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)

    def __enter__(self) -> "EchoServer":
        self._thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
