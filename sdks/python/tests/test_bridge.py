"""``landflow_sdk.bridge``: ``serve()`` starts ``landflow-bridge`` for broker kinds without a native driver, passes the
environment through, restarts it with backoff, stops it on shutdown, and keeps serving when the binary is missing.
A fake bridge (a small Python script) stands in for the Go binary; port 7451 (stream T3-C's range)."""

from __future__ import annotations

import json
import os
import stat
import sys
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from _support import LogCapture  # noqa: E402

from landflow_sdk import Binding, BindingInfo, Node, Plugin, PluginServer  # noqa: E402
from landflow_sdk import bridge as bridge_mod  # noqa: E402
from landflow_sdk.announce import INSTANCE_ID  # noqa: E402

try:
    import grpc  # noqa: F401

    HAVE_GRPC = True
except Exception:  # noqa: BLE001
    HAVE_GRPC = False

FAKE_BRIDGE = """#!{python}
import json, os, signal, sys, time
out = os.environ["FAKE_BRIDGE_OUT"]
with open(out, "a") as f:
    f.write(json.dumps({{k: v for k, v in os.environ.items() if k.startswith("LANDFLOW_")}} | {{"pid": os.getpid()}}) + "\\n")
if os.environ.get("FAKE_BRIDGE_EXIT"):
    sys.exit(int(os.environ["FAKE_BRIDGE_EXIT"]))
signal.signal(signal.SIGTERM, lambda *a: sys.exit(0))
while True:
    time.sleep(0.05)
"""


class Hello(Node):
    description = {
        "name": "hello", "displayName": "Hello", "description": "says hi", "version": 1, "kind": "action",
        "inputs": [{"type": "main"}], "outputs": [{"type": "main"}], "properties": [],
    }

    def execute(self, ctx):
        return [{"json": {"hi": True}}]


class BridgeLaunchTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.out = Path(self.tmp.name) / "runs.jsonl"
        self.fake = Path(self.tmp.name) / "landflow-bridge"
        self.fake.write_text(FAKE_BRIDGE.format(python=sys.executable))
        self.fake.chmod(self.fake.stat().st_mode | stat.S_IEXEC)
        self.env = {
            "LANDFLOW_BRIDGE_BIN": str(self.fake), "FAKE_BRIDGE_OUT": str(self.out), "LANDFLOW_TRANSPORT_SECRET": "s3cret",
            "LANDFLOW_MQTT_URL": "mqtt://127.0.0.1:51883", "LANDFLOW_REGISTRY_URL": "off",
        }
        self.patch = mock.patch.dict(os.environ, self.env, clear=False)
        self.patch.start()
        for key in ("LANDFLOW_TRANSPORTS", "LANDFLOW_BRIDGE", "LANDFLOW_HTTP_PORT", "LANDFLOW_GRPC_PORT"):
            os.environ.pop(key, None)
        self.server: PluginServer | None = None

    def tearDown(self) -> None:
        if self.server is not None:
            self.server.stop()
        self.patch.stop()
        bridge_mod.NATIVE_BROKER_BINDINGS.pop("mqtt", None)
        self.tmp.cleanup()

    def runs(self) -> list[dict]:
        if not self.out.exists():
            return []
        return [json.loads(line) for line in self.out.read_text().splitlines() if line.strip()]

    def wait_runs(self, n: int, timeout: float = 5.0) -> list[dict]:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            runs = self.runs()
            if len(runs) >= n:
                return runs
            time.sleep(0.02)
        self.fail(f"expected {n} bridge run(s), saw {len(self.runs())}")

    def start(self, **kwargs) -> PluginServer:
        self.server = PluginServer(Plugin("tmp-bridge", "Tmp", "1.0.0", nodes=[Hello]), http=7451, grpc=0 if HAVE_GRPC else False, announce=False, **kwargs)
        self.server.start()
        return self.server

    def bridge(self) -> bridge_mod.BridgeBinding:
        assert self.server is not None
        found = [b for b in self.server.bindings if isinstance(b, bridge_mod.BridgeBinding)]
        self.assertEqual(len(found), 1, self.server.bindings)
        return found[0]

    def test_spawns_bridge_for_kind_without_native_driver(self) -> None:
        server = self.start(transports=["http", "grpc", "mqtt"])
        runs = self.wait_runs(1)
        env = runs[0]
        expected_target = f"grpc://127.0.0.1:{server.grpc_port}" if HAVE_GRPC else f"http://127.0.0.1:{server.http_port}"
        self.assertEqual(env["LANDFLOW_BRIDGE_TARGET"], expected_target)
        self.assertEqual(env["LANDFLOW_TRANSPORTS"], "mqtt")
        self.assertEqual(env["LANDFLOW_BRIDGE_INSTANCE_ID"], INSTANCE_ID)
        self.assertEqual(env["LANDFLOW_MCP"], "off")
        self.assertEqual(env["LANDFLOW_MQTT_URL"], "mqtt://127.0.0.1:51883")
        self.assertEqual(env["LANDFLOW_TRANSPORT_SECRET"], "s3cret")
        self.assertEqual(server.plugin.transports, ["http", "grpc", "mqtt"] if HAVE_GRPC else ["http", "mqtt"])
        self.assertNotIn("bridge", server.transports)
        self.assertTrue(self.bridge().alive())
        pid = env["pid"]
        server.stop()
        self.server = None
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                os.kill(pid, 0)
            except OSError:
                break
            time.sleep(0.02)
        else:
            self.fail("the bridge child was not stopped")

    def test_restarts_with_backoff_when_it_dies(self) -> None:
        os.environ["FAKE_BRIDGE_EXIT"] = "3"
        with mock.patch.object(bridge_mod, "_BACKOFF_MIN", 0.1), mock.patch.object(bridge_mod, "_BACKOFF_MAX", 0.2):
            with LogCapture() as logs:
                self.start(transports=["http", "mqtt"])
                runs = self.wait_runs(3)
        self.assertGreaterEqual(len(runs), 3)
        self.assertGreaterEqual(self.bridge().restarts, 2)
        self.assertTrue(any("landflow-bridge exited with status 3" in line["msg"] for line in logs.lines), [l["msg"] for l in logs.lines])

    def test_missing_binary_logs_once_and_keeps_serving(self) -> None:
        os.environ["LANDFLOW_BRIDGE_BIN"] = str(Path(self.tmp.name) / "missing")
        with LogCapture() as logs:
            server = self.start(transports=["http", "mqtt"])
        errors = [line for line in logs.lines if line["level"] == "error" and "no landflow-bridge binary" in line["msg"]]
        self.assertEqual(len(errors), 1, [l["msg"] for l in logs.lines])
        with urllib.request.urlopen(f"http://127.0.0.1:{server.http_port}/landflow/v1/health", timeout=3) as resp:
            self.assertEqual(resp.status, 200)
        self.assertFalse(self.bridge().alive())
        self.assertEqual(self.runs(), [])

    def test_bridge_off_disables_it(self) -> None:
        os.environ["LANDFLOW_BRIDGE"] = "off"
        with LogCapture() as logs:
            server = self.start(transports=["http", "mqtt"])
        self.assertEqual([b.kind for b in server.bindings], ["http"])
        self.assertTrue(any("names 'mqtt' but no such binding" in line["msg"] for line in logs.lines))
        self.assertEqual(self.runs(), [])

    def test_native_driver_wins_over_the_bridge(self) -> None:
        class FakeMqtt(Binding):
            kind = "mqtt"
            started = False

            def start(self, context):
                FakeMqtt.started = True
                return BindingInfo([])

            def stop(self):
                pass

        bridge_mod.register_native_binding("mqtt", FakeMqtt)
        server = self.start(transports=["http", "mqtt"])
        self.assertTrue(FakeMqtt.started)
        self.assertEqual([b.kind for b in server.bindings], ["http", "mqtt"])
        self.assertEqual(self.runs(), [])

    def test_no_kinds_named_means_no_bridge(self) -> None:
        server = self.start()
        self.assertFalse(any(isinstance(b, bridge_mod.BridgeBinding) for b in server.bindings))
        self.assertEqual(self.runs(), [])

    def test_find_binary_order(self) -> None:
        self.assertEqual(bridge_mod.find_bridge_binary({"LANDFLOW_BRIDGE_BIN": str(self.fake)}), str(self.fake))
        self.assertIsNone(bridge_mod.find_bridge_binary({"LANDFLOW_BRIDGE_BIN": "/nope/landflow-bridge"}))
        self.assertFalse(bridge_mod.bridge_enabled({"LANDFLOW_BRIDGE": "OFF"}))
        self.assertTrue(bridge_mod.bridge_enabled({}))
        self.assertIsNone(bridge_mod.bridge_binding_for(["http", "grpc"], []))
        # mqtt and sqs have no native Python driver, so they are bridged whatever is installed.
        binding = bridge_mod.bridge_binding_for(["mqtt", "http", "Sqs"], [], env={"LANDFLOW_MQTT_URL": "mqtt://m:1", "LANDFLOW_SQS_URL": "http://s:1"})
        assert binding is not None
        self.assertEqual(binding.kinds, ["mqtt", "sqs"])
        # A kind with a native driver is served natively, not bridged.
        bridge_mod.register_native_binding("mqtt", Binding)
        self.assertIsNone(bridge_mod.bridge_binding_for(["mqtt"], [], env={"LANDFLOW_MQTT_URL": "mqtt://m:1"}))
        # A kind without a connection URL is not bridged (serve() warns about it instead).
        self.assertIsNone(bridge_mod.bridge_binding_for(["sqs"], [], env={}))


if __name__ == "__main__":
    unittest.main()
