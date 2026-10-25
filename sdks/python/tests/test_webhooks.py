"""Webhook signature helpers, and app webhook triggers (WebhookMethod + ReceiveWebhook) in process, over HTTP and gRPC."""

from __future__ import annotations

import base64
import json
import threading
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from _support import LogCapture, builtin_telemetry, grpc_server

from landflow_sdk import (
    DescriptorError,
    Node,
    Plugin,
    ProtocolError,
    github_signature,
    hmac_sha256,
    slack_signature,
    stripe_signature,
    verify_github_signature,
    verify_hmac_sha256,
    verify_slack_signature,
    verify_stripe_signature,
)
from landflow_sdk.http_server import HttpPluginServer
from landflow_sdk.protocol import PROTOCOL_VERSION

SECRET = "It's a Secret to Everybody"
BODY = "Hello, World!"


class SignatureTests(unittest.TestCase):
    def test_github_documented_example(self):
        # https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
        expected = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17"
        self.assertEqual(github_signature(SECRET, BODY), expected)
        self.assertTrue(verify_github_signature(SECRET, BODY, expected))
        self.assertTrue(verify_github_signature(SECRET, BODY.encode(), "sha256=" + expected[7:].upper()))
        self.assertFalse(verify_github_signature(SECRET, BODY + " ", expected))
        self.assertFalse(verify_github_signature("other", BODY, expected))
        self.assertFalse(verify_github_signature(SECRET, BODY, expected[7:]))
        self.assertFalse(verify_github_signature(SECRET, BODY, None))
        self.assertFalse(verify_github_signature("", BODY, github_signature("", BODY)))

    def test_plain_and_base64(self):
        self.assertTrue(verify_hmac_sha256("k", "p", hmac_sha256("k", "p")))
        self.assertTrue(verify_hmac_sha256("k", "p", hmac_sha256("k", "p", "base64"), encoding="base64"))
        self.assertFalse(verify_hmac_sha256("k", "p", hmac_sha256("k", "q")))

    def test_stripe_within_tolerance(self):
        now = 1_760_000_000
        header = stripe_signature("whsec_test", BODY, now)
        self.assertRegex(header, r"^t=\d+,v1=[0-9a-f]{64}$")
        self.assertTrue(verify_stripe_signature("whsec_test", BODY, header, now=now))
        self.assertTrue(verify_stripe_signature("whsec_test", BODY, header + ",v1=" + "0" * 64, now=now))
        self.assertFalse(verify_stripe_signature("whsec_test", BODY + "!", header, now=now))
        self.assertFalse(verify_stripe_signature("whsec_test", BODY, header, now=now + 301))
        self.assertTrue(verify_stripe_signature("whsec_test", BODY, header, now=now + 301, tolerance_seconds=600))
        self.assertFalse(verify_stripe_signature("whsec_test", BODY, "v1=" + header.split("v1=")[1], now=now))
        self.assertFalse(verify_stripe_signature("whsec_test", BODY, "garbage", now=now))

    def test_slack_within_tolerance(self):
        now = 1_531_420_618
        ts = "1531420618"
        body = "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&command=%2Fweather"
        signature = slack_signature("8f742231b10e8888abcd99yyyzzz85a5", body, ts)
        self.assertRegex(signature, r"^v0=[0-9a-f]{64}$")
        self.assertTrue(verify_slack_signature("8f742231b10e8888abcd99yyyzzz85a5", body, ts, signature, now=now))
        self.assertFalse(verify_slack_signature("8f742231b10e8888abcd99yyyzzz85a5", body, ts, signature, now=now + 600))
        self.assertFalse(verify_slack_signature("8f742231b10e8888abcd99yyyzzz85a5", body, "1531420619", signature, now=now))
        self.assertFalse(verify_slack_signature("wrong", body, ts, signature, now=now))


# ---- A fake service with a hooks API ---------------------------------------


