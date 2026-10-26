"""The Python messaging core (``landflow_sdk.transport``): the known-answer vectors shared with the TS and Go cores,
the envelope in both modes, security refusals, and the server's delivery rules over the in-memory broker."""

from __future__ import annotations

import sys
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from _support import builtin_telemetry  # noqa: E402

from landflow_sdk import Dispatcher, Node, OverloadedError, Plugin  # noqa: E402
from landflow_sdk.dispatcher import CancelToken  # noqa: E402
from landflow_sdk.transport import (  # noqa: E402
    Attributes,
    BrokerConfig,
    Capabilities,
    ChannelNames,
    Codec,
    ConsumeOptions,
    DispatchError,
    EnvelopeError,
    Keyring,
    ManifestMismatchError,
    MemoryBroker,
    MessagingClient,
    MessagingServer,
    MissingSecretError,
    RawEvent,
    RemoteError,
    ReplayGuard,
    SecurityError,
    TimeoutError_,
    UndeliverableError,
    WireEvent,
    idempotency_from_manifest,
    json_stringify,
    manifest_hash_of,
    messaging_dispatcher,
    parse_broker_endpoint,
)
from landflow_sdk.transport.binding import BrokerTarget, MessagingBinding  # noqa: E402
from landflow_sdk.transport.envelope import decode_wire, encode_wire, format_time, js_number, parse_type, subject_of, validate_attributes  # noqa: E402
from landflow_sdk.transport.security import (  # noqa: E402
    canonical_form,
    decrypt_body,
    derive_keys,
    encrypt_body,
    key_id_of,
    open_event,
    registry_proof,
    seal,
    verify_registry_proof,
)

try:
    import cryptography  # noqa: F401

    HAVE_CRYPTO = True
except ImportError:  # pragma: no cover
    HAVE_CRYPTO = False

VEC_SECRET = "transport-s3cret"
VEC_PLUGIN = "test-plugin"
VEC_NOW = 1793016001000  # 2026-10-26T12:00:01Z


def vec_attributes() -> Attributes:
    return Attributes(
        id="call-1", source="landflow://host/h1", type="dev.landflow.plugin.v1.health.request", time="2026-10-26T12:00:00.000Z",
        datacontenttype="application/json", lfreplyto="landflow.v1.reply.h1", lfdeadline="1793102430000", lfattempt="1", lfdelivery="at-least-once",
    )


