"""Cross-language over live brokers: the TypeScript host (`MessagingClient` from packages/transports with its real driver,
run through tests/crosslang/host-client.mts) discovers and calls a Python plugin served natively by this SDK over each tier 1
broker. Gated on ``LANDFLOW_TEST_<KIND>`` like test_transport_live.py, plus the repo's tsx; skipped otherwise.

    LANDFLOW_TEST_NATS=nats://127.0.0.1:54222 plugins/py-insights/.venv/bin/python -m unittest discover -s sdks/python/tests -p 'test_transport_crosslang_live.py'
"""

from __future__ import annotations

import json
import os
import secrets
import subprocess
import sys
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from _support import builtin_telemetry  # noqa: E402

from landflow_sdk import Node, Plugin, PluginServer  # noqa: E402
from landflow_sdk.transport import Keyring, MessagingBinding, driver_available, load_driver  # noqa: E402
from landflow_sdk.transport.binding import BrokerTarget  # noqa: E402

REPO = Path(__file__).resolve().parents[3]
TSX = REPO / "packages" / "transports" / "node_modules" / ".bin" / "tsx"
SCRIPT = Path(__file__).resolve().parent / "crosslang" / "host-client.mts"
SECRET = "crosslang-s3cret"
REGISTRY_SECRET = "crosslang-registry"
RUN = secrets.token_hex(3)

BROKERS = {
    "kafka": (os.environ.get("LANDFLOW_TEST_KAFKA"), {"partitions": 2}),
    "amqp": (os.environ.get("LANDFLOW_TEST_AMQP") or os.environ.get("LANDFLOW_TEST_RABBITMQ"), {}),
    "nats": (os.environ.get("LANDFLOW_TEST_NATS"), {}),
    "jetstream": (os.environ.get("LANDFLOW_TEST_NATS"), {"streamPrefix": f"lfxl-{RUN}-"}),
    "valkey": (os.environ.get("LANDFLOW_TEST_VALKEY"), {"keyPrefix": f"landflow-test-{RUN}:"}),
}


class Echo(Node):
    description = {
        "name": "echo", "displayName": "Echo", "description": "echo", "version": 1, "kind": "action", "idempotent": True,
        "inputs": [{"type": "main"}], "outputs": [{"type": "main"}], "properties": [],
    }

    def execute(self, ctx):
        delay = ctx.get_node_parameter("delay", 0, 0) or 0
        if delay and ctx.cancel.wait(delay):
            ctx.check_cancelled()
        return [{"echo": item["json"], "credential": (ctx.get_credentials("api") or {}).get("token"), "lang": "python"} for item in ctx.get_input_data()]


def run_host(payload: dict) -> dict:
    proc = subprocess.run([str(TSX), str(SCRIPT)], input=json.dumps(payload).encode(), capture_output=True, cwd=str(SCRIPT.parent), timeout=180, check=False)
    if proc.returncode != 0:
        raise AssertionError(f"tsx host failed: {proc.stderr.decode()[-3000:]}")
    return json.loads(proc.stdout.decode())