class HookService:
    """``POST /hooks`` -> 201 {id, url, secret}; ``GET|DELETE /hooks/<id>`` -> 200/204 or 404."""

    def __init__(self) -> None:
        self.hooks: dict[str, dict] = {}
        self.next_id = 1
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def _send(self, status: int, payload: object = None) -> None:
                data = b"" if payload is None else json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_POST(self) -> None:  # noqa: N802
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                if self.path != "/hooks":
                    return self._send(404, {"message": "Not Found"})
                hook = {"id": f"h{outer.next_id}", "url": body["url"], "secret": body["secret"]}
                outer.next_id += 1
                outer.hooks[hook["id"]] = hook
                self._send(201, hook)

            def do_GET(self) -> None:  # noqa: N802
                hook = outer.hooks.get(self.path.rsplit("/", 1)[-1])
                self._send(200, hook) if hook else self._send(404, {"message": "Not Found"})

            def do_DELETE(self) -> None:  # noqa: N802
                existed = outer.hooks.pop(self.path.rsplit("/", 1)[-1], None)
                self._send(204) if existed else self._send(404, {"message": "Not Found"})

            def log_message(self, *args: object) -> None:
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


SERVICE: HookService | None = None


class HookTrigger(Node):
    description = {
        "name": "hookTrigger",
        "displayName": "Hook Trigger",
        "version": 1,
        "kind": "trigger",
        "triggerSource": "appWebhook",
        "inputs": [],
        "outputs": [{"type": "main"}],
        "properties": [{"name": "events", "displayName": "Events", "type": "string", "default": "push"}],
    }

    def execute(self, ctx):
        return []

    def webhook_check_exists(self, ctx):
        hook_id = ctx.get_static_data().get("hookId")
        return bool(hook_id) and ctx.http.get(f"{SERVICE.url}/hooks/{hook_id}").status == 200

    def webhook_create(self, ctx):
        secret = f"s-{SERVICE.next_id}"
        response = ctx.http.post(f"{SERVICE.url}/hooks", json={"url": ctx.get_webhook_url(), "secret": secret, "events": ctx.get_node_parameter("events")})
        if response.status != 201:
            return False
        ctx.logger.info("hook created")
        ctx.get_static_data().update(hookId=response.json["id"], secret=secret)
        return None

    def webhook_delete(self, ctx):
        hook_id = ctx.get_static_data().get("hookId")
        if hook_id:
            ctx.http.delete(f"{SERVICE.url}/hooks/{hook_id}")
        ctx.set_static_data({})

    def webhook(self, ctx):
        secret = str(ctx.get_static_data().get("secret") or "")
        if not verify_github_signature(secret, ctx.get_raw_body(), ctx.get_header("X-Hub-Signature-256")):
            return {"response": {"status": 401, "json": {"error": "bad signature"}}}
        body = ctx.get_body()
        if body.get("zen"):
            return {"response": {"status": 200, "body": "pong"}}
        ctx.get_static_data()["lastDelivery"] = ctx.get_header("x-delivery")
        return {"items": [{"event": ctx.get_header("x-event") or "unknown", "body": body}], "idempotencyKey": ctx.get_header("x-delivery")}


class FailingTrigger(HookTrigger):
    description = {**HookTrigger.description, "name": "failingTrigger", "displayName": "Failing Trigger"}

    def webhook_create(self, ctx):
        return False

    def webhook_delete(self, ctx):
        raise RuntimeError("service down")


class Action(Node):
    description = {"name": "action", "displayName": "Action", "version": 1, "kind": "action", "inputs": [{"type": "main"}], "outputs": [{"type": "main"}]}

    def execute(self, ctx):
        return ctx.get_input_data()


def make_plugin() -> Plugin:
    return Plugin("hooks", "Hooks", "1.0.0", nodes=[HookTrigger(), FailingTrigger(), Action()], telemetry=builtin_telemetry("hooks"))


def method_request(method: str, static_data: dict, node: str = "hookTrigger") -> dict:
    return {
        "protocol": PROTOCOL_VERSION,
        "method": method,
        "workflowId": "wf1",
        "node": {"id": "n1", "name": "Hook", "type": f"hooks.{node}", "typeVersion": 1},
        "parameters": {},
        "webhookUrl": "https://landflow.example/api/webhook/app/wf1/n1",
        "staticData": static_data,
    }