class VectorTest(unittest.TestCase):
    """Known answers shared with packages/transports/test/security.test.ts and sdks/go/transport/security_test.go."""

    def test_key_derivation(self):
        self.assertEqual(key_id_of(VEC_SECRET), "9a5c85f5715d1126")
        keys = derive_keys(VEC_SECRET, VEC_PLUGIN)
        self.assertEqual(keys.enc.hex(), "0c16cc20dcdd656ccb50880e4ff8abe53e936a69254e70ca38b2f3ce340e1648")
        self.assertEqual(keys.sig.hex(), "cfcefdc42b585afb5a42bbd8637d106e26a91b7159c19dec14a5d3d038c5308c")
        self.assertNotEqual(derive_keys(VEC_SECRET, "other-plugin").enc, keys.enc)

    def test_signing_vector(self):
        ring = Keyring(VEC_SECRET)
        sealed = seal(ring, VEC_PLUGIN, RawEvent(vec_attributes(), b"{}"), encrypt=False)
        want = (
            "specversion=1.0\nid=call-1\nsource=landflow://host/h1\ntype=dev.landflow.plugin.v1.health.request\ntime=2026-10-26T12:00:00.000Z\n"
            "datacontenttype=application/json\nlfreplyto=landflow.v1.reply.h1\nlfdeadline=1793102430000\nlfattempt=1\nlfdelivery=at-least-once\n"
            "lfkeyid=9a5c85f5715d1126\n44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a\n"
        )
        self.assertEqual(canonical_form(sealed.attributes, sealed.body), want)
        self.assertEqual(sealed.attributes.lfsig, "6f4f5b0e15bf654e1d2999781cfa3b22198d8ead69df6ba6d8f548f438cd3c56")
        self.assertEqual(sealed.attributes.lfkeyid, "9a5c85f5715d1126")
        self.assertIsNone(sealed.attributes.lfenc)
        opened = open_event(ring, VEC_PLUGIN, sealed, now=VEC_NOW)
        self.assertEqual(opened.body, b"{}")

    @unittest.skipUnless(HAVE_CRYPTO, "cryptography not installed")
    def test_encryption_vector(self):
        ring = Keyring(VEC_SECRET)
        sealed = seal(ring, VEC_PLUGIN, RawEvent(vec_attributes(), b'{"ok":true}'), encrypt=True, nonce=bytes.fromhex("000102030405060708090a0b"))
        self.assertEqual(sealed.attributes.lfenc, "aes-256-gcm")
        self.assertEqual(sealed.attributes.datacontenttype, "application/octet-stream")
        self.assertEqual(sealed.body.hex(), "000102030405060708090a0bee671ac6aba5fd1cecf11bc896d7854dd5489bb2a610aab761ada4")
        self.assertEqual(sealed.attributes.lfsig, "9d9b3ba516457881811e270747207d5a64c0646d054f5e6d1aff8b7f17db1505")
        self.assertEqual(open_event(ring, VEC_PLUGIN, sealed, now=VEC_NOW).body, b'{"ok":true}')

    @unittest.skipUnless(HAVE_CRYPTO, "cryptography not installed")
    def test_encryption_binding(self):
        keys = derive_keys(VEC_SECRET, VEC_PLUGIN)
        base = vec_attributes()
        sealed = encrypt_body(keys.enc, base, b'{"x":1}')
        self.assertEqual(decrypt_body(keys.enc, base, sealed), b'{"x":1}')
        with self.assertRaises(SecurityError):
            decrypt_body(keys.enc, base.copy(id="call-2"), sealed)
        flipped = bytearray(sealed)
        flipped[14] ^= 1
        with self.assertRaises(SecurityError):
            decrypt_body(keys.enc, base, bytes(flipped))
        with self.assertRaisesRegex(SecurityError, "too short"):
            decrypt_body(keys.enc, base, b"\x00" * 10)
        ring = Keyring(VEC_SECRET)
        a = seal(ring, VEC_PLUGIN, RawEvent(vec_attributes(), b"{}"), encrypt=True)
        b = seal(ring, VEC_PLUGIN, RawEvent(vec_attributes(), b"{}"), encrypt=True)
        self.assertNotEqual(a.body, b.body, "nonce must be fresh per event")

    def test_registry_proof_vector(self):
        proof = "d6d47aef6c9f0cdd2357464b9db5c8d2a049d3768756e10af5ec4e37ad47655e"
        self.assertEqual(registry_proof("registry-s3cret", "test-plugin", "challenge-123"), proof)
        self.assertTrue(verify_registry_proof("registry-s3cret", "test-plugin", "challenge-123", proof))
        self.assertFalse(verify_registry_proof("registry-s3cret", "other", "challenge-123", proof))
        self.assertFalse(verify_registry_proof("registry-s3cret", "test-plugin", "challenge-123", None))

    def test_structured_document_bytes(self):
        attrs = vec_attributes().copy(lfkeyid="9a5c85f5715d1126", lfsig="b" * 64)
        wire, _size = encode_wire(RawEvent(attrs, b'{"a":[1,2],"s":"<x & y>"}'), "structured")
        want = (
            '{"specversion":"1.0","id":"call-1","source":"landflow://host/h1","type":"dev.landflow.plugin.v1.health.request","time":"2026-10-26T12:00:00.000Z",'
            '"datacontenttype":"application/json","lfreplyto":"landflow.v1.reply.h1","lfdeadline":"1793102430000","lfattempt":"1","lfdelivery":"at-least-once",'
            '"lfkeyid":"9a5c85f5715d1126","lfsig":"' + "b" * 64 + '","data":{"a":[1,2],"s":"<x & y>"}}'
        )
        self.assertEqual(wire.body.decode(), want)
        self.assertEqual(wire.headers, {"content-type": "application/cloudevents+json; charset=utf-8"})


class JsonStringifyTest(unittest.TestCase):
    def test_matches_json_stringify(self):
        self.assertEqual(json_stringify({"type": "a.b", "n": 1.5, "s": "<&> ", "u": "ünï", "f": 2.0, "big": 1e21, "small": 1e-7, "t": 0.00001}),
                         '{"type":"a.b","n":1.5,"s":"<&> ","u":"ünï","f":2,"big":1e+21,"small":1e-7,"t":0.00001}')
        self.assertEqual(json_stringify([True, None, "a\nb\u0001\"q\""]), '[true,null,"a\\nb\\u0001\\"q\\""]')
        self.assertEqual(json_stringify(float("nan")), "null")
        for value, want in ((123456789012345680000.0, "123456789012345680000"), (0.1 + 0.2, "0.30000000000000004"), (-0.5, "-0.5"), (1e16, "10000000000000000"), (1.5e-10, "1.5e-10")):
            self.assertEqual(js_number(value), want)

    def test_manifest_hash_and_idempotency(self):
        manifest = {
            "protocol": "landflow.plugin/v1", "plugin": {"id": "cross-plugin", "name": "Cross <&> plugin", "version": "0.1.0"},
            "nodes": [{"name": "echo", "displayName": "Echo", "description": 'says "hi" & more', "version": 1.5,
                       "properties": [{"name": "operation", "type": "options", "options": [{"name": "Get", "value": "get", "idempotent": True}, {"name": "Put", "value": 2}]}]}],
            "maxConcurrency": 8,
        }
        self.assertRegex(manifest_hash_of(manifest), r"^[0-9a-f]{16}$")
        idem = idempotency_from_manifest(manifest)
        self.assertTrue(idem({"node": {"type": "cross-plugin.echo"}, "parameters": {"operation": "get"}}))
        self.assertFalse(idem({"node": {"type": "cross-plugin.echo"}, "parameters": {"operation": "put"}}))
        self.assertFalse(idem({"node": {"type": "cross-plugin.echo"}}))


