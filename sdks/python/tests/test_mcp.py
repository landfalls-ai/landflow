"""The MCP face (landflow_sdk.mcp): mode and token helpers without the ``mcp`` extra; with it, the face over
``PluginServer`` for both protocol eras at /mcp, credentials and ``list_options``, and ``--mcp-stdio`` as a process."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _support import LogCapture, builtin_telemetry  # noqa: E402
from conformance_plugin import build_plugin, hooks  # noqa: E402

from landflow_sdk import Node, Plugin, PluginServer  # noqa: E402
from landflow_sdk.mcp import (  # noqa: E402
    LIST_OPTIONS_TOOL,
    bearer_token_matches,
    is_loopback_host,
    load_mcp_credentials,
    mcp_available,
    mcp_mode,
)

CLEAN_ENV = {"LANDFLOW_HTTP_PORT": "", "LANDFLOW_GRPC_PORT": "", "LANDFLOW_TRANSPORTS": "", "LANDFLOW_MAX_CONCURRENCY": "", "LANDFLOW_REGISTRY_URL": "off",
             "LANDFLOW_ADVERTISE_HOST": "", "LANDFLOW_BIND_HOST": "", "LANDFLOW_MCP": "", "LANDFLOW_MCP_TOKEN": "", "LANDFLOW_MCP_CREDENTIALS": ""}
META = {"io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": {"name": "t", "version": "0"}}


def mcp_request(url: str, method: str, params: dict, *, version: str = "2026-07-28", token: str | None = None, name: str | None = None, timeout: float = 5) -> tuple[int, dict]:
    """One JSON-RPC request; 2026-07-28 with the envelope and headers, else the 2025 wire (SSE or JSON reply)."""
    full = dict(params)
    headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream", "Mcp-Protocol-Version": version}
    if version == "2026-07-28":
        full["_meta"] = META
        headers["Mcp-Method"] = method
        if name:
            headers["Mcp-Name"] = name
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": full}).encode(), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            status, text = resp.status, resp.read().decode()
    except urllib.error.HTTPError as exc:
        status, text = exc.code, exc.read().decode()
    if text.startswith("event:") or text.startswith("data:"):
        text = next(line[5:] for line in text.splitlines() if line.startswith("data:"))
    return status, (json.loads(text) if text.strip() else {})


class HelpersTest(unittest.TestCase):
    def test_mode(self) -> None:
        self.assertEqual(mcp_mode(None, {}, ["--mcp-stdio"]), "stdio")
        self.assertEqual(mcp_mode(None, {"LANDFLOW_MCP": "off"}, []), "off")
        self.assertEqual(mcp_mode(None, {"LANDFLOW_MCP": "on"}, []), "http")
        self.assertEqual(mcp_mode(False, {"LANDFLOW_MCP": "on"}, []), "off")  # on only means not off, as in TypeScript
        self.assertEqual(mcp_mode(False, {"LANDFLOW_MCP": "stdio"}, []), "stdio")
        self.assertEqual(mcp_mode({"stdio": True}, {}, []), "stdio")
        with self.assertRaises(ValueError):
            mcp_mode(None, {"LANDFLOW_MCP": "maybe"}, [])

    def test_loopback_credentials_token(self) -> None:
        for host, want in {"127.0.0.1": True, "localhost": True, "::1": True, "[::1]": True, "127.1.2.3": True, "0.0.0.0": False, "": False, "10.0.0.1": False}.items():
            self.assertEqual(is_loopback_host(host), want, host)
        self.assertEqual(load_mcp_credentials('{"plugin.fooApi": {"token": "t"}}'), {"fooApi": {"token": "t"}})
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            f.write('{"barApi": {"k": 1}}')
        self.assertEqual(load_mcp_credentials(f.name), {"barApi": {"k": 1}})
        os.unlink(f.name)
        with self.assertRaises(ValueError):
            load_mcp_credentials("[1]")
        self.assertEqual(load_mcp_credentials(""), {})
        self.assertTrue(bearer_token_matches("Bearer abc", "abc"))
        self.assertFalse(bearer_token_matches("Bearer abd", "abc"))
        self.assertFalse(bearer_token_matches(None, "abc"))
        self.assertFalse(bearer_token_matches("Bearer ", ""))

    def test_face_off_without_the_extra_or_token(self) -> None:
        plugin = build_plugin()
        plugin.telemetry = builtin_telemetry("landflow-conformance")
        with mock.patch.dict(os.environ, {**CLEAN_ENV, "LANDFLOW_BIND_HOST": "0.0.0.0", "LANDFLOW_ADVERTISE_HOST": "127.0.0.1"}), LogCapture() as logs:
            server = PluginServer(plugin, http=0, announce=False)
            server.start()
            try:
                self.assertEqual(server.transports, ["http"])
                self.assertEqual(server.plugin.well_known()["endpoints"].get("mcp"), None)
            finally:
                server.stop()
        errors = [line["msg"] for line in logs.lines if line.get("level") == "error"]
        self.assertEqual(len(errors), 1, errors)
        self.assertTrue(errors[0].startswith("MCP face not started: "), errors[0])


@unittest.skipUnless(mcp_available(), "the mcp extra is not installed")
class FaceTest(unittest.TestCase):
    def serve(self, **env: str) -> tuple[PluginServer, str]:
        plugin = build_plugin()
        plugin.telemetry = builtin_telemetry("landflow-conformance")
        with mock.patch.dict(os.environ, {**CLEAN_ENV, **env}):
            server = PluginServer(plugin, http=0, announce=False, max_concurrency=4)
            server.start()
        self.addCleanup(server.stop)
        hooks.reset()
        return server, f"http://127.0.0.1:{server.http_port}/mcp"

    def test_both_eras_over_http(self) -> None:
        server, url = self.serve()
        self.assertEqual(server.transports, ["http", "mcp"])
        self.assertEqual(server.plugin.well_known()["endpoints"]["mcp"], "/mcp")
        # 2026-07-28: no handshake, JSON in, JSON out with resultType.
        status, discover = mcp_request(url, "server/discover", {})
        self.assertEqual(status, 200, discover)
        self.assertIn("2026-07-28", discover["result"]["supportedVersions"])
        status, listed = mcp_request(url, "tools/list", {})
        self.assertEqual(status, 200, listed)
        self.assertEqual(listed["result"]["resultType"], "complete")
        self.assertEqual([t["name"] for t in listed["result"]["tools"]], ["echo", "sleep", "fail", "payload", "counter"])
        self.assertNotIn("_meta", listed["result"]["tools"][0])
        status, call = mcp_request(url, "tools/call", {"name": "echo", "arguments": {"message": "hi", "extra": 1}}, name="echo")
        self.assertEqual(status, 200, call)
        self.assertEqual(call["result"]["structuredContent"], {"items": [{"message": "hi", "extra": 1, "echo": "hi"}]})
        self.assertIn("passed only as input item fields: extra", call["result"]["content"][0]["text"])
        self.assertFalse(call["result"].get("isError"))
        status, failed = mcp_request(url, "tools/call", {"name": "fail", "arguments": {"message": "boom"}}, name="fail")
        self.assertTrue(failed["result"]["isError"])
        self.assertEqual(failed["result"]["content"][0]["text"], "boom")
        status, unknown = mcp_request(url, "tools/call", {"name": "nope"}, name="nope")
        self.assertEqual(unknown["error"]["code"], -32602, unknown)
        self.assertIn("Unknown tool", unknown["error"]["message"])
        # 2025-11-25: initialize, then tools/list, each stateless.
        status, init = mcp_request(url, "initialize", {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "x", "version": "0"}}, version="2025-11-25")
        self.assertEqual(init["result"]["protocolVersion"], "2025-11-25", init)
        status, legacy = mcp_request(url, "tools/list", {}, version="2025-11-25")
        self.assertEqual([t["name"] for t in legacy["result"]["tools"]], ["echo", "sleep", "fail", "payload", "counter"])
        status, legacy_call = mcp_request(url, "tools/call", {"name": "counter", "arguments": {"key": "k"}}, version="2025-11-25")
        self.assertEqual(legacy_call["result"]["structuredContent"]["items"][0]["count"], 1)
        self.assertEqual(hooks.by_node, {"echo": 1, "fail": 1, "counter": 1})

    def test_token_off_loopback(self) -> None:
        server, url = self.serve(LANDFLOW_BIND_HOST="0.0.0.0", LANDFLOW_ADVERTISE_HOST="127.0.0.1", LANDFLOW_MCP_TOKEN="tok")
        self.assertEqual(server.transports, ["http", "mcp"])
        status, _ = mcp_request(url, "tools/list", {})
        self.assertEqual(status, 401)
        status, _ = mcp_request(url, "tools/list", {}, token="wrong")
        self.assertEqual(status, 401)
        status, listed = mcp_request(url, "tools/list", {}, token="tok")
        self.assertEqual(status, 200, listed)

    def test_off(self) -> None:
        server, url = self.serve(LANDFLOW_MCP="off")
        self.assertEqual(server.transports, ["http"])
        status, _ = mcp_request(url, "tools/list", {})
        self.assertEqual(status, 404)

    def test_credentials_and_list_options(self) -> None:
        class Needy(Node):
            description = {
                "name": "needy", "displayName": "Needy", "description": "", "version": 1, "kind": "action", "usableAsTool": True,
                "inputs": [{"type": "main"}], "outputs": [{"type": "main"}],
                "credentials": [{"name": "pApi", "required": True, "displayOptions": {"show": {"authentication": ["token"]}}}],
                "properties": [
                    {"name": "authentication", "displayName": "Auth", "type": "options", "default": "token", "options": [{"name": "Token", "value": "token"}]},
                    {"name": "channel", "displayName": "Channel", "type": "options", "default": "", "typeOptions": {"loadOptionsMethod": "channels"}},
                ],
            }

            def execute(self, ctx):
                return [{"json": {"auth": ctx.get_node_parameter("authentication", 0), "token": ctx.get_credentials("pApi")["token"], "channel": ctx.get_node_parameter("channel", 0, "")}}]

            def load_options(self, method, ctx):
                return [{"name": "A", "value": "a"}]

        def serve(creds: str) -> str:
            plugin = Plugin("p", "P", "1.0.0", nodes=[Needy], credential_types=[{"name": "pApi", "displayName": "P", "properties": [{"name": "token", "displayName": "T", "type": "string"}]}], telemetry=builtin_telemetry("p"))
            with mock.patch.dict(os.environ, {**CLEAN_ENV, "LANDFLOW_MCP_CREDENTIALS": creds}):
                server = PluginServer(plugin, http=0, announce=False)
                server.start()
            self.addCleanup(server.stop)
            return f"http://127.0.0.1:{server.http_port}/mcp"

        url = serve("")
        _, listed = mcp_request(url, "tools/list", {})
        self.assertEqual([t["name"] for t in listed["result"]["tools"]], ["needy"])
        _, call = mcp_request(url, "tools/call", {"name": "needy"}, name="needy")
        self.assertTrue(call["result"]["isError"])
        self.assertIn("pApi (fields: token)", call["result"]["content"][0]["text"])

        url = serve('{"pApi": {"token": "secret"}}')
        _, listed = mcp_request(url, "tools/list", {})
        self.assertEqual([t["name"] for t in listed["result"]["tools"]], ["needy", LIST_OPTIONS_TOOL])
        _, call = mcp_request(url, "tools/call", {"name": "needy", "arguments": {"channel": "c"}}, name="needy")
        self.assertEqual(call["result"]["structuredContent"], {"items": [{"auth": "token", "token": "secret", "channel": "c"}]}, call)
        _, options = mcp_request(url, "tools/call", {"name": LIST_OPTIONS_TOOL, "arguments": {"tool": "needy", "parameter": "channel"}}, name=LIST_OPTIONS_TOOL)
        self.assertEqual(options["result"]["structuredContent"], {"options": [{"name": "A", "value": "a"}]}, options)
        _, bad = mcp_request(url, "tools/call", {"name": LIST_OPTIONS_TOOL, "arguments": {"tool": "needy", "parameter": "nope"}}, name=LIST_OPTIONS_TOOL)
        self.assertEqual(bad["error"]["code"], -32602)

    def test_stdio_process(self) -> None:
        script = Path(__file__).with_name("mcp_stdio_plugin.py")
        proc = subprocess.Popen([sys.executable, str(script), "--mcp-stdio"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env={**os.environ, **CLEAN_ENV, "LANDFLOW_LOG_FORMAT": "json"}, text=True)
        self.addCleanup(proc.kill)

        def ask(message: dict) -> dict:
            assert proc.stdin is not None and proc.stdout is not None
            proc.stdin.write(json.dumps(message) + "\n")
            proc.stdin.flush()
            while True:
                line = proc.stdout.readline()
                if not line:
                    self.fail(f"the plugin closed stdout; stderr: {proc.stderr.read() if proc.stderr else ''}")
                reply = json.loads(line)
                if reply.get("id") is not None:
                    return reply

        discover = ask({"jsonrpc": "2.0", "id": 1, "method": "server/discover", "params": {"_meta": META}})
        self.assertIn("2026-07-28", discover["result"]["supportedVersions"], discover)
        listed = ask({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {"_meta": META}})
        self.assertEqual(len(listed["result"]["tools"]), 5, listed)
        call = ask({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "echo", "arguments": {"message": "hi"}, "_meta": META}})
        self.assertEqual(call["result"]["structuredContent"]["items"][0]["echo"], "hi", call)
        proc.stdin.close()
        proc.wait(timeout=10)
        stderr = proc.stderr.read() if proc.stderr else ""
        self.assertIn("speaking MCP on stdio", stderr)


if __name__ == "__main__":
    unittest.main()