def webhook_request(static_data: dict, body: str, headers: dict) -> dict:
    return {
        "protocol": PROTOCOL_VERSION,
        "workflowId": "wf1",
        "node": {"id": "n1", "name": "Hook", "type": "hooks.hookTrigger", "typeVersion": 1},
        "parameters": {},
        "webhookUrl": "https://landflow.example/api/webhook/app/wf1/n1",
        "staticData": static_data,
        "request": {"method": "POST", "path": "/api/webhook/app/wf1/n1", "headers": headers, "query": {}, "body": base64.b64encode(body.encode()).decode()},
    }


class LifecycleMixin:
    """The full lifecycle against one transport: ``self.method(request)`` and ``self.webhook(request)``."""

    def method(self, request: dict) -> dict:  # pragma: no cover - overridden
        raise NotImplementedError

    def webhook(self, request: dict) -> dict:  # pragma: no cover - overridden
        raise NotImplementedError

    def test_lifecycle(self):
        self.assertEqual(self.method(method_request("checkExists", {})).get("exists", False), False)
        created = self.method(method_request("create", {}))
        self.assertNotIn("error", created)
        static = created["staticData"]
        self.assertIn(static["hookId"], SERVICE.hooks)
        self.assertEqual(SERVICE.hooks[static["hookId"]]["url"], "https://landflow.example/api/webhook/app/wf1/n1")
        self.assertEqual(created["logs"], [{"level": "info", "message": "hook created"}])
        self.assertIs(self.method(method_request("checkExists", static)).get("exists"), True)

        body = json.dumps({"action": "opened", "number": 7})
        signed = {"content-type": "application/json", "x-hub-signature-256": github_signature(static["secret"], body), "x-event": "issues", "x-delivery": "d-1"}
        received = self.webhook(webhook_request(static, body, signed))
        self.assertEqual(received["items"], [{"json": {"event": "issues", "body": {"action": "opened", "number": 7}}}])
        self.assertEqual(received["idempotencyKey"], "d-1")
        self.assertEqual(received["staticData"], {**static, "lastDelivery": "d-1"})
        self.assertNotIn("response", received)

        bad = self.webhook(webhook_request(static, body, {**signed, "x-hub-signature-256": "sha256=" + "0" * 64}))
        self.assertNotIn("items", bad)
        self.assertEqual(bad["response"]["status"], 401)
        self.assertEqual(json.loads(bad["response"]["body"]), {"error": "bad signature"})
        self.assertEqual(bad["response"]["headers"]["content-type"], "application/json; charset=utf-8")
        self.assertNotIn("staticData", bad)

        ping_body = json.dumps({"zen": "Keep it logically awesome."})
        ping = self.webhook(webhook_request(static, ping_body, {**signed, "x-hub-signature-256": github_signature(static["secret"], ping_body)}))
        self.assertNotIn("items", ping)
        self.assertEqual(ping["response"], {"status": 200, "body": "pong"})

        deleted = self.method(method_request("delete", static))
        self.assertNotIn("error", deleted)
        self.assertEqual(deleted["staticData"], {})
        self.assertNotIn(static["hookId"], SERVICE.hooks)
        self.assertEqual(self.method(method_request("checkExists", static)).get("exists", False), False)

    def test_failures_come_back_as_errors(self):
        self.assertEqual(self.method(method_request("create", {}, "failingTrigger"))["error"]["message"], "The webhook could not be registered")
        self.assertEqual(self.method(method_request("delete", {}, "failingTrigger"))["error"]["message"], "service down")
        self.assertIn("not an app webhook trigger", self.method(method_request("create", {}, "action"))["error"]["message"])


