"""Stripe Trigger: the webhook endpoint lifecycle against a fake Stripe API, signed events, in process, over HTTP and gRPC."""

from __future__ import annotations

import base64
import json
import time
import unittest
from urllib.parse import parse_qs

from _support import FakeApi, execute, make_plugin, metric_value
from _webhook_transports import Direct, Grpc, Http, grpc_server

from landflow_sdk import stripe_signature

KEY = "sk_test_4eC39HqLyjWDarjtT1zdp7dc"
URL = "https://landflow.example/api/webhook/app/wf_test/n1"
SECRET = "whsec_" + "a1" * 16


class FakeStripe:
    """Stripe's webhook endpoints API on a FakeApi: create (form encoded, returns the secret once), get, delete; and /v1/balance."""

    def __init__(self, api: FakeApi) -> None:
        self.api = api
        self.endpoints: dict[str, dict] = {}
        self.forms: list[dict[str, list[str]]] = []
        self.next_id = 1
        api.route("GET", "/v1/balance", lambda r: self._auth(r) or {"object": "balance", "livemode": False, "available": []})
        api.route("POST", "/v1/webhook_endpoints", self._create)
        api.route("GET", r"/v1/webhook_endpoints/(we_\w+)", self._get)
        api.route("DELETE", r"/v1/webhook_endpoints/(we_\w+)", self._delete)

    @staticmethod
    def _auth(record: dict):
        if record["headers"].get("authorization") != f"Bearer {KEY}":
            return 401, {"error": {"type": "invalid_request_error", "message": "Invalid API Key provided: sk_test_****wrong"}}
        return None

    def _create(self, record: dict):
        denied = self._auth(record)
        if denied:
            return denied
        assert record["headers"]["content-type"] == "application/x-www-form-urlencoded"
        form = parse_qs(record["body"].decode())
        self.forms.append(form)
        endpoint = {"id": f"we_{self.next_id:03d}", "object": "webhook_endpoint", "url": form["url"][0], "status": "enabled",
                    "enabled_events": form["enabled_events[]"], "description": form.get("description", [None])[0],
                    "livemode": False, "secret": SECRET, "api_version": None}
        self.next_id += 1
        self.endpoints[endpoint["id"]] = endpoint
        return 200, endpoint

    def _get(self, record: dict):
        endpoint = self.endpoints.get(record["path"].rsplit("/", 1)[1])
        if not endpoint:
            return 404, {"error": {"type": "invalid_request_error", "code": "resource_missing", "message": "No such webhook endpoint"}}
        return {k: v for k, v in endpoint.items() if k != "secret"}  # the secret is only returned on creation

    def _delete(self, record: dict):
        eid = record["path"].rsplit("/", 1)[1]
        if self.endpoints.pop(eid, None) is None:
            return 404, {"error": {"type": "invalid_request_error", "code": "resource_missing", "message": "No such webhook endpoint"}}
        return {"id": eid, "object": "webhook_endpoint", "deleted": True}


def method_request(method: str, static: dict, base_url: str, parameters: dict | None = None, key: str = KEY) -> dict:
    return {
        "protocol": "landflow.plugin/v1", "method": method, "workflowId": "wf_test",
        "node": {"id": "n1", "name": "Stripe", "type": "productivity.stripeWebhookTrigger", "typeVersion": 1},
        "parameters": {"events": ["invoice.paid", "charge.succeeded"], **(parameters or {})},
        "credentials": {"stripeApi": {"apiKey": key, "baseUrl": base_url}},
        "webhookUrl": URL, "staticData": static,
    }


def event(event_type: str = "invoice.paid", event_id: str = "evt_1", **extra) -> dict:
    return {"id": event_id, "object": "event", "api_version": "2024-06-20", "created": 1_760_000_000, "livemode": False,
            "type": event_type, "data": {"object": {"id": "in_1", "object": "invoice", "amount_paid": 2000}},
            "request": {"id": "req_1", "idempotency_key": None}, "pending_webhooks": 1, **extra}


