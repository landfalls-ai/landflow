"""The protocol conformance kit (packages/protocol/conformance) run against every face of the Python SDK: HTTP, gRPC
(with the ``grpc`` extra) and MCP (the 2026-07-28 wire at /mcp, with the ``mcp`` extra). One runner per face knows how
to send a case over its binding and maps its own signals onto the kit's outcome and error codes (README "Transport
error codes"); the assertions are shared. The mirror of packages/sdk/test/conformance.test.ts and sdks/go/conformance_test.go;
messaging reaches a Python plugin through landflow-bridge, so it has no runner here.

Runner defaults: a 3 s deadline when a case gives none.
"""

from __future__ import annotations

import json
import os
import socket
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _support import builtin_telemetry  # noqa: E402
from conformance_plugin import MANIFEST, PLUGIN_ID, build_plugin, hooks  # noqa: E402

from landflow_sdk import PluginServer  # noqa: E402
from landflow_sdk.http_server import DEADLINE_HEADER  # noqa: E402
from landflow_sdk.mcp import mcp_available  # noqa: E402
from landflow_sdk.protocol import HTTP_PATHS  # noqa: E402

try:
    import grpc

    from landflow_sdk import grpc_server
    from landflow_sdk._pb import plugin_pb2 as pb
    from landflow_sdk._pb import plugin_pb2_grpc as pb_grpc
except Exception:  # noqa: BLE001 - grpc extra not installed
    grpc = None

CONFORMANCE = Path(__file__).resolve().parents[3] / "packages" / "protocol" / "conformance"
# Stream T3-D's port range: 7460–7479 (7462/7463 TypeScript, 7464/7465 Go).
HTTP_PORT, GRPC_PORT = 7466, 7467
MCP_TOKEN = "conformance-token"
DEFAULT_DEADLINE_MS = 3000
CLEAN_ENV = {"LANDFLOW_HTTP_PORT": "", "LANDFLOW_GRPC_PORT": "", "LANDFLOW_TRANSPORTS": "", "LANDFLOW_MAX_CONCURRENCY": "", "LANDFLOW_REGISTRY_URL": "off",
             "LANDFLOW_ADVERTISE_HOST": "", "LANDFLOW_BIND_HOST": "", "LANDFLOW_MCP": "", "LANDFLOW_MCP_TOKEN": MCP_TOKEN, "LANDFLOW_MCP_CREDENTIALS": ""}
META = {"io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": {"name": "conformance-runner", "version": "1"}}


def load_suites(face: str) -> list[dict[str, Any]]:
    suites = []
    for path in sorted((CONFORMANCE / "fixtures").glob("*.json")):
        if path.name == "mcp-tools.json":
            continue
        suite = json.loads(path.read_text())
        if suite.get("kit") != "landflow.conformance/v1" or (suite.get("applies") and face not in suite["applies"]):
            continue
        suite["cases"] = [c for c in suite["cases"] if not c.get("applies") or face in c["applies"]]
        suites.append(suite)
    return suites


class Timers:
    """The deadline (client-side ``expired``) and ``cancelAfterMs`` (``cancelled``) of one call."""

    def __init__(self, call: dict[str, Any]) -> None:
        deadline_ms = call.get("deadlineMs", DEFAULT_DEADLINE_MS)
        self.deadline_ms = deadline_ms
        self.deadline_epoch_ms = int(time.time() * 1000) + deadline_ms  # whole ms, like the x-landflow-deadline header
        self.deadline = time.monotonic() + deadline_ms / 1000.0
        self.expired = deadline_ms <= 0
        self.cancelled = False
        self.aborted = threading.Event()
        self._timers: list[threading.Timer] = []
        if not self.expired:
            self._timers.append(threading.Timer(deadline_ms / 1000.0, self._expire))
        if call.get("cancelAfterMs") is not None:
            # A cancel "at 0 ms" still lands after the call was sent (TypeScript's setTimeout(0) does the same).
            self._timers.append(threading.Timer(max(call["cancelAfterMs"], 10) / 1000.0, self._cancel))
        for t in self._timers:
            t.daemon = True
            t.start()

    def _expire(self) -> None:
        self.expired = True
        self.aborted.set()

    def _cancel(self) -> None:
        self.cancelled = True
        self.aborted.set()

    def why(self) -> str | None:
        return "expired" if self.expired else "cancelled" if self.cancelled else None

    def is_late(self) -> bool:
        return time.monotonic() >= self.deadline

    def clear(self) -> None:
        for t in self._timers:
            t.cancel()


