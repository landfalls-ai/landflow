"""Core SDK behaviour, transport-agnostic plus an HTTP round trip. Run:

    python3 -m unittest discover -s sdks/python/tests
"""

from __future__ import annotations

import json
import sys
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from landflow_sdk import (  # noqa: E402
    DescriptorError,
    Node,
    NodeOperationError,
    Plugin,
    ProtocolError,
    UnknownMethodError,
    UnknownNodeError,
)
from landflow_sdk.http_server import HttpPluginServer  # noqa: E402

try:
    from landflow_sdk import grpc_server
except Exception:  # noqa: BLE001 - grpc extra not installed
    grpc_server = None


def _descriptor(name: str, **extra) -> dict:
    return {
        "name": name,
        "displayName": name.title(),
        "description": "test",
        "version": 1,
        "kind": "action",
        "inputs": [{"type": "main"}],
        "outputs": [{"type": "main"}],
        "properties": [{"name": "factor", "displayName": "Factor", "type": "number", "default": 2}],
        **extra,
    }


class Double(Node):
    description = _descriptor("double")

    def execute(self, ctx):
        ctx.logger.info("doubling")
        return [{"v": item["json"]["v"] * ctx.get_node_parameter("factor", i)} for i, item in enumerate(ctx.get_input_data())]

    def load_options(self, method, parameters):
        if method == "factors":
            return [1, {"name": "Two", "value": 2}]
        return super().load_options(method, parameters)


class Branches(Node):
    description = _descriptor("branches", outputs=[{"type": "main"}, {"type": "main"}])

    def execute(self, ctx):
        items = ctx.get_input_data()
        return [[i for i in items if i["json"]["v"] > 1]]


class Failing(Node):
    description = _descriptor("failing")

    def execute(self, ctx):
        if ctx.get_node_parameter("kind") == "op":
            raise NodeOperationError("bad item", description="details", item_index=1)
        raise ValueError("boom")


def _request(node_type: str, items: list[dict], parameters=None, item_parameters=None) -> dict:
    return {
        "protocol": "landflow.plugin/v1",
        "executionId": "ex_1",
        "mode": "manual",
        "node": {"id": "n1", "name": "N", "type": node_type, "typeVersion": 1},
        "parameters": parameters or {},
        "itemParameters": item_parameters or [],
        "inputs": [[{"json": j} for j in items]],
    }


PLUGIN = Plugin("test-plugin", "Test", "1.2.3", nodes=[Double, Branches(), Failing()], icon="lucide:flask-conical")