def delivery(static: dict, payload: dict, *, header: str | None = None, timestamp: int | None = None, parameters: dict | None = None) -> dict:
    raw = json.dumps(payload, separators=(",", ":")).encode()
    headers = {"content-type": "application/json; charset=utf-8", "user-agent": "Stripe/1.0 (+https://stripe.com/docs/webhooks)",
               "stripe-signature": header if header is not None else stripe_signature(static.get("webhookSecret", ""), raw, timestamp)}
    return {
        "protocol": "landflow.plugin/v1", "workflowId": "wf_test",
        "node": {"id": "n1", "name": "Stripe", "type": "productivity.stripeWebhookTrigger", "typeVersion": 1},
        "parameters": {"events": ["invoice.paid", "charge.succeeded"], **(parameters or {})},
        "webhookUrl": URL, "staticData": static,
        "request": {"method": "POST", "path": "/api/webhook/app/wf_test/n1", "headers": headers, "query": {}, "body": base64.b64encode(raw).decode()},
    }


class LifecycleMixin:
    transport: object

    def setUp(self):
        self.api = FakeApi().__enter__()
        self.stripe = FakeStripe(self.api)

    def tearDown(self):
        self.api.__exit__()

    def test_publish_deliver_unpublish(self):
        t = self.transport
        self.assertNotEqual(t.method(method_request("checkExists", {}, self.api.url)).get("exists"), True)

        created = t.method(method_request("create", {}, self.api.url))
        self.assertNotIn("error", created)
        static = created["staticData"]
        self.assertEqual(static, {"webhookId": "we_001", "webhookSecret": SECRET, "webhookEvents": ["charge.succeeded", "invoice.paid"], "connect": False})
        form = self.stripe.forms[0]
        self.assertEqual((form["url"], form["enabled_events[]"], form["description"]), ([URL], ["charge.succeeded", "invoice.paid"], ["Landflow workflow wf_test"]))
        self.assertNotIn("connect", form)
        self.assertEqual(self.api.calls("POST", "/v1/webhook_endpoints")[0]["headers"]["authorization"], f"Bearer {KEY}")
        self.assertIs(t.method(method_request("checkExists", static, self.api.url)).get("exists"), True)

        # Changed events, a disabled endpoint, another URL or a deleted endpoint: not the registered one any more.
        self.assertNotEqual(t.method(method_request("checkExists", static, self.api.url, {"events": ["charge.failed"]})).get("exists"), True)
        self.stripe.endpoints["we_001"]["status"] = "disabled"
        self.assertNotEqual(t.method(method_request("checkExists", static, self.api.url)).get("exists"), True)
        self.stripe.endpoints["we_001"]["status"] = "enabled"
        self.stripe.endpoints["we_001"]["url"] = "https://old.example/hook"
        self.assertNotEqual(t.method(method_request("checkExists", static, self.api.url)).get("exists"), True)
        self.stripe.endpoints["we_001"]["url"] = URL
        self.assertIs(t.method(method_request("checkExists", static, self.api.url)).get("exists"), True)

        received = t.webhook(delivery(static, event()))
        self.assertNotIn("error", received)
        self.assertEqual(received["idempotencyKey"], "evt_1")
        item = received["items"][0]["json"]
        self.assertEqual((item["id"], item["type"], item["created"], item["livemode"], item["apiVersion"]), ("evt_1", "invoice.paid", 1_760_000_000, False, "2024-06-20"))
        self.assertEqual(item["data"]["object"]["amount_paid"], 2000)
        self.assertEqual(item["request"]["id"], "req_1")
        self.assertEqual(item["body"]["id"], "evt_1")
        self.assertNotIn("account", item)
        self.assertNotIn("staticData", received)

        forged = t.webhook(delivery(static, event(), header=stripe_signature("whsec_other", json.dumps(event(), separators=(",", ":")))))
        self.assertNotIn("items", forged)
        self.assertEqual(forged["response"]["status"], 401)
        self.assertEqual(t.webhook(delivery(static, event(), header=""))["response"]["status"], 401)
        stale = t.webhook(delivery(static, event(), timestamp=int(time.time()) - 3600))
        self.assertEqual(stale["response"]["status"], 401)
        # An option widens the tolerance.
        lenient = t.webhook(delivery(static, event(), timestamp=int(time.time()) - 3600, parameters={"options": {"tolerance": 7200}}))
        self.assertEqual(len(lenient["items"]), 1)
        strict = t.webhook(delivery(static, event(), timestamp=int(time.time()) - 30, parameters={"options": {"tolerance": 10}}))
        self.assertEqual(strict["response"]["status"], 401)

        other = t.webhook(delivery(static, event("customer.created", "evt_2")))
        self.assertNotIn("items", other)
        self.assertEqual(json.loads(other["response"]["body"]), {"ignored": "customer.created"})
        self.assertEqual(t.webhook(delivery(static, {"hello": "world"}))["response"]["status"], 400)
        # No stored secret (never registered): nothing verifies.
        self.assertEqual(t.webhook(delivery({}, event(), header=stripe_signature("", "x")))["response"]["status"], 401)

        deleted = t.method(method_request("delete", static, self.api.url))
        self.assertNotIn("error", deleted)
        self.assertEqual(deleted["staticData"], {})
        self.assertEqual(self.stripe.endpoints, {})
        self.assertNotIn("error", t.method(method_request("delete", static, self.api.url)))  # already gone

    def test_any_event_additional_events_and_connect(self):
        t = self.transport
        created = t.method(method_request("create", {}, self.api.url, {"events": ["charge.failed"], "additionalEvents": " invoice.upcoming, charge.failed ",
                                                                            "options": {"connect": True}}))
        self.assertEqual(created["staticData"]["webhookEvents"], ["charge.failed", "invoice.upcoming"])
        self.assertTrue(created["staticData"]["connect"])
        self.assertEqual(self.stripe.forms[0]["connect"], ["true"])
        static = created["staticData"]
        connected = t.webhook(delivery(static, event("invoice.upcoming", "evt_c", account="acct_123")))
        self.assertEqual(connected["items"][0]["json"]["account"], "acct_123")

        everything = t.method(method_request("create", {}, self.api.url, {"events": ["payout.paid", "*"]}))["staticData"]
        self.assertEqual(everything["webhookEvents"], ["*"])
        self.assertEqual(self.stripe.forms[1]["enabled_events[]"], ["*"])
        self.assertEqual(len(t.webhook(delivery(everything, event("anything.at_all", "evt_9")))["items"]), 1)

    def test_failures_are_reported(self):
        t = self.transport
        wrong_key = t.method(method_request("create", {}, self.api.url, key="sk_test_wrong"))
        self.assertIn("HTTP 401", wrong_key["error"]["message"])
        self.assertNotIn("staticData", wrong_key)
        none = t.method(method_request("create", {}, self.api.url, {"events": [], "additionalEvents": ""}))
        self.assertIn("at least one event", none["error"]["message"])
        self.api.route("POST", "/v1/webhook_endpoints", (403, {"error": {"type": "invalid_request_error", "message": "This API call cannot be made with a restricted key"}}))
        denied = t.method(method_request("create", {}, self.api.url))
        self.assertIn("cannot create webhook endpoints", denied["error"]["message"])
        self.assertIn("Webhook Endpoints", denied["error"].get("description", ""))


