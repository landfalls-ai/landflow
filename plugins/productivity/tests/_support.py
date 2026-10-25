"""Test helpers: import paths, a scriptable fake API server, request builders and log capture.

No test talks to a real service: every API is a local ``http.server`` imitating the endpoints
the nodes call, with fake tokens such as ``test-token-123``.
"""

from __future__ import annotations

import io
import json
import logging
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs, urlsplit

PLUGIN_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PLUGIN_DIR))
try:
    import landflow_sdk  # noqa: F401
except ImportError:  # not installed: use the SDK from this checkout
    sys.path.insert(0, str(PLUGIN_DIR.parents[1] / "sdks" / "python"))

from landflow_sdk.logs import LogFormatter  # noqa: E402
from landflow_sdk.telemetry import Telemetry  # noqa: E402

from productivity import build_plugin  # noqa: E402

TOKEN = "test-token-123"
TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
PARENT_SPAN_ID = "00f067aa0ba902b7"
TRACEPARENT = f"00-{TRACE_ID}-{PARENT_SPAN_ID}-01"


def make_plugin():
    """The real plugin with built-in (no OpenTelemetry) telemetry, so metrics can be read back."""
    return build_plugin(telemetry=Telemetry("productivity", "test", env={}, use_otel=False))


def execute(plugin, node: str, parameters: dict[str, Any] | None = None, *, credentials: dict[str, Any] | None = None,
            inputs: list[dict[str, Any]] | None = None, item_parameters: list[dict[str, Any]] | None = None,
            mode: str = "manual", poll_state: dict[str, Any] | None = None, headers: dict[str, str] | None = None,
            continue_on_fail: bool = False) -> dict[str, Any]:
    request: dict[str, Any] = {
        "protocol": "landflow.plugin/v1",
        "executionId": "ex_test",
        "workflowId": "wf_test",
        "mode": mode,
        "node": {"id": "n1", "name": node, "type": f"productivity.{node}", "typeVersion": 1},
        "parameters": parameters or {},
        "itemParameters": item_parameters or [],
        "inputs": [inputs if inputs is not None else [{"json": {}}]] if mode != "poll" else [],
    }
    if credentials:
        request["credentials"] = credentials
    if poll_state is not None:
        request["pollState"] = poll_state
    if continue_on_fail:
        request["continueOnFail"] = True
    return plugin.execute(request, headers)


def jsons(response: dict[str, Any]) -> list[dict[str, Any]]:
    """The ``json`` of every item on output 0 (fails loudly when the node returned an error)."""
    if "error" in response:
        raise AssertionError(f"node failed: {response['error']}")
    return [item["json"] for item in response["outputs"][0]]


def paired(response: dict[str, Any]) -> list[int]:
    return [item["pairedItem"]["item"] for item in response["outputs"][0]]


def metric_value(plugin, name: str, **labels: str) -> float:
    """Sum of a Prometheus series whose labels include ``labels``."""
    total = 0.0
    prom = name.replace(".", "_") + "_total"
    for line in plugin.telemetry.render_prometheus().splitlines():
        if not line.startswith(prom + "{"):
            continue
        if all(f'{k}="{v}"' in line for k, v in labels.items()):
            total += float(line.rsplit(" ", 1)[1])
    return total


Handler = Callable[[dict[str, Any]], Any]


class FakeApi:
    """A local HTTP server: ``route(method, path_regex, response)`` where ``response`` is a body (200),
    ``(status, body)``, ``(status, body, headers)`` or a function of the recorded request.

    Recorded requests: ``{method, path, query (parse_qs), headers (lower-case), json, body}``.
    Unmatched requests get ``404 {"message": "no route"}``.
    """

    def __init__(self) -> None:
        self.routes: list[tuple[str, re.Pattern[str], Any]] = []
        self.requests: list[dict[str, Any]] = []
        outer = self

        class _Handler(BaseHTTPRequestHandler):
            def _handle(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""
                parts = urlsplit(self.path)
                try:
                    body = json.loads(raw) if raw else None
                except ValueError:
                    body = None
                record = {"method": self.command, "path": parts.path, "query": parse_qs(parts.query), "rawQuery": parts.query,
                          "headers": {k.lower(): v for k, v in self.headers.items()}, "json": body, "body": raw}
                outer.requests.append(record)
                status, payload, headers = outer._respond(record)
                if isinstance(payload, (dict, list)):
                    data = json.dumps(payload).encode()
                    headers.setdefault("Content-Type", "application/json; charset=utf-8")
                elif isinstance(payload, str):
                    data = payload.encode()
                else:
                    data = payload or b""
                self.send_response(status)
                for key, value in headers.items():
                    self.send_header(key, value.replace("{base}", outer.url))
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = _handle

            def log_message(self, *args: object) -> None:
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        self._thread = threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)

    def route(self, method: str, pattern: str, response: Any) -> "FakeApi":
        self.routes.insert(0, (method, re.compile(pattern), response))  # later routes win
        return self

    def reset(self) -> None:
        self.routes.clear()
        self.requests.clear()

    def calls(self, method: str | None = None, path: str | None = None) -> list[dict[str, Any]]:
        return [r for r in self.requests if (method is None or r["method"] == method) and (path is None or re.fullmatch(path, r["path"]))]

    def _respond(self, record: dict[str, Any]) -> tuple[int, Any, dict[str, str]]:
        for method, pattern, response in self.routes:
            if method == record["method"] and pattern.fullmatch(record["path"]):
                result = response(record) if callable(response) else response
                if isinstance(result, tuple):
                    status, body, *rest = result
                    return status, body, dict(rest[0]) if rest else {}
                return 200, result, {}
        return 404, {"message": "no route"}, {}

    def __enter__(self) -> "FakeApi":
        self._thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


class LogCapture:
    """Every log record (including ``span.end`` lines) as parsed JSON."""

    def __enter__(self) -> "LogCapture":
        self.stream = io.StringIO()
        self.handler = logging.StreamHandler(self.stream)
        self.handler.setFormatter(LogFormatter("landflow-plugin-productivity", "json"))
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

    def spans(self, prefix: str = "") -> list[dict[str, Any]]:
        lines = [json.loads(line) for line in self.text.splitlines() if line.startswith("{")]
        return [line for line in lines if line.get("msg") == "span.end" and line["span"].startswith(prefix)]
