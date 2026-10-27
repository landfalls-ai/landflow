"""The three ways the host reaches an app webhook trigger (in process, HTTP, gRPC) as ``.method(request)`` / ``.webhook(request)``."""

from __future__ import annotations

import json
import urllib.request
from typing import Any

from landflow_sdk.http_server import HttpPluginServer

try:
    from landflow_sdk import grpc_server
except Exception:  # noqa: BLE001 - grpc extra not installed
    grpc_server = None


class Direct:
    def __init__(self, plugin: Any) -> None:
        self.plugin = plugin

    def method(self, request: dict) -> dict:
        return self.plugin.webhook_method(request)

    def webhook(self, request: dict) -> dict:
        return self.plugin.receive_webhook(request)


class Http:
    def __init__(self, testcase: Any, plugin: Any) -> None:
        server = HttpPluginServer(plugin, "127.0.0.1", 0)
        server.start()
        testcase.addCleanup(server.stop)
        self.port = server.port

    def _post(self, path: str, body: dict) -> dict:
        request = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=10) as resp:
            return json.loads(resp.read())

    def method(self, request: dict) -> dict:
        return self._post("/landflow/v1/webhook-method", request)

    def webhook(self, request: dict) -> dict:
        return self._post("/landflow/v1/webhook", request)


class Grpc:
    def __init__(self, testcase: Any, plugin: Any) -> None:
        import grpc

        from landflow_sdk._pb import plugin_pb2_grpc as pb_grpc

        server = grpc_server.GrpcPluginServer(plugin, "127.0.0.1", 0)
        server.start()
        testcase.addCleanup(server.stop)
        channel = grpc.insecure_channel(f"127.0.0.1:{server.port}")
        testcase.addCleanup(channel.close)
        self.stub = pb_grpc.PluginServiceStub(channel)

    def method(self, request: dict) -> dict:
        return grpc_server.webhook_method_response_from_proto(self.stub.WebhookMethod(grpc_server.webhook_method_request_to_proto(request), timeout=10))

    def webhook(self, request: dict) -> dict:
        return grpc_server.webhook_response_from_proto(self.stub.ReceiveWebhook(grpc_server.webhook_request_to_proto(request), timeout=10))
