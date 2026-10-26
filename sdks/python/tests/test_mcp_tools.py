"""The MCP tool mapping against the shared conformance fixture (packages/protocol/conformance/fixtures/mcp-tools.json)."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from landflow_sdk.mcp_tools import (  # noqa: E402
    gateway_target_name,
    gateway_tool_name,
    mcp_tools_from_manifest,
    sanitize_tool_name,
    tool_call_to_parameters,
    without_binding,
)

CONFORMANCE = Path(__file__).resolve().parents[3] / "packages" / "protocol" / "conformance"


@unittest.skipUnless((CONFORMANCE / "fixtures" / "mcp-tools.json").exists(), "conformance kit not found")
class McpToolsFixtureTest(unittest.TestCase):
    def test_every_manifest_maps_exactly(self) -> None:
        fixture = json.loads((CONFORMANCE / "fixtures" / "mcp-tools.json").read_text())
        self.assertGreaterEqual(len(fixture["cases"]), 4)
        for case in fixture["cases"]:
            with self.subTest(case["id"]):
                got = json.loads(json.dumps(mcp_tools_from_manifest(case["manifest"])))
                self.assertEqual(len(got), len(case["tools"]))
                for i, (tool, expected) in enumerate(zip(got, case["tools"])):
                    self.assertEqual(tool, expected, f"tool {i} ({expected['name']}) differs")


class McpToolsHelpersTest(unittest.TestCase):
    def test_names(self) -> None:
        self.assertEqual(sanitize_tool_name("a.b"), "a_b")
        self.assertEqual(sanitize_tool_name("__x__"), "x")
        self.assertEqual(sanitize_tool_name(""), "tool")
        self.assertEqual(sanitize_tool_name("hello world!!"), "hello_world")
        self.assertEqual(len(sanitize_tool_name("a" * 70 + "_b")), 64)
        self.assertEqual(gateway_tool_name("twilio", "message_send"), "twilio_message_send")
        self.assertEqual(gateway_target_name("text-toolkit"), "text-toolkit")
        self.assertEqual(gateway_target_name("My_Plugin"), "my-plugin-0ade9a")  # the same FNV-1a as mcp-tools.ts

    def test_reverse_mapping(self) -> None:
        manifest = {
            "protocol": "landflow.plugin/v1",
            "plugin": {"id": "p", "name": "P", "version": "1"},
            "nodes": [{
                "name": "n", "displayName": "N", "description": "", "version": 1, "kind": "action", "usableAsTool": True,
                "inputs": [{"type": "main"}], "outputs": [{"type": "main"}],
                "properties": [
                    {"name": "operation", "displayName": "Op", "type": "options", "default": "get", "options": [{"name": "Get", "value": "get"}]},
                    {"name": "id", "displayName": "ID", "type": "string", "default": ""},
                ],
            }],
        }
        tools = mcp_tools_from_manifest(manifest)
        self.assertEqual([t["name"] for t in tools], ["n_get"])
        mapping = tool_call_to_parameters(tools[0], {"id": "7", "bogus": True, "operation": "delete"})
        self.assertEqual(mapping, {"nodeType": "p.n", "typeVersion": 1, "parameters": {"operation": "get", "id": "7"}, "ignored": ["bogus", "operation"]})
        self.assertNotIn("_meta", without_binding(tools[0]))


if __name__ == "__main__":
    unittest.main()