def execute_request(call: dict[str, Any]) -> dict[str, Any]:
    params = dict(call.get("parameters") or {})
    if call.get("padBytes"):
        params["message"] = str(params.get("message", "")).ljust(call["padBytes"], "x")
    items = call["items"] if call.get("items") is not None else [{"json": {}}]
    descriptor = next((n for n in MANIFEST["nodes"] if n["name"] == call["node"]), None)
    version = (max(descriptor["version"]) if isinstance(descriptor["version"], list) else descriptor["version"]) if descriptor else 1
    request: dict[str, Any] = {
        "protocol": "landflow.plugin/v1", "executionId": f"ex_{call['node']}", "mode": "manual",
        "node": {"id": f"n-{call['node']}", "name": descriptor["displayName"] if descriptor else call["node"], "type": f"{PLUGIN_ID}.{call['node']}", "typeVersion": version},
        "parameters": params, "itemParameters": [{} for _ in items], "inputs": [items],
    }
    if call.get("idempotencyKey"):
        request["idempotencyKey"] = call["idempotencyKey"]
    if call.get("credentials"):
        request["credentials"] = call["credentials"]
    return request


def outcome_of(response: dict[str, Any], elapsed_ms: float) -> dict[str, Any]:
    if response.get("error"):
        return {"outcome": "node-error", "response": response, "errorMessage": response["error"].get("message", ""), "elapsedMs": elapsed_ms}
    return {"outcome": "reply", "response": response, "elapsedMs": elapsed_ms}


def transport_error(code: str, message: str = "", elapsed_ms: float = 0) -> dict[str, Any]:
    return {"outcome": "transport-error", "code": code, "errorMessage": message, "elapsedMs": elapsed_ms}