class EnvelopeTest(unittest.TestCase):
    def test_parse_type(self):
        self.assertEqual(parse_type("dev.landflow.plugin.v1.execute.request").kind, "request")
        self.assertEqual(parse_type("dev.landflow.plugin.v1.health.response").method, "Health")
        self.assertEqual(parse_type("dev.landflow.plugin.v1.cancel").kind, "cancel")
        for bad in ("dev.landflow.plugin.v1.receivewebhook.re", "dev.landflow.plugin.v2.execute.request", "dev.landflow.plugin.v1.nope.request"):
            self.assertIsNone(parse_type(bad), bad)

    def test_binary_round_trip(self):
        raw = RawEvent(vec_attributes().copy(lfkeyid="9a5c85f5715d1126", lfsig="a" * 64), b'{"a":1}')
        wire, size = encode_wire(raw, "binary")
        self.assertEqual(wire.headers["content-type"], "application/json")
        self.assertEqual(wire.headers["lfdelivery"], "at-least-once")
        self.assertNotIn("subject", wire.headers)
        self.assertEqual(size.body_bytes, 7)
        wire.headers["LfDeadline"] = wire.headers.pop("lfdeadline")
        wire.headers["x-broker-thing"] = "ignored"
        wire.headers["content-type"] = "application/json; charset=utf-8"
        decoded = decode_wire(wire)
        self.assertEqual(decoded.attributes, raw.attributes)
        self.assertEqual(decoded.body, b'{"a":1}')
        with self.assertRaises(EnvelopeError):
            decode_wire(wire, strict=True)
        with self.assertRaises(EnvelopeError):
            decode_wire(wire, max_bytes=10)
        wire.headers["content-type"] = "text/plain"
        with self.assertRaises(EnvelopeError) as caught:
            decode_wire(wire)
        self.assertEqual(caught.exception.reason, "malformed")

    def test_structured_round_trip(self):
        attrs = vec_attributes().copy(lfkeyid="9a5c85f5715d1126", lfsig="b" * 64)
        wire, _ = encode_wire(RawEvent(attrs, b'{"a":[1,2]}'), "structured")
        decoded = decode_wire(wire)
        self.assertEqual(decoded.attributes, attrs)
        self.assertEqual(decoded.body, b'{"a":[1,2]}')
        enc = attrs.copy(lfenc="aes-256-gcm", datacontenttype="application/octet-stream")
        wire, _ = encode_wire(RawEvent(enc, b"\x00\x01\x02\xff"), "structured")
        self.assertIn(b'"data_base64":"AAEC/w=="', wire.body)
        self.assertEqual(decode_wire(wire).body, b"\x00\x01\x02\xff")
        wire, _ = encode_wire(RawEvent(attrs, b""), "structured")
        self.assertTrue(wire.body.endswith(b'"data":null}'))
        self.assertEqual(decode_wire(wire).body, b"")
        for bad in (b"[1]", b"null", b"not json", b'{"specversion":1}'):
            with self.assertRaises(EnvelopeError):
                decode_wire(WireEvent({}, bad))

    def test_validate_rules(self):
        base = {"specversion": "1.0", "id": "x", "source": "landflow://host/h", "type": "dev.landflow.plugin.v1.cancel", "time": "2026-01-01T00:00:00Z", "datacontenttype": "application/json"}
        validate_attributes(dict(base))
        cases = [
            ("specversion", "0.3", "unsupported"), ("type", "dev.landflow.plugin.v1.what.request", "unsupported"), ("datacontenttype", "text/plain", "unsupported"),
            ("lfenc", "aes-256-gcm", "malformed"), ("lfenc", "rot13", "unsupported"), ("lfdelivery", "exactly-once", "malformed"), ("id", "has space", "malformed"),
            ("source", "http://x", "malformed"), ("time", "yesterday", "malformed"), ("lfdeadline", "-1", "malformed"), ("lfsig", "abc", "malformed"),
            ("subject", "bad subject", "malformed"), ("tracestate", "\x01", "malformed"),
        ]
        for name, value, reason in cases:
            with self.assertRaises(EnvelopeError, msg=f"{name}={value!r}") as caught:
                validate_attributes({**base, name: value})
            self.assertEqual(caught.exception.reason, reason, f"{name}={value!r}")
        missing = dict(base)
        del missing["id"]
        with self.assertRaises(EnvelopeError):
            validate_attributes(missing)

    def test_helpers(self):
        self.assertEqual(format_time(1793016000000), "2026-10-26T12:00:00.000Z")
        self.assertEqual(subject_of("Execute", {"node": {"type": "twilio.message"}}), "twilio.message")
        self.assertEqual(subject_of("LoadOptions", {"nodeType": "x.y"}), "x.y")
        self.assertIsNone(subject_of("Health", {}))
        names = ChannelNames()
        self.assertEqual(names.request("twilio"), "landflow.v1.plugin.twilio")
        self.assertEqual(names.instance("twilio", "i1"), "landflow.v1.instance.twilio.i1")
        self.assertEqual(ChannelNames("acme").registry(), "acme.v1.registry")
        with self.assertRaises(ValueError):
            names.request("bad/id")
        self.assertEqual(parse_broker_endpoint("kafka://kafka-main/twilio"), ("kafka", "kafka-main", "twilio"))
        self.assertIsNone(parse_broker_endpoint("http://127.0.0.1:7100"))