class CoreTests(unittest.TestCase):
    def test_manifest(self):
        manifest = PLUGIN.manifest()
        self.assertEqual(manifest["protocol"], "landflow.plugin/v1")
        self.assertEqual(manifest["plugin"]["language"], "python")
        self.assertEqual(manifest["plugin"]["sdk"]["name"], "landflow-sdk-python")
        self.assertEqual([n["name"] for n in manifest["nodes"]], ["double", "branches", "failing"])

    def test_defaults_follow_display_options(self):
        class Multi(Node):
            description = _descriptor(
                "multi",
                properties=[
                    {"name": "resource", "displayName": "Resource", "type": "options", "default": "message",
                     "options": [{"name": "Message", "value": "message"}, {"name": "Chat", "value": "chat"}]},
                    {"name": "operation", "displayName": "Operation", "type": "options", "default": "send",
                     "options": [{"name": "Send", "value": "send"}], "displayOptions": {"show": {"resource": ["message"]}}},
                    {"name": "operation", "displayName": "Operation", "type": "options", "default": "get",
                     "options": [{"name": "Get", "value": "get"}], "displayOptions": {"show": {"resource": ["chat"]}}},
                ],
            )

            def execute(self, ctx):
                return [{"operation": ctx.get_node_parameter("operation", i)} for i in range(len(ctx.get_input_data()))]

        plugin = Plugin("multi-plugin", "Multi", "1", nodes=[Multi()])
        response = plugin.execute(_request("multi-plugin.multi", [{}, {}], item_parameters=[{}, {"resource": "chat"}]))
        self.assertEqual([item["json"] for item in response["outputs"][0]], [{"operation": "send"}, {"operation": "get"}])

    def test_continue_on_fail_flag(self):
        class Flag(Node):
            description = _descriptor("flag")

            def execute(self, ctx):
                return [{"continue": ctx.continue_on_fail()}]

        plugin = Plugin("flag-plugin", "Flag", "1", nodes=[Flag()])
        on = plugin.execute({**_request("flag-plugin.flag", [{}]), "continueOnFail": True})
        off = plugin.execute(_request("flag-plugin.flag", [{}]))
        self.assertEqual((on["outputs"][0][0]["json"], off["outputs"][0][0]["json"]), ({"continue": True}, {"continue": False}))

    def test_parameters_fallback_and_paired_items(self):
        response = PLUGIN.execute(
            _request("test-plugin.double", [{"v": 1}, {"v": 2}], parameters={"factor": 3}, item_parameters=[{"factor": 10}])
        )
        self.assertNotIn("error", response)
        self.assertEqual(
            response["outputs"],
            [[{"json": {"v": 10}, "pairedItem": {"item": 0}}, {"json": {"v": 6}, "pairedItem": {"item": 1}}]],
        )
        self.assertEqual(response["logs"], [{"level": "info", "message": "doubling"}])
        # descriptor default (2) when neither itemParameters nor parameters has it
        response = PLUGIN.execute(_request("double", [{"v": 4}]))
        self.assertEqual(response["outputs"][0][0]["json"], {"v": 8})

    def test_outputs_padded_and_not_paired_when_lengths_differ(self):
        response = PLUGIN.execute(_request("test-plugin.branches", [{"v": 1}, {"v": 2}]))
        self.assertEqual(response["outputs"], [[{"json": {"v": 2}}], []])

    def test_errors(self):
        op = PLUGIN.execute(_request("test-plugin.failing", [{}], parameters={"kind": "op"}))
        self.assertEqual(op["error"], {"message": "bad item", "description": "details", "itemIndex": 1})
        other = PLUGIN.execute(_request("test-plugin.failing", [{}]))
        self.assertEqual(other["error"], {"message": "boom"})
        with self.assertRaises(UnknownNodeError):
            PLUGIN.execute(_request("test-plugin.nope", []))
        with self.assertRaises(UnknownNodeError):
            PLUGIN.execute(_request("other.double", []))
        with self.assertRaises(ProtocolError):
            PLUGIN.execute({"node": {"type": "test-plugin.double"}, "inputs": [[{"nojson": 1}]]})
        with self.assertRaises(ProtocolError):
            PLUGIN.execute(["not", "an", "object"])

    def test_load_options(self):
        self.assertEqual(
            PLUGIN.load_options("double", "factors", {}), [{"name": "1", "value": 1}, {"name": "Two", "value": 2}]
        )
        with self.assertRaises(UnknownMethodError):
            PLUGIN.load_options("double", "missing", {})

    def test_descriptor_validation(self):
        class Bad(Node):
            description = _descriptor("bad name")

            def execute(self, ctx):
                return []

        with self.assertRaises(DescriptorError):
            Plugin("x", "X", "1", nodes=[Bad()])
        Bad.description = {**_descriptor("bad"), "kind": "sink"}
        with self.assertRaises(DescriptorError):
            Plugin("x", "X", "1", nodes=[Bad()])
        Bad.description = {k: v for k, v in _descriptor("bad").items() if k != "outputs"}
        with self.assertRaises(DescriptorError):
            Plugin("x", "X", "1", nodes=[Bad()])
        with self.assertRaises(DescriptorError):
            Plugin("Not_Kebab", "X", "1", nodes=[Double()])


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HttpPluginServer(PLUGIN, "127.0.0.1", 0)
        cls.server.start()
        cls.base = f"http://127.0.0.1:{cls.server.port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.stop()

    def _call(self, path: str, body: bytes | None = None) -> tuple[int, dict]:
        request = urllib.request.Request(self.base + path, data=body, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read())

    def test_endpoints(self):
        status, doc = self._call("/.well-known/landflow")
        self.assertEqual((status, doc["plugin"]["id"]), (200, "test-plugin"))
        status, health = self._call("/landflow/v1/health")
        self.assertEqual((status, health["status"]), (200, "ok"))
        status, response = self._call("/landflow/v1/execute", json.dumps(_request("test-plugin.double", [{"v": 1}])).encode())
        self.assertEqual((status, response["outputs"][0][0]["json"]), (200, {"v": 2}))
        status, response = self._call("/landflow/v1/execute", json.dumps(_request("test-plugin.failing", [{}])).encode())
        self.assertEqual((status, response["error"]["message"]), (200, "boom"))
        self.assertEqual(self._call("/landflow/v1/execute", b"{nope")[0], 400)
        self.assertEqual(self._call("/landflow/v1/execute", json.dumps(_request("test-plugin.zzz", [])).encode())[0], 404)
        self.assertEqual(self._call("/nope")[0], 404)
        body = json.dumps({"nodeType": "double", "method": "factors", "parameters": {}}).encode()
        self.assertEqual(self._call("/landflow/v1/load-options", body)[1]["options"][1]["value"], 2)


@unittest.skipIf(grpc_server is None, "grpc extra not installed")
class GrpcConversionTests(unittest.TestCase):
    def test_round_trip(self):
        request = _request("test-plugin.double", [{"v": 1}, {"v": 2}], parameters={"factor": 5})
        request["workflowId"] = "wf_1"
        request["continueOnFail"] = True
        decoded = grpc_server.execute_request_from_proto(grpc_server.execute_request_to_proto(request))
        self.assertEqual(decoded["parameters"], {"factor": 5})
        self.assertEqual(decoded["workflowId"], "wf_1")
        self.assertIs(decoded["continueOnFail"], True)
        self.assertNotIn("continueOnFail", grpc_server.execute_request_from_proto(grpc_server.execute_request_to_proto(_request("x.y", []))))
        self.assertEqual(decoded["inputs"], request["inputs"])
        response = PLUGIN.execute(decoded)
        back = grpc_server.execute_response_from_proto(grpc_server.execute_response_to_proto(response))
        self.assertEqual(back["outputs"][0][1], {"json": {"v": 10}, "pairedItem": {"item": 1, "input": 0}})
        failed = grpc_server.execute_response_to_proto(PLUGIN.execute(_request("test-plugin.failing", [{}])))
        self.assertEqual((failed.error.message, failed.error.item_index), ("boom", -1))


if __name__ == "__main__":
    unittest.main()