def make_case(kind: str, url: str | None, options: dict) -> type[unittest.TestCase]:
    skip = None if url else f"set LANDFLOW_TEST_{'AMQP' if kind == 'amqp' else 'NATS' if kind == 'jetstream' else kind.upper()} to run"
    skip = skip or driver_available(kind) or (None if TSX.exists() else "tsx not found (pnpm install)")

    @unittest.skipIf(skip, skip)
    class CrossLanguageLive(unittest.TestCase):
        def test_ts_host_calls_python_plugin(self):
            plugin_id = f"xl-{kind}-{RUN}"
            prefix = f"lfxl{RUN}"
            module = load_driver(kind)
            config = module.config_from(f"env-{kind}", url, {**options, "prefix": prefix})
            plugin = Plugin(plugin_id, "Cross-language echo", "2.0.0", nodes=[Echo], telemetry=builtin_telemetry(plugin_id))
            binding = MessagingBinding(BrokerTarget(kind, config, module.create), keyring=Keyring(SECRET), registry_secret=REGISTRY_SECRET, announce_interval_ms=500)
            server = PluginServer(plugin, http=False, announce=False, bindings=[binding], max_concurrency=2)
            server.start()
            try:
                self.assertIsNotNone(binding.server)
                execute = {
                    "protocol": "landflow.plugin/v1", "executionId": "xl", "mode": "manual",
                    "node": {"id": "n1", "name": "echo", "type": f"{plugin_id}.echo", "typeVersion": 1},
                    "parameters": {}, "inputs": [[{"json": {"hello": "from TS", "n": 1.5}}]], "credentials": {"api": {"token": "top-secret"}},
                }
                out = run_host({
                    "kind": kind, "url": url, "secret": SECRET, "registrySecret": REGISTRY_SECRET, "prefix": prefix, "pluginId": plugin_id, "waitMs": 20_000, "options": options,
                    "calls": [
                        {"method": "Health", "body": {}},
                        {"method": "GetManifest", "body": {}},
                        {"method": "Execute", "body": execute, "delivery": "at-least-once"},
                        {"method": "Execute", "body": {**execute, "parameters": {"delay": 5}}, "timeoutMs": 10_000, "cancelAfterMs": 300},
                        {"method": "LoadOptions", "body": {"nodeType": f"{plugin_id}.echo", "method": "nothing"}},
                        {"method": "Execute", "body": {**execute, "node": {**execute["node"], "type": f"{plugin_id}.nope"}}},
                    ],
                })
                plugin_view = out["plugin"]
                self.assertIsNotNone(plugin_view, "the TS host never saw the Python plugin's announce")
                self.assertEqual(plugin_view["endpoint"], f"{kind}://xl-host/{plugin_id}")
                self.assertEqual(plugin_view["manifestHash"], binding.server.manifest_hash)
                self.assertEqual(plugin_view["version"], "2.0.0")
                self.assertEqual([i["instanceId"] for i in plugin_view["instances"]], [binding.server.instance_id])
                health, manifest, echo, cancelled, bad_method, unknown = out["results"]
                self.assertEqual(health["body"]["status"], "ok", health)
                self.assertEqual(manifest["body"]["plugin"]["id"], plugin_id)
                self.assertIn(kind, manifest["body"]["transports"])
                self.assertEqual(echo["body"]["outputs"][0][0]["json"], {"echo": {"hello": "from TS", "n": 1.5}, "credential": "top-secret", "lang": "python"}, echo)
                self.assertEqual(echo["instanceId"], binding.server.instance_id)
                self.assertEqual(echo["attributes"]["subject"], f"{plugin_id}.echo")
                self.assertEqual(cancelled.get("code"), "cancelled", cancelled)
                self.assertEqual(bad_method.get("code"), "not_found", bad_method)
                self.assertIn(unknown.get("code"), ("not_found", "bad_request"), unknown)
                # The Python side saw the cancel and the at-least-once delivery.
                counters = binding.server.counters
                deadline = time.monotonic() + 5
                while binding.server.in_flight_count and time.monotonic() < deadline:
                    time.sleep(0.05)
                self.assertGreaterEqual(counters["cancelled"], 1, counters)
                self.assertGreaterEqual(counters["dispatched"], 5, counters)
            finally:
                server.stop()
                cleanup(kind, url, options)

    CrossLanguageLive.__name__ = CrossLanguageLive.__qualname__ = f"CrossLanguage_{kind}"
    return CrossLanguageLive


def cleanup(kind: str, url: str, options: dict) -> None:
    try:
        if kind == "valkey":
            import valkey

            client = valkey.Valkey.from_url(url)
            cursor = 0
            while True:
                cursor, keys = client.scan(cursor, match=f"{options['keyPrefix']}*", count=200)
                if keys:
                    client.delete(*keys)
                if cursor == 0:
                    break
            client.close()
        elif kind == "jetstream":
            import asyncio

            import nats

            async def run() -> None:
                nc = await nats.connect(url)
                js = nc.jetstream()
                for info in await js.streams_info():
                    if info.config.name.startswith(options["streamPrefix"]):
                        await js.delete_stream(info.config.name)
                await nc.close()

            asyncio.run(run())
        elif kind == "kafka":
            from confluent_kafka.admin import AdminClient

            admin = AdminClient({"bootstrap.servers": url})
            topics = [t for t in admin.list_topics(timeout=10).topics if t.startswith(f"lfxl{RUN}.")]
            if topics:
                for future in admin.delete_topics(topics, operation_timeout=15).values():
                    try:
                        future.result(15)
                    except Exception:  # noqa: BLE001
                        pass
    except Exception:  # noqa: BLE001 - best effort
        pass


for _kind, (_url, _options) in BROKERS.items():
    globals()[f"CrossLanguage_{_kind}"] = make_case(_kind, _url, _options)

if __name__ == "__main__":
    unittest.main()
