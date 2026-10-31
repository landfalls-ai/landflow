"""ctx.artifact / ctx.check land in ExecuteResponse.records in-process, over HTTP and across the gRPC conversion."""

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


def _description(name: str) -> dict:
    return {
        "name": name, "displayName": name, "description": "test", "version": 1, "kind": "action",
        "inputs": [{"type": "main"}], "outputs": [{"type": "main"}], "properties": [],
    }


class Reporter(Node):
    description = _description("reporter")

    def execute(self, ctx):
        ctx.artifact("PR #7: Fix it", kind="pull_request", url="https://example.test/pr/7", data={"number": 7})
        ctx.check("tests", "fail", message="2 failed", subject="suite", evidence={"failed": 2})
        return [{"ok": True}]


class Failing(Node):
    description = _description("failing")

    def execute(self, ctx):
        ctx.check("lint", "warn")
        raise RuntimeError("boom")


class Quiet(Node):
    description = _description("quiet")

    def execute(self, ctx):
        return [{}]


class BadStatus(Node):
    description = _description("badstatus")

    def execute(self, ctx):
        ctx.check("x", "maybe")
        return [{}]


PLUGIN = Plugin("rec", "Rec", "1", nodes=[Reporter(), Failing(), Quiet(), BadStatus()])


def _request(node: str) -> dict:
    return {
        "protocol": "landflow.plugin/v1", "executionId": "ex_1", "mode": "manual",
        "node": {"id": "n1", "name": node, "type": f"rec.{node}", "typeVersion": 1},
        "parameters": {}, "itemParameters": [{}], "inputs": [[{"json": {}}]],
    }


class RecordsTests(unittest.TestCase):
    def test_collected_in_order_with_time(self):
        records = PLUGIN.execute(_request("reporter"))["records"]
        self.assertEqual([r["type"] for r in records], ["artifact", "check"])
        self.assertEqual(records[0]["name"], "PR #7: Fix it")
        self.assertEqual(records[0]["kind"], "pull_request")
        self.assertEqual(records[0]["url"], "https://example.test/pr/7")
        self.assertEqual(records[0]["data"], {"number": 7})
        self.assertNotIn("mimeType", records[0])
        self.assertEqual(records[1]["status"], "fail")
        self.assertEqual(records[1]["evidence"], {"failed": 2})
        self.assertTrue(records[0]["at"].endswith("Z"))

    def test_absent_when_none(self):
        self.assertNotIn("records", PLUGIN.execute(_request("quiet")))

    def test_kept_when_the_node_fails(self):
        response = PLUGIN.execute(_request("failing"))
        self.assertIn("error", response)
        self.assertEqual(response["records"][0]["status"], "warn")

    def test_bad_status_fails_the_node(self):
        self.assertIn("check status", PLUGIN.execute(_request("badstatus"))["error"]["message"])

    def test_http(self):
        server = HttpPluginServer(PLUGIN, "127.0.0.1", 0)
        server.start()
        try:
            req = urllib.request.Request(
                f"http://127.0.0.1:{server.port}/landflow/v1/execute",
                data=json.dumps(_request("reporter")).encode(),
                headers={"content-type": "application/json"},
            )
            body = json.loads(urllib.request.urlopen(req).read())
            self.assertEqual(len(body["records"]), 2)
        finally:
            server.stop()

    @unittest.skipIf(grpc_server is None, "grpc extra not installed")
    def test_grpc_conversion(self):
        response = PLUGIN.execute(_request("reporter"))
        back = grpc_server.execute_response_from_proto(grpc_server.execute_response_to_proto(response))
        self.assertEqual(back["records"], response["records"])
        self.assertNotIn("records", grpc_server.execute_response_from_proto(grpc_server.execute_response_to_proto(PLUGIN.execute(_request("quiet")))))

    @unittest.skipIf(grpc_server is None, "grpc extra not installed")
    def test_grpc_call(self):
        import grpc

        from landflow_sdk._pb import plugin_pb2_grpc as pb_grpc

        server = grpc_server.GrpcPluginServer(PLUGIN, "127.0.0.1", 0)
        server.start()
        channel = grpc.insecure_channel(f"127.0.0.1:{server.port}")
        try:
            out = pb_grpc.PluginServiceStub(channel).Execute(grpc_server.execute_request_to_proto(_request("reporter")), timeout=5)
            records = grpc_server.execute_response_from_proto(out)["records"]
            self.assertEqual([r["name"] for r in records], ["PR #7: Fix it", "tests"])
        finally:
            channel.close()
            server.stop()


if __name__ == "__main__":
    unittest.main()