class SecurityTest(unittest.TestCase):
    def reason(self, ring: Keyring, plugin_id: str, event: RawEvent, **options) -> str:
        try:
            open_event(ring, plugin_id, event, now=options.pop("now", VEC_NOW), **options)
            return "accepted"
        except SecurityError as exc:
            return exc.reason

    def test_refusals(self):
        ring = Keyring(VEC_SECRET)
        sealed = seal(ring, VEC_PLUGIN, RawEvent(vec_attributes(), b'{"a":1}'), encrypt=False)
        self.assertEqual(self.reason(ring, VEC_PLUGIN, sealed), "accepted")
        self.assertEqual(self.reason(ring, VEC_PLUGIN, RawEvent(sealed.attributes.copy(lfsig=None), sealed.body)), "unsigned")
        self.assertEqual(self.reason(ring, VEC_PLUGIN, RawEvent(sealed.attributes.copy(lfdeadline="1"), sealed.body)), "bad_signature")
        self.assertEqual(self.reason(ring, VEC_PLUGIN, RawEvent(sealed.attributes, b'{"a":2}')), "bad_signature")
        self.assertEqual(self.reason(Keyring("another"), VEC_PLUGIN, sealed), "unknown_key")
        self.assertEqual(self.reason(ring, "other-plugin", sealed), "bad_signature")
        self.assertEqual(self.reason(Keyring("new-secret", [VEC_SECRET]), VEC_PLUGIN, sealed), "accepted")
        self.assertEqual(self.reason(ring, VEC_PLUGIN, sealed, now=VEC_NOW + 6 * 60_000), "clock_skew")
        self.assertEqual(self.reason(ring, VEC_PLUGIN, sealed, now=VEC_NOW - 6 * 60_000), "clock_skew")
        self.assertEqual(self.reason(ring, VEC_PLUGIN, sealed, now=VEC_NOW + 6 * 60_000, clock_skew_ms=10 * 60_000), "accepted")
        replay = ReplayGuard(60_000)
        self.assertEqual(self.reason(ring, VEC_PLUGIN, sealed, replay=replay), "accepted")
        self.assertEqual(self.reason(ring, VEC_PLUGIN, sealed, replay=replay, now=VEC_NOW + 1000), "replay")
        replay.forget("call-1")
        self.assertEqual(self.reason(ring, VEC_PLUGIN, sealed, replay=replay, now=VEC_NOW + 1000), "accepted")
        self.assertEqual(self.reason(ring, VEC_PLUGIN, sealed, replay=replay, now=VEC_NOW + 61_001), "accepted")

    def test_keyring_from_env(self):
        with self.assertRaises(MissingSecretError):
            Keyring.from_env({})
        self.assertEqual(Keyring.from_env({"LANDFLOW_REGISTRY_SECRET": "r"}).current_key_id, key_id_of("r"))
        ring = Keyring.from_env({"LANDFLOW_TRANSPORT_SECRET": "t", "LANDFLOW_REGISTRY_SECRET": "r", "LANDFLOW_TRANSPORT_SECRET_PREVIOUS": "p1, p2"})
        self.assertEqual(ring.current_key_id, key_id_of("t"))
        self.assertTrue(ring.has(key_id_of("p1")) and ring.has(key_id_of("p2")) and not ring.has(key_id_of("r")))

    def test_replay_guard_bounded(self):
        guard = ReplayGuard(60_000, 100)
        for i in range(150):
            guard.accept(f"id-{i}", 1000)
        self.assertLessEqual(guard.size, 100)
        self.assertFalse(guard.accept("id-149", 1000))


# --- the server over the memory broker ---------------------------------------------------------------------------------


