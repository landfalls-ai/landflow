"""Cross-language check against the TypeScript core (packages/transports): events sealed by one side open and verify on
the other, in both CloudEvents modes, for requests, responses, announces and cancels; and the manifest hash agrees.
Runs sdks/go/transport/testdata/crosslang.mts (the helper the Go core uses too) with the repo's tsx; skipped when node
or tsx is not available."""

from __future__ import annotations

import base64
import json
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from landflow_sdk.transport import Attributes, BrokerConfig, Capabilities, Codec, Keyring, WireEvent, manifest_hash_of  # noqa: E402
from landflow_sdk.transport.envelope import ANNOUNCE_TYPE, CANCEL_TYPE, format_time, host_source, now_ms, plugin_source, request_type, response_type  # noqa: E402
from landflow_sdk.transport.memory import MEMORY_CAPABILITIES  # noqa: E402
from landflow_sdk.transport.security import registry_proof  # noqa: E402

REPO = Path(__file__).resolve().parents[3]
TSX = REPO / "packages" / "transports" / "node_modules" / ".bin" / "tsx"
SCRIPT = REPO / "sdks" / "go" / "transport" / "testdata" / "crosslang.mts"
SECRET = "transport-s3cret"
PLUGIN = "cross-plugin"

try:
    import cryptography  # noqa: F401

    HAVE_CRYPTO = True
except ImportError:  # pragma: no cover
    HAVE_CRYPTO = False


def run_crosslang(payload: dict) -> dict:
    proc = subprocess.run([str(TSX), str(SCRIPT)], input=json.dumps(payload).encode(), capture_output=True, cwd=str(SCRIPT.parent), timeout=120, check=False)
    if proc.returncode != 0:
        raise AssertionError(f"tsx failed: {proc.stderr.decode()}")
    return json.loads(proc.stdout.decode())


def kinds() -> list[dict]:
    now = format_time(now_ms())
    return [
        {"name": "request", "type": request_type("Execute"), "encrypt": True, "data": {
            "protocol": "landflow.plugin/v1", "executionId": "exec-1", "mode": "manual",
            "node": {"id": "n1", "name": "echo", "type": f"{PLUGIN}.echo", "typeVersion": 1},
            "parameters": {"text": "<b>hi & bye</b>   ünïcödé", "ratio": 1.5, "whole": 2.0},
            "inputs": [[{"json": {"hello": "world", "n": 1.5}}]], "credentials": {"api": {"token": "top-secret-token"}},
        }, "extra": {"source": host_source("h1"), "subject": f"{PLUGIN}.echo", "lfreplyto": "landflow.v1.reply.h1", "lfdeadline": "1793102430000", "lfattempt": "1",
                     "lfdelivery": "at-most-once", "lfmanifest": "0123456789abcdef", "traceparent": "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"}},
        {"name": "response", "type": response_type("Execute"), "encrypt": True, "data": {"outputs": [[{"json": {"ok": True}}]]},
         "extra": {"source": plugin_source(PLUGIN, "i1"), "lfcorrelation": "call-1", "lfmanifest": "0123456789abcdef", "subject": f"{PLUGIN}.echo"}},
        {"name": "error-response", "type": response_type("Health"), "encrypt": True, "data": {"error": "no such node", "nodeType": "x"},
         "extra": {"source": plugin_source(PLUGIN, "i1"), "lfcorrelation": "call-2", "lferror": "not_found"}},
        {"name": "announce", "type": ANNOUNCE_TYPE, "encrypt": False, "data": {
            "protocol": "landflow.plugin/v1", "pluginId": PLUGIN, "version": "1.2.3", "instanceId": "i1", "manifestHash": "0123456789abcdef",
            "endpoint": f"nats://env-nats/{PLUGIN}", "maxConcurrency": 4, "ttlSeconds": 30, "registryProof": registry_proof("r", PLUGIN, "x"), "transports": ["http", "nats"],
        }, "extra": {"source": plugin_source(PLUGIN, "i1"), "lfmanifest": "0123456789abcdef"}},
        {"name": "cancel", "type": CANCEL_TYPE, "encrypt": False, "data": {"callId": "call-1", "reason": "user stopped <now>"},
         "extra": {"source": host_source("h1"), "lfcorrelation": "call-1", "time": now}},
    ]


def base_attributes(type_: str, event_id: str, extra: dict) -> Attributes:
    attributes = Attributes(id=event_id, type=type_, time=format_time(now_ms()))
    for name, value in extra.items():
        setattr(attributes, name, value)
    return attributes


def js_round_trip(value):
    from landflow_sdk.transport import json_stringify

    return json.loads(json_stringify(value))