def repeated(case: dict[str, Any], once: Callable[[], dict[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for _ in range(case["call"].get("repeat") or 1):
        out = once()
    return out


# --------------------------------------------------------------------------- HTTP

HTTP_STATUS_CODES = {400: "bad_request", 404: "not_found", 413: "too_large", 429: "unavailable", 499: "cancelled", 500: "internal", 503: "unavailable", 504: "expired"}


class HttpRunner:
    face = "http"

    def __init__(self, port: int) -> None:
        self.base = f"http://127.0.0.1:{port}"

    def post(self, path: str, body: Any, call: dict[str, Any]) -> dict[str, Any]:
        """One POST on a raw socket, so the runner can close the connection on cancel (what an aborted fetch does)."""
        timers = Timers(call)
        started = time.monotonic()
        if timers.why() == "expired":
            timers.clear()
            return transport_error("expired")
        data = json.dumps(body).encode()
        sock = socket.create_connection(("127.0.0.1", int(self.base.rsplit(":", 1)[1])), timeout=max(timers.deadline_ms / 1000.0 + 1, 1))
        try:
            sock.sendall((f"POST {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n{DEADLINE_HEADER}: {timers.deadline_epoch_ms}\r\n"
                          f"Content-Length: {len(data)}\r\nConnection: close\r\n\r\n").encode() + data)
            chunks: list[bytes] = []
            while True:
                sock.settimeout(0.05)
                try:
                    chunk = sock.recv(65536)
                except socket.timeout:
                    if timers.aborted.is_set():
                        sock.close()
                        return transport_error(timers.why() or "cancelled", "", (time.monotonic() - started) * 1000)
                    continue
                if not chunk:
                    break
                chunks.append(chunk)
                if b"\r\n\r\n" in b"".join(chunks):
                    head, _, rest = b"".join(chunks).partition(b"\r\n\r\n")
                    length = next((int(line.split(b":", 1)[1]) for line in head.split(b"\r\n") if line.lower().startswith(b"content-length:")), None)
                    if length is not None and len(rest) >= length:
                        break
        finally:
            timers.clear()
            sock.close()
        elapsed_ms = (time.monotonic() - started) * 1000
        raw = b"".join(chunks)
        head, _, rest = raw.partition(b"\r\n\r\n")
        status = int(head.split(b" ", 2)[1])
        if timers.why() and status != 200:
            return transport_error(timers.why() or "", "", elapsed_ms)
        if timers.is_late():  # a reply after the deadline is ignored by the caller
            return transport_error("expired", "", elapsed_ms)
        payload = json.loads(rest.decode() or "{}")
        if status == 200:
            return outcome_of(payload, elapsed_ms)
        return transport_error(HTTP_STATUS_CODES.get(status, f"http_{status}"), (payload.get("error") or {}).get("message", ""), elapsed_ms)

    def run(self, case: dict[str, Any]) -> dict[str, Any]:
        call = case["call"]

        def once() -> dict[str, Any]:
            method = call["method"]
            if method == "execute":
                return self.post(HTTP_PATHS["execute"], execute_request(call), call)
            if method == "health":
                with urllib.request.urlopen(self.base + HTTP_PATHS["health"], timeout=5) as resp:
                    return {"outcome": "reply" if resp.status == 200 else "transport-error", "elapsedMs": 0}
            if method == "testCredentials":
                return self.post(HTTP_PATHS["testCredentials"], call["testCredentials"], call)
            if method == "loadOptions":
                return self.post(HTTP_PATHS["loadOptions"], {"nodeType": f"{PLUGIN_ID}.{call['node']}", "method": call["loadOptions"]["method"], "parameters": {}}, call)
            return {"outcome": "skipped", "reason": f"{method} over HTTP is not part of this runner"}

        return repeated(case, once)


# --------------------------------------------------------------------------- gRPC


class GrpcRunner:
    face = "grpc"

    def __init__(self, port: int) -> None:
        self.channel = grpc.insecure_channel(f"127.0.0.1:{port}")
        self.stub = pb_grpc.PluginServiceStub(self.channel)
        self.codes = {
            grpc.StatusCode.NOT_FOUND: "not_found", grpc.StatusCode.INVALID_ARGUMENT: "bad_request", grpc.StatusCode.DEADLINE_EXCEEDED: "expired",
            grpc.StatusCode.CANCELLED: "cancelled", grpc.StatusCode.RESOURCE_EXHAUSTED: "unavailable", grpc.StatusCode.INTERNAL: "internal",
            grpc.StatusCode.UNAVAILABLE: "no_consumers", grpc.StatusCode.UNAUTHENTICATED: "unauthenticated",
        }

    def close(self) -> None:
        self.channel.close()

    def unary(self, call: dict[str, Any], method: Callable[..., Any], message: Any, decode: Callable[[Any], dict[str, Any] | None]) -> dict[str, Any]:
        timers = Timers(call)
        if timers.why() == "expired":
            timers.clear()
            return transport_error("expired")
        started = time.monotonic()
        future = method.future(message, timeout=max(timers.deadline - time.monotonic(), 0.001))
        if call.get("cancelAfterMs") is not None:
            threading.Timer(max(call["cancelAfterMs"], 10) / 1000.0, future.cancel).start()
        try:
            msg = future.result()
        except grpc.FutureCancelledError:
            timers.clear()
            return transport_error("cancelled", "", (time.monotonic() - started) * 1000)
        except grpc.RpcError as exc:
            timers.clear()
            why = timers.why() or self.codes.get(exc.code(), f"grpc_{exc.code().name}")
            return transport_error(why, exc.details() or "", (time.monotonic() - started) * 1000)
        timers.clear()
        elapsed_ms = (time.monotonic() - started) * 1000
        if timers.is_late():  # a reply after the deadline is ignored by the caller
            return transport_error("expired", "", elapsed_ms)
        response = decode(msg)
        return outcome_of(response, elapsed_ms) if response is not None else {"outcome": "reply", "elapsedMs": elapsed_ms}

    def run(self, case: dict[str, Any]) -> dict[str, Any]:
        call = case["call"]

        def once() -> dict[str, Any]:
            method = call["method"]
            if method == "execute":
                request = execute_request(call)
                malformed = call.get("items") is not None and any(not isinstance(i.get("json"), dict) for i in call["items"])
                if malformed:
                    request = {**request, "inputs": [[{"json": {}}]]}
                message = grpc_server.execute_request_to_proto(request)
                if malformed:  # send the kit's `"json": "not-an-object"` as the wire would
                    message.inputs[0].items[0].json.CopyFrom(grpc_server.to_dynamic(call["items"][0]["json"]))
                return self.unary(call, self.stub.Execute, message, grpc_server.execute_response_from_proto)
            if method == "health":
                return self.unary(call, self.stub.Health, pb.HealthRequest(), lambda _msg: None)
            if method == "testCredentials":
                tc = call["testCredentials"]
                return self.unary(call, self.stub.TestCredentials, pb.TestCredentialsRequest(credential_type=tc["credentialType"], data=grpc_server.to_dynamic(tc["data"])), lambda _msg: None)
            if method == "loadOptions":
                return self.unary(call, self.stub.LoadOptions, pb.LoadOptionsRequest(node_type=f"{PLUGIN_ID}.{call['node']}", method=call["loadOptions"]["method"], parameters=grpc_server.to_dynamic({})), lambda _msg: None)
            return {"outcome": "skipped", "reason": f"{method} over gRPC is not part of this runner"}

        return repeated(case, once)


# --------------------------------------------------------------------------- MCP (2026-07-28 wire)


class McpRunner:
    face = "mcp"

    def __init__(self, port: int) -> None:
        self.port = port
        self.url = f"http://127.0.0.1:{port}/mcp"

    def request(self, method: str, params: dict[str, Any], timers: Timers, name: str | None = None) -> tuple[int, dict[str, Any]]:
        """One 2026-07-28 JSON-RPC request on a raw socket (closed on cancel: the only cancellation MCP has over HTTP)."""
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": {**params, "_meta": META}}).encode()
        headers = f"POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nAuthorization: Bearer {MCP_TOKEN}\r\nMcp-Protocol-Version: 2026-07-28\r\nMcp-Method: {method}\r\n"
        if name:
            headers += f"Mcp-Name: {name}\r\n"
        sock = socket.create_connection(("127.0.0.1", self.port), timeout=max(timers.deadline_ms / 1000.0 + 1, 1))
        try:
            sock.sendall((headers + f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n").encode() + body)
            chunks: list[bytes] = []
            while True:
                sock.settimeout(0.05)
                try:
                    chunk = sock.recv(65536)
                except socket.timeout:
                    if timers.aborted.is_set():
                        raise ConnectionAbortedError(timers.why()) from None
                    continue
                if not chunk:
                    break
                chunks.append(chunk)
                raw = b"".join(chunks)
                if b"\r\n\r\n" in raw:
                    head, _, rest = raw.partition(b"\r\n\r\n")
                    length = next((int(line.split(b":", 1)[1]) for line in head.split(b"\r\n") if line.lower().startswith(b"content-length:")), None)
                    if length is not None and len(rest) >= length:
                        break
        finally:
            sock.close()
        raw = b"".join(chunks)
        head, _, rest = raw.partition(b"\r\n\r\n")
        status = int(head.split(b" ", 2)[1])
        text = rest.decode()
        if text.startswith("event:") or text.startswith("data:"):
            text = next(line[5:] for line in text.splitlines() if line.startswith("data:"))
        return status, (json.loads(text) if text.strip() else {})

    def run(self, case: dict[str, Any]) -> dict[str, Any]:
        call = case["call"]

        def once() -> dict[str, Any]:
            if call["method"] != "execute":
                return {"outcome": "skipped", "reason": f"MCP has no {call['method']}; tools/call only runs Execute"}
            timers = Timers(call)
            started = time.monotonic()
            try:
                if timers.why() == "expired":
                    return transport_error("expired")
                request = execute_request(call)
                malformed = call.get("items") is not None and any(not isinstance(i.get("json"), dict) for i in call["items"])
                status, body = self.request("tools/call", {"name": call["node"], "arguments": "not-an-object" if malformed else request["parameters"]}, timers, name=call["node"])
                elapsed_ms = (time.monotonic() - started) * 1000
                if timers.is_late():
                    return transport_error("expired", "", elapsed_ms)
                if body.get("error"):
                    code = body["error"]["code"]
                    mapped = ("not_found" if "Unknown tool" in body["error"]["message"] else "bad_request") if code == -32602 else "internal" if code == -32603 else "bad_request"
                    return transport_error(mapped, body["error"]["message"], elapsed_ms)
                result = body.get("result") or {}
                if result.get("isError"):
                    return {"outcome": "node-error", "errorMessage": "\n".join(part.get("text", "") for part in result.get("content", [])), "elapsedMs": elapsed_ms}
                items = [{"json": j} for j in (result.get("structuredContent") or {}).get("items", [])]
                return {"outcome": "reply", "response": {"outputs": [items]}, "elapsedMs": elapsed_ms}
            except (ConnectionAbortedError, OSError):
                why = timers.why()
                if why:
                    return transport_error(why, "", (time.monotonic() - started) * 1000)
                raise
            finally:
                timers.clear()

        return repeated(case, once)


# --------------------------------------------------------------------------- assertions


def is_subset(part: Any, whole: Any) -> bool:
    if part == whole and type(part) is type(whole):
        return True
    if isinstance(part, dict):
        return isinstance(whole, dict) and all(is_subset(v, whole.get(k)) for k, v in part.items())
    if isinstance(part, list):
        return isinstance(whole, list) and len(part) == len(whole) and all(is_subset(p, w) for p, w in zip(part, whole))
    return part == whole


def outputs_match(expected: list[list[dict[str, Any]]] | None, actual: list[list[dict[str, Any]]]) -> bool:
    if expected is None:
        return True
    if len(expected) != len(actual):
        return False
    return all(len(branch) == len(actual[b]) and all(is_subset(item["json"], actual[b][i]["json"]) for i, item in enumerate(branch)) for b, branch in enumerate(expected))


class ConformanceTest(unittest.TestCase):
    server: PluginServer
    runners: list[Any]

    @classmethod
    def setUpClass(cls) -> None:
        if not CONFORMANCE.exists():
            raise unittest.SkipTest("conformance kit not found")
        plugin = build_plugin()
        plugin.telemetry = builtin_telemetry(PLUGIN_ID)
        with mock.patch.dict(os.environ, CLEAN_ENV):
            cls.server = PluginServer(plugin, http=HTTP_PORT, grpc=GRPC_PORT if grpc else None, announce=False, max_concurrency=4)
            cls.server.start()
        cls.runners = [HttpRunner(HTTP_PORT)]
        if grpc is not None and cls.server.grpc_port:
            cls.runners.append(GrpcRunner(cls.server.grpc_port))
        if mcp_available():
            cls.runners.append(McpRunner(HTTP_PORT))

    @classmethod
    def tearDownClass(cls) -> None:
        for runner in cls.runners:
            if hasattr(runner, "close"):
                runner.close()
        cls.server.stop()

    def assert_case(self, runner: Any, case: dict[str, Any], out: dict[str, Any], ran: int) -> None:
        expect = case["expect"]
        outcomes = expect["outcome"] if isinstance(expect["outcome"], list) else [expect["outcome"]]
        cid = case["id"]
        self.assertIn(out["outcome"], outcomes, f"{cid}: outcome {out['outcome']} ({out.get('code', '')} {out.get('errorMessage', '')})")
        if expect.get("code") and out["outcome"] == "transport-error":
            self.assertEqual(out.get("code"), expect["code"], f"{cid}: code ({out.get('errorMessage', '')})")
        if expect.get("outputs") is not None and out.get("response"):
            self.assertTrue(outputs_match(expect["outputs"], out["response"]["outputs"]), f"{cid}: outputs {out['response']['outputs']}")
        if expect.get("errorMessage"):
            self.assertIn(expect["errorMessage"], out.get("errorMessage", ""), f"{cid}: error message")
        if expect.get("ran") is not None:
            self.assertEqual(ran > 0, expect["ran"], f"{cid}: ran {ran} times")
        if expect.get("signalAborted"):
            self.assertTrue(hooks.sleeps and hooks.sleeps[-1]["aborted"], f"{cid}: the sleep did not see its signal")
        if expect.get("withinMs") is not None:
            self.assertLessEqual(out.get("elapsedMs", 0), expect["withinMs"], f"{cid}: within {expect['withinMs']} ms")
        if expect.get("count") is not None and out.get("response"):
            self.assertEqual(out["response"]["outputs"][0][0]["json"].get("count"), expect["count"], f"{cid}: count")

    def test_suites(self) -> None:
        faces = []
        for runner in self.runners:
            faces.append(runner.face)
            for suite in load_suites(runner.face):
                for case in suite["cases"]:
                    with self.subTest(face=runner.face, case=f"{suite['suite']}/{case['id']}"):
                        hooks.reset()
                        out = runner.run(case)
                        if out["outcome"] == "skipped":
                            continue
                        if case["expect"].get("ran") is False or case["expect"].get("signalAborted") or case["id"] == "late-reply-dropped":
                            time.sleep(0.3)
                        ran = hooks.by_node.get(case["call"]["node"], 0) if case["call"].get("node") else hooks.executions
                        self.assert_case(runner, case, out, ran)
        self.assertIn("http", faces)
        if grpc is None:
            print("conformance: gRPC skipped (grpc extra not installed)", file=sys.stderr)
        if not mcp_available():
            print("conformance: MCP skipped (mcp extra not installed)", file=sys.stderr)

    @unittest.skipUnless(mcp_available(), "the mcp extra is not installed")
    def test_mcp_tool_listing_is_the_shared_mapping(self) -> None:
        from landflow_sdk.mcp_tools import mcp_tools_from_manifest, without_binding

        expected = [without_binding(t) for t in mcp_tools_from_manifest(self.server.plugin.manifest())]
        self.assertEqual([t["name"] for t in expected], ["echo", "sleep", "fail", "payload", "counter"])
        status, modern = McpRunner(HTTP_PORT).request("tools/list", {}, Timers({}))
        self.assertEqual(status, 200)
        self.assertEqual(modern["result"]["resultType"], "complete")
        self.assertEqual(json.loads(json.dumps(modern["result"]["tools"])), json.loads(json.dumps(expected)))
        # 2025-11-25: the stateless legacy path (initialize, then tools/list).
        def legacy(method: str, params: dict[str, Any]) -> dict[str, Any]:
            req = urllib.request.Request(f"http://127.0.0.1:{HTTP_PORT}/mcp", data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
                                         headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream", "Authorization": f"Bearer {MCP_TOKEN}", "Mcp-Protocol-Version": "2025-11-25"}, method="POST")
            with urllib.request.urlopen(req, timeout=5) as resp:
                text = resp.read().decode()
            if text.startswith("event:") or text.startswith("data:"):
                text = next(line[5:] for line in text.splitlines() if line.startswith("data:"))
            return json.loads(text)
        self.assertEqual(legacy("initialize", {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "x", "version": "0"}})["result"]["protocolVersion"], "2025-11-25")
        self.assertEqual(json.loads(json.dumps(legacy("tools/list", {})["result"]["tools"])), json.loads(json.dumps(expected)))
        self.assertEqual(self.server.plugin.well_known()["endpoints"]["mcp"], "/mcp")


if __name__ == "__main__":
    unittest.main()
