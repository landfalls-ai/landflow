"""Transport readiness: the idempotent flags, the MCP tool mapping and the MCP face (in-process, needs the ``mcp`` extra for the last)."""

from __future__ import annotations

import json
import os
import sys
import unittest
import urllib.request
from pathlib import Path
from unittest import mock

PLUGIN_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PLUGIN_DIR))
try:
    import landflow_sdk  # noqa: F401
except ImportError:  # not installed: use the SDK from this checkout
    sys.path.insert(0, str(PLUGIN_DIR.parents[1] / "sdks" / "python"))

from insights import build_plugin  # noqa: E402

from landflow_sdk import PluginServer  # noqa: E402
from landflow_sdk.mcp import mcp_available  # noqa: E402
from landflow_sdk.mcp_tools import mcp_tools_from_manifest  # noqa: E402
from landflow_sdk.telemetry import Telemetry  # noqa: E402
from landflow_sdk.transport.server import idempotency_from_manifest  # noqa: E402

NODES = {"stats", "sentiment", "keywords"}
TOOLS = {"sentiment", "keywords"}  # stats works on a whole item list and is not usableAsTool, so it is not an MCP tool
CLEAN_ENV = {"LANDFLOW_HTTP_PORT": "", "LANDFLOW_GRPC_PORT": "off", "LANDFLOW_TRANSPORTS": "", "LANDFLOW_MAX_CONCURRENCY": "", "LANDFLOW_REGISTRY_URL": "off",
             "LANDFLOW_ADVERTISE_HOST": "", "LANDFLOW_BIND_HOST": "", "LANDFLOW_MCP": "", "LANDFLOW_MCP_TOKEN": "", "LANDFLOW_MCP_CREDENTIALS": ""}


def make_plugin():
    return build_plugin()


class IdempotentTests(unittest.TestCase):
    def test_every_node_is_a_pure_computation(self):
        manifest = make_plugin().manifest()
        self.assertEqual({n["name"] for n in manifest["nodes"]}, NODES)
        for node in manifest["nodes"]:
            self.assertIs(node.get("idempotent"), True, node["name"])

    def test_broker_server_reads_the_flags(self):
        manifest = make_plugin().manifest()
        is_idempotent = idempotency_from_manifest(manifest)
        for name in NODES:
            request = {"node": {"id": "n1", "name": name, "type": f"py-insights.{name}", "typeVersion": 1}, "parameters": {}}
            self.assertTrue(is_idempotent(request), name)

    def test_tools_are_marked_idempotent(self):
        tools = mcp_tools_from_manifest(make_plugin().manifest())
        self.assertEqual({t["name"] for t in tools}, TOOLS)
        for tool in tools:
            self.assertTrue(tool["annotations"]["idempotentHint"], tool["name"])


@unittest.skipUnless(mcp_available(), "the mcp extra is not installed (pip install 'landflow-sdk[mcp]')")
class McpFaceTests(unittest.TestCase):
    def test_face_lists_the_tools_on_loopback_without_a_token(self):
        plugin = make_plugin()
        plugin.telemetry = Telemetry("py-insights", "test", env={}, use_otel=False)
        with mock.patch.dict(os.environ, CLEAN_ENV):
            server = PluginServer(plugin, http_port=0, announce=False)
            server.start()
        try:
            self.assertIn("mcp", server.transports)
            body = {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {"_meta": {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {},
                "io.modelcontextprotocol/clientInfo": {"name": "t", "version": "0"}}}}
            req = urllib.request.Request(
                f"http://127.0.0.1:{server.http_port}/mcp", data=json.dumps(body).encode(), method="POST",
                headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream",
                         "Mcp-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/list"})
            with urllib.request.urlopen(req, timeout=5) as resp:
                text = resp.read().decode()
            if text.startswith(("event:", "data:")):
                text = next(line[5:] for line in text.splitlines() if line.startswith("data:"))
            tools = json.loads(text)["result"]["tools"]
            self.assertEqual({t["name"] for t in tools}, TOOLS)
            self.assertTrue(all(t["annotations"]["idempotentHint"] for t in tools))
        finally:
            server.stop()


if __name__ == "__main__":
    unittest.main()