class InProcessTests(LifecycleMixin, unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        global SERVICE
        SERVICE = HookService()
        cls.plugin = make_plugin()

    @classmethod
    def tearDownClass(cls):
        SERVICE.close()

    def method(self, request):
        return self.plugin.webhook_method(request)

    def webhook(self, request):
        return self.plugin.receive_webhook(request)

    def test_spans(self):
        with LogCapture() as logs:
            self.plugin.webhook_method(method_request("checkExists", {}))
            self.plugin.receive_webhook(webhook_request({}, "{}", {}))
        self.assertEqual(logs.span("plugin.webhook_method checkExists")["attributes"]["landflow.webhook.method"], "checkExists")
        self.assertEqual(logs.span("plugin.webhook hooks.hookTrigger")["attributes"]["http.response.status_code"], 401)

    def test_malformed_requests(self):
        with self.assertRaises(ProtocolError):
            self.plugin.webhook_method({**method_request("create", {}), "method": "rename"})
        with self.assertRaises(ProtocolError):
            self.plugin.receive_webhook({**webhook_request({}, "{}", {}), "request": None})
        with self.assertRaises(ProtocolError):
            self.plugin.receive_webhook(webhook_request({}, "{}", {}) | {"request": {"body": "%%%"}})

    def test_descriptor_validation(self):
        class Incomplete(Node):
            description = {**HookTrigger.description, "name": "incomplete"}

            def execute(self, ctx):
                return []

        with self.assertRaisesRegex(DescriptorError, "webhook_create, webhook_delete, webhook"):
            Plugin("hooks", "Hooks", "1.0.0", nodes=[Incomplete()])

        class NotATrigger(HookTrigger):
            description = {**HookTrigger.description, "name": "notATrigger", "kind": "action"}

        with self.assertRaisesRegex(DescriptorError, "needs kind 'trigger'"):
            Plugin("hooks", "Hooks", "1.0.0", nodes=[NotATrigger()])

    def test_well_known_lists_webhook_endpoints(self):
        endpoints = self.plugin.well_known()["endpoints"]
        self.assertEqual(endpoints["webhookMethod"], "/landflow/v1/webhook-method")
        self.assertEqual(endpoints["webhook"], "/landflow/v1/webhook")
        plain = Plugin("plain", "Plain", "1.0.0", nodes=[Action()], telemetry=builtin_telemetry("plain"))
        self.assertNotIn("webhook", plain.well_known()["endpoints"])

    def test_form_and_text_bodies(self):
        from landflow_sdk.webhooks import _parse_body

        self.assertEqual(_parse_body(b'payload=%7B%22a%22%3A1%7D', "application/x-www-form-urlencoded"), {"a": 1})
        self.assertEqual(_parse_body(b"a=1&b=", "application/x-www-form-urlencoded"), {"a": "1", "b": ""})
        self.assertEqual(_parse_body(b'{"a":1}', ""), {"a": 1})
        self.assertEqual(_parse_body(b"hello", "text/plain"), "hello")
        self.assertEqual(_parse_body(b"", "application/json"), {})


class HttpTests(LifecycleMixin, unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        global SERVICE
        SERVICE = HookService()
        cls.server = HttpPluginServer(make_plugin(), "127.0.0.1", 0)
        cls.server.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.stop()
        SERVICE.close()

    def _post(self, path: str, payload: dict) -> dict:
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.server.port}{path}", data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}, method="POST"
        )
        with urllib.request.urlopen(request, timeout=5) as response:
            return json.loads(response.read())

    def method(self, request):
        return self._post("/landflow/v1/webhook-method", request)

    def webhook(self, request):
        return self._post("/landflow/v1/webhook", request)


@unittest.skipIf(grpc_server is None, "grpc extra not installed")
class GrpcTests(LifecycleMixin, unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import grpc

        from landflow_sdk._pb import plugin_pb2_grpc as pb_grpc

        global SERVICE
        SERVICE = HookService()
        cls.server = grpc_server.GrpcPluginServer(make_plugin(), "127.0.0.1", 0)
        cls.server.start()
        cls.channel = grpc.insecure_channel(f"127.0.0.1:{cls.server.port}")
        cls.stub = pb_grpc.PluginServiceStub(cls.channel)

    @classmethod
    def tearDownClass(cls):
        cls.channel.close()
        cls.server.stop()
        SERVICE.close()

    def method(self, request):
        msg = self.stub.WebhookMethod(grpc_server.webhook_method_request_to_proto(request), timeout=5)
        return grpc_server.webhook_method_response_from_proto(msg)

    def webhook(self, request):
        msg = self.stub.ReceiveWebhook(grpc_server.webhook_request_to_proto(request), timeout=5)
        return grpc_server.webhook_response_from_proto(msg)


if __name__ == "__main__":
    unittest.main()
