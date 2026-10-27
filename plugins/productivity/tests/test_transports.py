"""Transport readiness: which operations are `idempotent` (safe to deliver twice over a broker), the MCP tool mapping and the MCP face."""

from __future__ import annotations

import json
import os
import unittest
import urllib.request
from unittest import mock

from _support import make_plugin

from landflow_sdk import PluginServer
from landflow_sdk.mcp import mcp_available
from landflow_sdk.mcp_tools import mcp_tools_from_manifest
from landflow_sdk.transport.server import idempotency_from_manifest

# Reads and lookups opt in; every create, update, upsert, delete, archive, transition and comment stays at most once.
IDEMPOTENT = {
    ("notion", "page", "get"), ("notion", "page", "search"), ("notion", "databasePage", "getAll"),
    ("airtable", "record", "get"), ("airtable", "record", "search"),
    ("github", "file", "get"), ("github", "release", "getAll"), ("github", "repository", "get"), ("github", "issue", "get"), ("github", "issue", "getAll"),
    ("jira", "issue", "get"), ("jira", "issue", "getAll"),
    ("hubspot", "contact", "get"), ("hubspot", "contact", "search"),
    ("airtable", "attachment", "download"), ("github", "file", "download"), ("github", "release", "downloadAsset"),
    ("github", "repository", "downloadArchive"), ("jira", "issueAttachment", "get"), ("jira", "issueAttachment", "getAll"), ("hubspot", "file", "get"),
}
CLEAN_ENV = {"LANDFLOW_HTTP_PORT": "", "LANDFLOW_GRPC_PORT": "off", "LANDFLOW_TRANSPORTS": "", "LANDFLOW_MAX_CONCURRENCY": "", "LANDFLOW_REGISTRY_URL": "off",
             "LANDFLOW_ADVERTISE_HOST": "", "LANDFLOW_BIND_HOST": "", "LANDFLOW_MCP": "", "LANDFLOW_MCP_TOKEN": "", "LANDFLOW_MCP_CREDENTIALS": ""}


def operations(node: dict) -> list[tuple[str, str, bool | None]]:
    """(resource, operation, the option's own `idempotent`) for every operation of an action node."""
    out = []
    for prop in node["properties"]:
        if prop["name"] != "operation":
            continue
        for resource in prop["displayOptions"]["show"]["resource"]:
            out.extend((resource, o["value"], o.get("idempotent")) for o in prop["options"])
    return out


class IdempotentTests(unittest.TestCase):
    def setUp(self):
        self.manifest = make_plugin().manifest()
        self.nodes = {n["name"]: n for n in self.manifest["nodes"]}

    def test_operations(self):
        seen = set()
        for name in ("notion", "airtable", "github", "jira", "hubspot"):
            node = self.nodes[name]
            self.assertIs(node["idempotent"], False, name)
            for resource, operation, flag in operations(node):
                with self.subTest(f"{name}.{resource}.{operation}"):
                    if (name, resource, operation) in IDEMPOTENT:
                        self.assertIs(flag, True)
                        seen.add((name, resource, operation))
                    else:
                        self.assertIsNone(flag)
        self.assertEqual(seen, IDEMPOTENT)

    def test_rss_read_and_triggers(self):
        self.assertIs(self.nodes["rssFeedRead"]["idempotent"], True)
        for name in ("githubTrigger", "githubWebhookTrigger", "rssFeedReadTrigger"):  # hold poll state or webhooks: at most once
            self.assertFalse(self.nodes[name].get("idempotent", False), name)

    def test_server_side_decision(self):
        check = idempotency_from_manifest(self.manifest)
        node = lambda name, op=None: {"node": {"id": "n", "name": name, "type": f"productivity.{name}", "typeVersion": 1}, "parameters": {"operation": op}}  # noqa: E731
        self.assertTrue(check(node("github", "getAll")))
        self.assertFalse(check(node("github", "create")))
        self.assertFalse(check(node("jira", "transition")))
        self.assertFalse(check(node("airtable", "upsert")))
        self.assertTrue(check(node("rssFeedRead")))

    def test_tool_hints(self):
        tools = {t["name"]: t["annotations"] for t in mcp_tools_from_manifest(self.manifest)}
        self.assertTrue(tools["github_issue_get"]["idempotentHint"])
        self.assertTrue(tools["github_issue_getAll"]["idempotentHint"])
        self.assertFalse(tools["github_issue_create"]["idempotentHint"])
        self.assertFalse(tools["notion_page_archive"]["idempotentHint"])
        self.assertTrue(tools["rssFeedRead"]["idempotentHint"])


@unittest.skipUnless(mcp_available(), "the mcp extra is not installed (pip install 'landflow-sdk[mcp]')")
class McpFaceTests(unittest.TestCase):
    def test_face_lists_the_tools_on_loopback_without_a_token(self):
        plugin = make_plugin()
        expected = {t["name"] for t in mcp_tools_from_manifest(plugin.manifest())}
        self.assertIn("github_issue_create", expected)
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
            names = {t["name"] for t in tools}
            self.assertTrue(expected <= names, sorted(expected - names))
        finally:
            server.stop()


if __name__ == "__main__":
    unittest.main()