class Echo(Node):
    description = {
        "name": "echo", "displayName": "Echo", "description": "echo", "version": 1, "kind": "action",
        "inputs": [{"type": "main"}], "outputs": [{"type": "main"}],
        "properties": [{"name": "operation", "displayName": "Op", "type": "options", "default": "get", "options": [{"name": "Get", "value": "get", "idempotent": True}, {"name": "Put", "value": "put"}]}],
    }

    def execute(self, ctx):
        delay = ctx.get_node_parameter("delay", 0, 0) or 0
        if delay:
            if ctx.cancel.wait(delay):
                ctx.check_cancelled()
        return [{"echo": item["json"], "credential": (ctx.get_credentials("api") or {}).get("token")} for item in ctx.get_input_data()]


def make_plugin(plugin_id: str = "py-echo") -> Plugin:
    return Plugin(plugin_id, "Echo plugin", "1.2.3", nodes=[Echo], telemetry=builtin_telemetry(plugin_id))


def execute_request(plugin_id: str = "py-echo", **parameters) -> dict:
    return {
        "protocol": "landflow.plugin/v1", "executionId": "ex1", "mode": "manual",
        "node": {"id": "n1", "name": "echo", "type": f"{plugin_id}.echo", "typeVersion": 1},
        "parameters": {"operation": "get", **parameters}, "itemParameters": [], "inputs": [[{"json": {"hello": "world"}}]],
        "credentials": {"api": {"token": "top-secret"}},
    }


