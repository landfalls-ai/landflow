"""The announcer (docs/protocol.md §1): every announce carries this process's instanceId, over HTTP and gRPC."""

from __future__ import annotations

import json
import re
import subprocess
import sys
import threading
import unittest
from concurrent import futures
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from landflow_sdk import announce  # noqa: E402
from landflow_sdk.announce import INSTANCE_ID, Announcer, HttpRegistryClient  # noqa: E402

try:
    import grpc

    from landflow_sdk._pb import plugin_pb2 as pb
    from landflow_sdk._pb import plugin_pb2_grpc as pb_grpc
    from landflow_sdk.grpc_server import GrpcRegistryClient
except Exception:  # noqa: BLE001 - grpc extra not installed
    grpc = None

SDK_ROOT = Path(__file__).resolve().parents[1]


class FakeRegistry:
    """The host's HTTP registry: records announce (POST) and withdraw (DELETE) bodies."""

    def __init__(self) -> None:
        self.announces: list[dict] = []
        self.withdraws: list[dict] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def _body(self) -> dict:
                return json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")

            def _reply(self) -> None:
                data = json.dumps({"accepted": True, "heartbeatIntervalSeconds": 10}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_POST(self) -> None:  # noqa: N802
                outer.announces.append(self._body())
                self._reply()

            def do_DELETE(self) -> None:  # noqa: N802
                outer.withdraws.append(self._body())
                self._reply()

            def log_message(self, *args: object) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


class InstanceIdTests(unittest.TestCase):
    def setUp(self) -> None:
        self.registry = FakeRegistry()
        self.addCleanup(self.registry.close)

    def test_sent_over_http_for_every_endpoint_and_heartbeat(self):
        self.assertRegex(INSTANCE_ID, r"^[0-9a-f]{32}$")
        endpoints = ["http://127.0.0.1:7999", "grpc://127.0.0.1:7998"]
        announcer = Announcer(HttpRegistryClient(self.registry.url), self.registry.url, "test-plugin", "1.0.0", endpoints)
        self.assertEqual(announcer.announce_once(), "ok")
        self.assertEqual(announcer.announce_once(), "ok")  # a heartbeat
        self.assertEqual([a["endpoint"] for a in self.registry.announces], endpoints * 2)
        self.assertEqual({a["instanceId"] for a in self.registry.announces}, {INSTANCE_ID})
        announcer.stop(withdraw=True)
        # Withdraws don't need it.
        self.assertEqual(len(self.registry.withdraws), 2)
        self.assertTrue(all("instanceId" not in w for w in self.registry.withdraws))

    def test_stable_for_the_process(self):
        # A second announcer (another plugin in the process, or serve() run again) sends the same id.
        other = Announcer(HttpRegistryClient(self.registry.url), self.registry.url, "other", "2.0.0", ["http://127.0.0.1:7997"])
        other.announce_once()
        self.assertEqual(self.registry.announces[-1]["instanceId"], INSTANCE_ID)
        self.assertEqual(announce.INSTANCE_ID, INSTANCE_ID)
        # Another process draws its own.
        code = "from landflow_sdk.announce import INSTANCE_ID; print(INSTANCE_ID)"
        out = subprocess.run([sys.executable, "-c", code], cwd=SDK_ROOT, capture_output=True, text=True, check=True).stdout.strip()
        self.assertTrue(re.fullmatch(r"[0-9a-f]{32}", out), out)
        self.assertNotEqual(out, INSTANCE_ID)


@unittest.skipIf(grpc is None, "grpc extra not installed")
class GrpcInstanceIdTests(unittest.TestCase):
    def test_sent_over_the_grpc_registry(self):
        received: list[tuple[str, str]] = []

        class Registry(pb_grpc.RegistryServiceServicer):
            def Announce(self, request, context):  # noqa: N802
                received.append((request.endpoint, request.instance_id))
                return pb.AnnounceResponse(accepted=True, heartbeat_interval_seconds=10, message="ok")

        server = grpc.server(futures.ThreadPoolExecutor(max_workers=2))
        pb_grpc.add_RegistryServiceServicer_to_server(Registry(), server)
        port = server.add_insecure_port("127.0.0.1:0")
        server.start()
        self.addCleanup(server.stop, 0)
        client = GrpcRegistryClient(f"127.0.0.1:{port}")
        announcer = Announcer(client, f"grpc://127.0.0.1:{port}", "test-plugin", "1.0.0", ["grpc://127.0.0.1:7996"])
        self.assertEqual(announcer.announce_once(), "ok")
        announcer.stop(withdraw=False)
        self.assertEqual(received, [("grpc://127.0.0.1:7996", INSTANCE_ID)])


if __name__ == "__main__":
    unittest.main()