class InProcessTests(LifecycleMixin, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.plugin = make_plugin()
        self.transport = Direct(self.plugin)

    def test_metrics_credential_test_and_manual_run(self):
        static = self.transport.method(method_request("create", {}, self.api.url))["staticData"]
        self.transport.webhook(delivery(static, event()))
        self.assertEqual(metric_value(self.plugin, "landflow.productivity.records_written", service="stripe", operation="webhook.create"), 1)
        self.assertEqual(metric_value(self.plugin, "landflow.productivity.poll.new_items", trigger="stripeWebhook"), 1)
        self.assertEqual(self.plugin.test_credentials("stripeApi", {"apiKey": KEY, "baseUrl": self.api.url}), {"ok": True, "message": "authenticated (test mode)"})
        bad = self.plugin.test_credentials("stripeApi", {"apiKey": "sk_test_wrong", "baseUrl": self.api.url})
        self.assertFalse(bad["ok"])
        self.assertIn("Invalid API Key", bad["message"])
        self.assertNotIn("sk_test_wrong", json.dumps(bad))
        self.api.requests.clear()
        self.plugin.test_credentials("stripeApi", {"apiKey": KEY, "baseUrl": self.api.url, "stripeVersion": "2024-06-20"})
        self.assertEqual(self.api.requests[0]["headers"]["stripe-version"], "2024-06-20")
        manual = execute(self.plugin, "stripeWebhookTrigger", {"events": ["invoice.paid"]}, credentials={"stripeApi": {"apiKey": KEY, "baseUrl": self.api.url}})
        self.assertEqual(manual["outputs"], [[]])
        self.assertIn("manual run", manual["logs"][0]["message"])


class HttpTests(LifecycleMixin, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.transport = Http(self, make_plugin())


@unittest.skipIf(grpc_server is None, "grpc extra not installed")
class GrpcTests(LifecycleMixin, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.transport = Grpc(self, make_plugin())


if __name__ == "__main__":
    unittest.main()