@unittest.skipUnless(TSX.exists(), "packages/transports/node_modules/.bin/tsx not found (run pnpm install)")
@unittest.skipUnless(HAVE_CRYPTO, "cryptography not installed")
class CrossLanguageTest(unittest.TestCase):
    def codec(self, mode: str, ring: Keyring | None = None) -> Codec:
        return Codec(ring or Keyring(SECRET), MEMORY_CAPABILITIES.copy(headers=mode == "binary"))

    def test_ts_seals_python_opens(self):
        seal = []
        for mode in ("binary", "structured"):
            for k in kinds():
                seal.append({"attributes": base_attributes(k["type"], f"ts-{k['name']}-{mode}", k["extra"]).headers(), "data": k["data"], "encrypt": k["encrypt"], "mode": mode})
        out = run_crosslang({"secret": SECRET, "pluginId": PLUGIN, "seal": seal})
        self.assertEqual(len(out["sealed"]), len(seal))
        all_kinds = kinds()
        for index, sealed in enumerate(out["sealed"]):
            k = all_kinds[index % len(all_kinds)]
            mode = seal[index]["mode"]
            codec = self.codec(mode)
            wire = WireEvent(sealed["headers"], base64.b64decode(sealed["bodyBase64"]))
            raw = codec.peek(wire)
            self.assertEqual(raw.attributes.lfsig, sealed["attributes"]["lfsig"], f"{k['name']}/{mode}")
            self.assertEqual(bool(raw.attributes.lfenc), k["encrypt"])
            attributes, data = codec.unpack(raw, PLUGIN)
            self.assertEqual(data, js_round_trip(k["data"]), f"{k['name']}/{mode}")
            with self.assertRaises(Exception, msg=f"{k['name']}/{mode}: accepted under another plugin's key"):
                codec.unpack(raw, "other-plugin")
            if k["encrypt"]:
                body = bytearray(raw.body)
                body[-1] ^= 1
                tampered = type(raw)(raw.attributes, bytes(body))
                with self.assertRaises(Exception, msg=f"{k['name']}/{mode}: accepted a tampered body"):
                    codec.unpack(tampered, PLUGIN)

    def test_python_seals_ts_opens(self):
        open_cases = []
        expected = []
        all_kinds = kinds()
        for mode in ("binary", "structured"):
            codec = self.codec(mode)
            for k in all_kinds:
                packed = codec.pack(PLUGIN, base_attributes(k["type"], f"py-{k['name']}-{mode}", k["extra"]), k["data"], k["encrypt"])
                open_cases.append({"headers": packed.wire.headers, "bodyBase64": base64.b64encode(packed.wire.body).decode(), "mode": mode})
                expected.append(js_round_trip(k["data"]))
        codec = self.codec("binary")
        packed = codec.pack(PLUGIN, base_attributes(request_type("Health"), "py-tampered", {"source": host_source("h1")}), {}, True)
        packed.wire.headers["lfdeadline"] = "1793102430000"
        open_cases.append({"headers": packed.wire.headers, "bodyBase64": base64.b64encode(packed.wire.body).decode(), "mode": "binary"})
        foreign = self.codec("binary", Keyring("another")).pack(PLUGIN, base_attributes(request_type("Health"), "py-foreign", {"source": host_source("h1")}), {}, True)
        open_cases.append({"headers": foreign.wire.headers, "bodyBase64": base64.b64encode(foreign.wire.body).decode(), "mode": "binary"})
        out = run_crosslang({"secret": SECRET, "pluginId": PLUGIN, "open": open_cases})
        self.assertEqual(len(out["opened"]), len(open_cases))
        for index, opened in enumerate(out["opened"][: len(expected)]):
            k = all_kinds[index % len(all_kinds)]
            self.assertNotIn("error", opened, f"{k['name']}/{open_cases[index]['mode']}: TS refused: {opened.get('error')}")
            self.assertEqual(opened["data"], expected[index], f"{k['name']}")
            self.assertEqual(opened["attributes"]["type"], k["type"])
        self.assertIn("error", out["opened"][len(expected)], "TS accepted a tampered event")
        self.assertIn("error", out["opened"][len(expected) + 1], "TS accepted a foreign-key event")

    def test_manifest_hash_agrees(self):
        manifest = {
            "protocol": "landflow.plugin/v1", "plugin": {"id": PLUGIN, "name": "Cross <&> plugin", "version": "0.1.0"},
            "nodes": [{"name": "echo", "displayName": "Echo", "description": 'says "hi" & more ünï', "version": 1.5, "ratio": 2.0, "tiny": 1e-7, "huge": 1e21,
                       "properties": [{"name": "operation", "type": "options", "options": [{"name": "Get", "value": "get", "idempotent": True}, {"name": "Put", "value": 2}]}]}],
            "maxConcurrency": 8,
        }
        out = run_crosslang({"secret": SECRET, "pluginId": PLUGIN, "manifest": manifest})
        self.assertEqual(out["manifestHash"], manifest_hash_of(manifest))
        # The hash the host computes from the manifest as the Python SDK serves it (parsed back in JS) is the same one.
        from landflow_sdk import Plugin
        from landflow_sdk.transport import json_stringify

        from _support import builtin_telemetry

        from test_transport_core import Echo

        plugin = Plugin("cross-plugin", "Cross", "1.0.0", nodes=[Echo], telemetry=builtin_telemetry("cross-plugin"))
        served = plugin.manifest()
        out = run_crosslang({"secret": SECRET, "pluginId": PLUGIN, "manifest": json.loads(json_stringify(served))})
        self.assertEqual(out["manifestHash"], manifest_hash_of(served))


if __name__ == "__main__":
    unittest.main()
