"""ExecuteRequest.idempotencyKey reaches ctx.idempotency_key in-process, over HTTP and over gRPC."""

from __future__ import annotations

import json
import sys
import unittest
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from landflow_sdk import Node, Plugin  # noqa: E402
from landflow_sdk.http_server import HttpPluginServer  # noqa: E402

try:
    from landflow_sdk import grpc_server
except Exception:  # noqa: BLE001 - grpc extra not installed
    grpc_server = None


class Key(Node):
    description = {
        "name": "key", "displayName": "Key", "description": "test", "version": 1, "kind": "action",
        "inputs": [{"type": "main"}], "outputs": [{"type": "main"}], "properties": [],
    }

    def execute(self, ctx):
        return [{"key": ctx.idempotency_key}]


PLUGIN = Plugin("idem", "Idem", "1", nodes=[Key()])


def _request(key: str | None = None) -> dict:
    request = {
        "protocol": "landflow.plugin/v1", "executionId": "ex_1", "mode": "manual",
        "node": {"id": "n3", "name": "Key", "type": "idem.key", "typeVersion": 1},
        "parameters": {}, "itemParameters": [{}], "inputs": [[{"json": {}}]],
    }
    if key is not None:
        request["idempotencyKey"] = key
    return request


def _key(response: dict):
    return response["outputs"][0][0]["json"]["key"]


class IdempotencyKeyTests(unittest.TestCase):
    def test_context(self):
        self.assertEqual(_key(PLUGIN.execute(_request("ex_1:n3:0"))), "ex_1:n3:0")
        self.assertIsNone(_key(PLUGIN.execute(_request())))
        self.assertIsNone(_key(PLUGIN.execute(_request(""))))

    def test_http(self):
        server = HttpPluginServer(PLUGIN, "127.0.0.1", 0)
        server.start()
        try:
            for key, expected in (("ex_1:n3:1", "ex_1:n3:1"), (None, None)):
                body = json.dumps(_request(key)).encode()
                call = urllib.request.Request(
                    f"http://127.0.0.1:{server.port}/landflow/v1/execute", data=body, headers={"Content-Type": "application/json"}
                )
                with urllib.request.urlopen(call, timeout=5) as response:
                    self.assertEqual(_key(json.loads(response.read())), expected)
        finally:
            server.stop()

    @unittest.skipIf(grpc_server is None, "grpc extra not installed")
    def test_grpc(self):
        import grpc

        from landflow_sdk._pb import plugin_pb2_grpc as pb_grpc

        self.assertNotIn("idempotencyKey", grpc_server.execute_request_from_proto(grpc_server.execute_request_to_proto(_request())))
        self.assertEqual(grpc_server.execute_request_to_proto(_request()).idempotency_key, "")
        server = grpc_server.GrpcPluginServer(PLUGIN, "127.0.0.1", 0)
        server.start()
        channel = grpc.insecure_channel(f"127.0.0.1:{server.port}")
        try:
            stub = pb_grpc.PluginServiceStub(channel)
            for key, expected in (("ex_1:n3:2", "ex_1:n3:2"), (None, None)):
                out = stub.Execute(grpc_server.execute_request_to_proto(_request(key)), timeout=5)
                self.assertEqual(_key(grpc_server.execute_response_from_proto(out)), expected)
        finally:
            channel.close()
            server.stop()


if __name__ == "__main__":
    unittest.main()