@unittest.skipUnless(HAVE_CRYPTO, "cryptography not installed")
class ServerTest(unittest.TestCase):
    """``MessagingServer`` + ``MessagingClient`` over ``MemoryBroker``, with the SDK dispatcher behind the server."""

    def setUp(self):
        self.broker = MemoryBroker()
        self.ring = Keyring(VEC_SECRET)
        self.plugin = make_plugin()
        self.plugin.max_concurrency = 2
        self.dispatcher = Dispatcher(self.plugin, 2, 2)
        self.plugin.dispatcher = self.dispatcher
        self.seen: list = []
        self.server = self.make_server()
        self.server.start()
        self.client = MessagingClient(driver=self.broker.driver(), config=BrokerConfig("mem"), keyring=self.ring, stats_interval_ms=0, registry_secret=False)
        self.client.start()

    def make_server(self, **overrides) -> MessagingServer:
        options = dict(
            driver=self.broker.driver(), config=BrokerConfig("mem"), keyring=self.ring, plugin_id=self.plugin.id, version=self.plugin.version,
            manifest=self.plugin.manifest(), max_concurrency=2, registry_secret=False, announce_interval_ms=200, drain_timeout_ms=2000,
            dispatch=messaging_dispatcher(self.dispatcher, kind="memory", observe=lambda m, c: self.seen.append((m, c))),
        )
        options.update(overrides)
        return MessagingServer(**options)

    def tearDown(self):
        self.client.close()
        self.server.stop()

    def wait_until(self, cond, what: str, timeout: float = 5.0) -> None:
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            if cond():
                return
            time.sleep(0.01)
        self.fail(f"timed out waiting for {what}")

    def test_execute_round_trip_with_credentials(self):
        reply = self.client.invoke("py-echo", "Execute", execute_request(), timeout_ms=5000)
        self.assertEqual(reply.body["outputs"][0][0]["json"], {"echo": {"hello": "world"}, "credential": "top-secret"})
        self.assertEqual(reply.instance_id, self.server.instance_id)
        self.assertEqual(reply.attributes.subject, "py-echo.echo")
        self.assertEqual(reply.attributes.lfmanifest, self.server.manifest_hash)
        method, context = self.seen[-1]
        self.assertEqual((method, context.delivery, context.attempt), ("Execute", "at-most-once", 1))  # the host did not ask for at-least-once
        self.assertEqual(self.client.call("py-echo", "Health", {})["status"], "ok")
        self.assertEqual(self.client.call("py-echo", "GetManifest", {})["plugin"]["id"], "py-echo")

    def test_only_ciphertext_on_the_wire(self):
        seen: list[bytes] = []
        self.broker.tap(lambda channel, event: (seen.append(event.body), event)[1])
        self.client.call("py-echo", "Execute", execute_request(), timeout_ms=5000)
        payloads = [body for body in seen if body]
        self.assertTrue(payloads)
        for body in payloads:
            self.assertNotIn(b"top-secret", body)
            self.assertNotIn(b"hello", body)

    def test_delivery_modes(self):
        self.client.call("py-echo", "Execute", execute_request(operation="put"), timeout_ms=5000)
        self.assertEqual(self.seen[-1][1].delivery, "at-most-once")
        self.client.call("py-echo", "Execute", execute_request(operation="put"), timeout_ms=5000, delivery="at-least-once")
        self.assertEqual(self.seen[-1][1].delivery, "at-most-once", "a plugin never upgrades a non-idempotent Execute")
        self.client.call("py-echo", "Execute", execute_request(operation="put"), timeout_ms=5000, delivery="at-least-once", idempotency_key="k1")
        self.assertEqual(self.seen[-1][1].delivery, "at-least-once")
        self.assertEqual(self.seen[-1][1].idempotency_key, "k1")
        self.client.call("py-echo", "Health", {}, timeout_ms=5000)
        self.assertEqual(self.seen[-1][1].delivery, "at-least-once")

    def test_deadline_expires_and_cancels_the_node(self):
        with self.assertRaises(TimeoutError_):
            self.client.call("py-echo", "Execute", execute_request(delay=5), timeout_ms=300)
        self.wait_until(lambda: self.server.in_flight_count == 0, "the call to end")
        self.assertEqual(self.dispatcher.in_flight, 0)
        self.assertGreaterEqual(self.server.counters["expired"], 1)

    def test_cancel_reaches_the_plugin(self):
        token = CancelToken()
        box: dict = {}

        def run():
            try:
                self.client.call("py-echo", "Execute", execute_request(delay=5), timeout_ms=5000, cancel=token)
            except Exception as exc:  # noqa: BLE001
                box["error"] = exc

        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        self.wait_until(lambda: self.server.in_flight_count == 1, "the call to start")
        token.cancel("user stopped")
        thread.join(5)
        self.assertEqual(type(box.get("error")).__name__, "CancelledError")
        self.wait_until(lambda: self.server.in_flight_count == 0, "the plugin to cancel")
        self.assertGreaterEqual(self.server.counters["cancelled"], 1)

    def test_error_codes(self):
        with self.assertRaises(RemoteError) as caught:
            self.client.call("py-echo", "Execute", {"protocol": "landflow.plugin/v1", "node": {"type": "py-echo.nope"}}, timeout_ms=5000)
        self.assertIn(caught.exception.remote_code, ("not_found", "bad_request"))
        with self.assertRaises(RemoteError) as caught:
            self.client.call("py-echo", "LoadOptions", {"nodeType": "py-echo.echo", "method": "nothing"}, timeout_ms=5000)
        self.assertEqual(caught.exception.remote_code, "not_found")
        with self.assertRaises(RemoteError) as caught:
            self.client.call("py-echo", "Execute", "not an object", timeout_ms=5000)
        self.assertEqual(caught.exception.remote_code, "bad_request")

    def test_manifest_mismatch_after_one_requeue(self):
        with self.assertRaises(ManifestMismatchError) as caught:
            self.client.call("py-echo", "Health", {}, timeout_ms=5000, manifest_hash="0123456789abcdef")
        self.assertEqual(caught.exception.actual, self.server.manifest_hash)
        self.assertEqual(self.server.counters["requeued"], 1)
        self.assertEqual(self.server.counters["mismatched"], 2)
        self.assertEqual(self.server.counters["dispatched"], 0)

    def test_discovery_and_withdraw(self):
        self.wait_until(lambda: self.client.plugin("py-echo") is not None, "the announce")
        plugin = self.client.plugin("py-echo")
        self.assertEqual(plugin.endpoint, "memory://mem/py-echo")
        self.assertEqual(plugin.manifest_hash, self.server.manifest_hash)
        self.assertEqual(plugin.instances[0].max_concurrency, 2)
        events = []
        self.client.on_plugin(events.append)
        self.server.stop()
        self.wait_until(lambda: any(e.type == "withdrawn" for e in events), "the withdraw")
        self.assertEqual(self.client.plugin("py-echo").instances, [])
        with self.assertRaises(UndeliverableError) as caught:
            self.client.call("py-echo", "Health", {}, timeout_ms=500)
        self.assertEqual(caught.exception.reason, "no_consumers")

    def test_registry_proof_required(self):
        strict = MessagingClient(driver=self.broker.driver(), config=BrokerConfig("mem"), keyring=self.ring, stats_interval_ms=0, registry_secret="registry-s3cret")
        strict.start()
        try:
            proven = self.make_server(instance_id="proven", registry_secret="registry-s3cret")
            proven.start()
            try:
                self.wait_until(lambda: any(i.instance_id == "proven" for i in (strict.plugin("py-echo").instances if strict.plugin("py-echo") else [])), "the proven instance")
                time.sleep(0.3)  # the unproven server announced too (every 200 ms)
                self.assertEqual([i.instance_id for i in strict.plugin("py-echo").instances], ["proven"])
            finally:
                proven.stop()
        finally:
            strict.close()

    def test_tampered_and_foreign_requests_are_dropped(self):
        tamper = {"mode": None}

        def tap(channel: str, event: WireEvent):
            if channel.endswith("plugin.py-echo") and tamper["mode"] == "flip":
                body = bytearray(event.body)
                body[-1] ^= 1
                event.body = bytes(body)
            if channel.endswith("plugin.py-echo") and tamper["mode"] == "unsign":
                event.headers.pop("lfsig", None)
            return event

        self.broker.tap(tap)
        for mode in ("flip", "unsign"):
            tamper["mode"] = mode
            with self.assertRaises(TimeoutError_):
                self.client.call("py-echo", "Health", {}, timeout_ms=300)
        tamper["mode"] = None
        foreign = MessagingClient(driver=self.broker.driver(), config=BrokerConfig("mem"), keyring=Keyring("another"), stats_interval_ms=0, registry_secret=False, discovery=False)
        foreign.start()
        try:
            with self.assertRaises(TimeoutError_):
                foreign.call("py-echo", "Health", {}, timeout_ms=300)
        finally:
            foreign.close()
        self.assertEqual(self.server.counters["dropped"], 3)
        self.assertEqual(self.server.counters["dispatched"], 0)

    def test_too_large_before_publishing(self):
        with self.assertRaises(UndeliverableError) as caught:
            self.client.call("py-echo", "Execute", {**execute_request(), "parameters": {"blob": "x" * (2 * 1024 * 1024)}}, timeout_ms=1000)
        self.assertEqual(caught.exception.reason, "too_large")
        self.assertEqual(self.server.counters["received"], 0)

    def test_concurrency_limit_and_capacity(self):
        results: list = []

        def call():
            try:
                results.append(self.client.call("py-echo", "Execute", execute_request(delay=0.4), timeout_ms=5000))
            except Exception as exc:  # noqa: BLE001
                results.append(exc)

        threads = [threading.Thread(target=call, daemon=True) for _ in range(5)]
        for thread in threads:
            thread.start()
        time.sleep(0.15)
        self.assertLessEqual(self.dispatcher.in_flight, 2)
        self.assertEqual(self.server.in_flight_count, 2)
        for thread in threads:
            thread.join(10)
        self.assertEqual(len([r for r in results if isinstance(r, dict)]), 5, results)

    def test_brokered_calls_wait_for_a_slot_instead_of_capacity(self):
        """A dispatcher with no queue refuses direct calls at once with `capacity`, but a call from the broker face asks to
        wait (`wait=True`): the server already holds at most its prefetch, the rest waits in the broker."""
        tight = Dispatcher(self.plugin, 1, 0)
        server = self.make_server(instance_id="tight", max_concurrency=3, dispatch=messaging_dispatcher(tight, kind="memory"))
        server.start()
        try:
            results: list = []

            def call():
                try:
                    results.append(self.client.call("py-echo", "Execute", execute_request(delay=0.3), timeout_ms=5000, instance_id="tight"))
                except Exception as exc:  # noqa: BLE001
                    results.append(exc)

            threads = [threading.Thread(target=call, daemon=True) for _ in range(3)]
            for thread in threads:
                thread.start()
                time.sleep(0.05)
            self.wait_until(lambda: tight.in_flight == 1 and tight.waiting == 2, "two brokered calls waiting past max_queue")
            with self.assertRaises(OverloadedError):
                tight.execute(execute_request(), transport="http")
            for thread in threads:
                thread.join(10)
            self.assertEqual([getattr(r, "remote_code", "ok") for r in results], ["ok", "ok", "ok"])
        finally:
            server.stop()

    def test_instance_channel(self):
        second = self.make_server(instance_id="second")
        second.start()
        try:
            for _ in range(4):
                self.assertEqual(self.client.invoke("py-echo", "Health", {}, timeout_ms=5000, instance_id="second").instance_id, "second")
        finally:
            second.stop()

    def test_drain_waits_for_in_flight(self):
        box: dict = {}

        def run():
            box["reply"] = self.client.call("py-echo", "Execute", execute_request(delay=0.4), timeout_ms=5000)

        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        self.wait_until(lambda: self.server.in_flight_count == 1, "the call to start")
        self.server.stop()
        thread.join(5)
        self.assertIn("outputs", box.get("reply", {}))

    def test_fake_clock_expired_before_dispatch(self):
        clock = {"now": 1793102400000}
        ring = Keyring(VEC_SECRET)
        broker = MemoryBroker()
        calls: list = []
        server = MessagingServer(
            driver=broker.driver(), config=BrokerConfig("mem"), keyring=ring, plugin_id="clock", version="1", manifest_hash="0123456789abcdef",
            dispatch=lambda method, body, ctx: calls.append(method) or {"status": "ok"}, registry_secret=False, now=lambda: clock["now"],
            announce_interval_ms=60_000,
        )
        server.start()
        client = MessagingClient(driver=broker.driver(), config=BrokerConfig("mem"), keyring=ring, stats_interval_ms=0, registry_secret=False, now=lambda: clock["now"])
        client.start()
        try:
            codec = Codec(ring, broker.capabilities, now=lambda: clock["now"])
            attributes = codec.base("landflow://host/h1", "dev.landflow.plugin.v1.health.request", lfdeadline=str(clock["now"] - 1), lfreplyto=client.names.reply(client.host_instance_id))
            packed = codec.pack("clock", attributes, {}, True)
            client.driver.publish(server.names.request("clock"), packed.wire)
            time.sleep(0.2)
            self.assertEqual(calls, [])
            self.assertEqual(server.counters["expired"], 1)
            self.assertEqual(client.call("clock", "Health", {}, timeout_ms=5000), {"status": "ok"})
        finally:
            client.close()
            server.stop()


