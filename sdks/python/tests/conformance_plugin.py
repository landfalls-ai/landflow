#!/usr/bin/env python3
"""The conformance plugin (packages/protocol/conformance/README.md "The conformance plugin") built with the Python
SDK, run as its own process by the landflow-bridge tests (services/landflow-bridge) and usable by hand.

    python conformance_plugin.py --http 7442 --grpc 7443 --hooks 7444

``--hooks`` serves what the runners observe (``GET /hooks``: executions, per-node counts, the sleeps' abort flags;
``POST /hooks/reset``). ``LANDFLOW_TRANSPORTS=http,grpc,nats`` with ``LANDFLOW_NATS_URL`` makes ``serve()`` start
``landflow-bridge`` for the broker (``landflow_sdk.bridge``).
"""

from __future__ import annotations

import argparse
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from landflow_sdk import CredentialType, Node, NodeOperationError, Plugin, serve  # noqa: E402

PLUGIN_ID = "landflow-conformance"
MANIFEST = json.loads((Path(__file__).resolve().parents[3] / "packages" / "protocol" / "conformance" / "plugin-manifest.json").read_text())
DESCRIPTORS = {node["name"]: node for node in MANIFEST["nodes"]}


class Hooks:
    """What the runners observe about node runs (the TS runner's ``hooks``)."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.reset()

    def reset(self) -> None:
        with self.lock:
            self.executions = 0
            self.by_node: dict[str, int] = {}
            self.sleeps: list[dict[str, bool]] = []
            self.counters: dict[str, int] = {}

    def ran(self, node: str) -> None:
        with self.lock:
            self.executions += 1
            self.by_node[node] = self.by_node.get(node, 0) + 1

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            return {"executions": self.executions, "byNode": dict(self.by_node), "sleeps": list(self.sleeps), "counters": dict(self.counters)}


hooks = Hooks()


class Echo(Node):
    description = DESCRIPTORS["echo"]

    def execute(self, ctx):
        hooks.ran("echo")
        message = ctx.get_node_parameter("message", 0, "")
        items = ctx.get_input_data()
        if not items:
            return [{"json": {"echo": message}}]
        return [{"json": {**item.get("json", {}), "echo": message}} for item in items]


class Sleep(Node):
    description = DESCRIPTORS["sleep"]

    def execute(self, ctx):
        hooks.ran("sleep")
        record = {"aborted": False}
        with hooks.lock:
            hooks.sleeps.append(record)
        ms = int(ctx.get_node_parameter("ms", 0, 100))
        if ctx.cancel.wait(ms / 1000.0):
            record["aborted"] = True
            raise NodeOperationError("canceled")
        return [{"json": {"sleptMs": ms}}]


class Fail(Node):
    description = DESCRIPTORS["fail"]

    def execute(self, ctx):
        hooks.ran("fail")
        item_index = int(ctx.get_node_parameter("itemIndex", 0, -1))
        raise NodeOperationError(ctx.get_node_parameter("message", 0, "boom"), item_index=item_index if item_index >= 0 else None)


class Payload(Node):
    description = DESCRIPTORS["payload"]

    def execute(self, ctx):
        hooks.ran("payload")
        return [{"json": {"data": "x" * int(ctx.get_node_parameter("bytes", 0, 1024))}}]


class Counter(Node):
    description = DESCRIPTORS["counter"]

    def execute(self, ctx):
        hooks.ran("counter")
        key = ctx.get_node_parameter("key", 0, "default")
        with hooks.lock:
            hooks.counters[key] = count = hooks.counters.get(key, 0) + 1
        return [{"json": {"key": key, "count": count}}]


class Tick(Node):
    description = DESCRIPTORS["tick"]

    def execute(self, ctx):
        return []


class Hidden(Node):
    description = DESCRIPTORS["hidden"]

    def execute(self, ctx):
        hooks.ran("hidden")
        return [{"json": {"field": ctx.get_node_parameter("field", 0, "")}}]


def build_plugin() -> Plugin:
    api = CredentialType(
        name="conformanceApi", display_name="Conformance API",
        properties=[{"name": "token", "displayName": "Token", "type": "string", "required": True, "typeOptions": {"password": True}}],
        test=lambda data, ctx=None: (data.get("token") == "t", "ok" if data.get("token") == "t" else "bad token"),
    )
    info = MANIFEST["plugin"]
    return Plugin(PLUGIN_ID, info["name"], info["version"], nodes=[Echo, Sleep, Fail, Payload, Counter, Tick, Hidden],
                  description=info.get("description"), credential_types=[api])


class HooksHandler(BaseHTTPRequestHandler):
    def log_message(self, *args: Any) -> None:  # quiet
        pass

    def _send(self, body: dict[str, Any]) -> None:
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        self._send(hooks.snapshot())

    def do_POST(self) -> None:  # noqa: N802
        if self.path.startswith("/hooks/reset"):
            hooks.reset()
        self._send(hooks.snapshot())


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--http", type=int, default=7442)
    parser.add_argument("--grpc", type=int, default=7443)
    parser.add_argument("--hooks", type=int, default=0, help="serve GET /hooks and POST /hooks/reset on this port (0 = off)")
    parser.add_argument("--transports", default=None, help="comma-separated kinds (like LANDFLOW_TRANSPORTS)")
    args = parser.parse_args()
    if args.hooks:
        server = ThreadingHTTPServer(("127.0.0.1", args.hooks), HooksHandler)
        threading.Thread(target=server.serve_forever, name="hooks", daemon=True).start()
    transports = [k.strip() for k in args.transports.split(",")] if args.transports else None
    serve(build_plugin(), http=args.http, grpc=args.grpc, transports=transports, max_concurrency=MANIFEST.get("maxConcurrency", 4))


if __name__ == "__main__":
    main()