class BindingTest(unittest.TestCase):
    @unittest.skipUnless(HAVE_CRYPTO, "cryptography not installed")
    def test_binding_over_plugin_server(self):
        from landflow_sdk import PluginServer

        broker = MemoryBroker()
        plugin = make_plugin("bound")
        binding = MessagingBinding(BrokerTarget("memory", BrokerConfig("mem"), broker.driver), keyring=Keyring(VEC_SECRET), registry_secret=False, announce_interval_ms=200)
        server = PluginServer(plugin, http=False, announce=False, bindings=[binding], max_concurrency=3)
        server.start()
        try:
            self.assertEqual(server.transports, ["memory"])
            self.assertIsNotNone(binding.server)
            self.assertEqual(binding.server.max_concurrency, 3)
            client = MessagingClient(driver=broker.driver(), config=BrokerConfig("mem"), keyring=Keyring(VEC_SECRET), stats_interval_ms=0, registry_secret=False)
            client.start()
            try:
                reply = client.invoke("bound", "Execute", execute_request("bound"), timeout_ms=5000)
                self.assertEqual(reply.body["outputs"][0][0]["json"]["credential"], "top-secret")
                manifest = client.call("bound", "GetManifest", {}, timeout_ms=5000)
                self.assertEqual(manifest["transports"], ["memory"])
                self.assertEqual(manifest["maxConcurrency"], 3)
                self.assertEqual(manifest_hash_of(manifest), binding.server.manifest_hash)
            finally:
                client.close()
        finally:
            server.stop()
        self.assertIsNone(binding.server)

    def test_missing_secret_is_a_clear_error(self):
        from landflow_sdk import PluginServer
        from unittest import mock

        broker = MemoryBroker()
        binding = MessagingBinding(BrokerTarget("memory", BrokerConfig("mem"), broker.driver), registry_secret=False)
        server = PluginServer(make_plugin("nosecret"), http=False, announce=False, bindings=[binding])
        with mock.patch.dict("os.environ", {}, clear=False):
            for name in ("LANDFLOW_TRANSPORT_SECRET", "LANDFLOW_REGISTRY_SECRET"):
                import os

                os.environ.pop(name, None)
            with self.assertRaises(MissingSecretError):
                server.start()

    def test_native_driver_lookup(self):
        from landflow_sdk.transport import driver_available, load_driver, native_driver_kinds

        self.assertEqual(set(native_driver_kinds()), {"kafka", "amqp", "nats", "jetstream", "valkey"})
        self.assertIsNone(load_driver("mqtt"))
        self.assertIn("no native", driver_available("mqtt"))
        module = load_driver("nats")
        self.assertEqual(module.kind, "nats")
        self.assertEqual(load_driver("jetstream").capabilities.persistence, "disk")

    def test_env_targets(self):
        from landflow_sdk.transport import broker_target_from_env
        from landflow_sdk.transport.binding import connection_options_from_env

        self.assertIsNone(broker_target_from_env("kafka", {}))
        options = connection_options_from_env("amqp", {"LANDFLOW_AMQP_USERNAME": "u", "LANDFLOW_AMQP_PASSWORD": "p", "LANDFLOW_AMQP_TLS": "true", "LANDFLOW_AMQP_PREFIX": "acme", "LANDFLOW_AMQP_QUEUE_TYPE": "classic"})
        self.assertEqual(options, {"username": "u", "password": "p", "tls": True, "prefix": "acme", "queueType": "classic"})
        with self.assertRaisesRegex(RuntimeError, "no native Python driver"):
            broker_target_from_env("mqtt", {"LANDFLOW_MQTT_URL": "mqtt://127.0.0.1:1883"})
        from landflow_sdk.transport.drivers import driver_available

        if driver_available("nats") is None:
            target = broker_target_from_env("nats", {"LANDFLOW_NATS_URL": "nats://127.0.0.1:54222", "LANDFLOW_NATS_PREFIX": "acme"})
            self.assertEqual((target.kind, target.config.connection_id, target.config.prefix, target.config.servers), ("nats", "env-nats", "acme", ["127.0.0.1:54222"]))


if __name__ == "__main__":
    unittest.main()
