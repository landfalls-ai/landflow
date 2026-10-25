"""GitHub Webhook Trigger: the hook lifecycle against a fake GitHub API, signed deliveries, in process, over HTTP and gRPC."""

from __future__ import annotations

import base64
import json
import unittest
import urllib.request

from _support import TOKEN, FakeApi, make_plugin, metric_value

from landflow_sdk import github_signature
from landflow_sdk.http_server import HttpPluginServer

try:
    from landflow_sdk import grpc_server
except Exception:  # noqa: BLE001 - grpc extra not installed
    grpc_server = None

REPO = "/repos/octo/demo"
URL = "https://landflow.example/api/webhook/app/wf_test/n1"


class FakeHooks:
    """GitHub's repository hooks endpoints on a FakeApi: create (422 for a duplicate URL), get, list, delete."""

    def __init__(self, api: FakeApi) -> None:
        self.api = api
        self.hooks: dict[int, dict] = {}
        self.next_id = 100
        api.route("POST", f"{REPO}/hooks", self._create)
        api.route("GET", f"{REPO}/hooks", lambda r: list(self.hooks.values()))
        api.route("GET", rf"{REPO}/hooks/(\d+)", lambda r: self.hooks.get(self._id(r)) or (404, {"message": "Not Found"}))
        api.route("DELETE", rf"{REPO}/hooks/(\d+)", lambda r: (204, b"") if self.hooks.pop(self._id(r), None) else (404, {"message": "Not Found"}))

    @staticmethod
    def _id(record: dict) -> int:
        return int(record["path"].rsplit("/", 1)[1])

    def _create(self, record: dict):
        body = record["json"]
        if any(h["config"]["url"] == body["config"]["url"] for h in self.hooks.values()):
            return 422, {"message": "Validation Failed", "errors": [{"resource": "Hook", "code": "custom", "message": "Hook already exists on this repository"}]}
        hook = {"id": self.next_id, "name": "web", "active": body["active"], "events": body["events"],
                "config": {k: v for k, v in body["config"].items() if k != "secret"} | {"secret": "********"}}
        self.next_id += 1
        self.hooks[hook["id"]] = hook
        return 201, hook


def method_request(method: str, static: dict, creds: dict, parameters: dict | None = None) -> dict:
    return {
        "protocol": "landflow.plugin/v1",
        "method": method,
        "workflowId": "wf_test",
        "node": {"id": "n1", "name": "GitHub", "type": "productivity.githubWebhookTrigger", "typeVersion": 1},
        "parameters": {"owner": "octo", "repository": "demo", "events": ["issues", "push"], **(parameters or {})},
        "credentials": creds,
        "webhookUrl": URL,
        "staticData": static,
    }


def delivery(static: dict, event: str, payload: dict, *, delivery_id: str = "72d3162e-cc78-11e3-81ab-4c9367dc0958", signature: str | None = None) -> dict:
    raw = json.dumps(payload).encode()
    headers = {
        "content-type": "application/json",
        "user-agent": "GitHub-Hookshot/044aadd",
        "x-github-event": event,
        "x-github-delivery": delivery_id,
        "x-github-hook-id": str(static.get("webhookId", "")),
        "x-hub-signature-256": signature if signature is not None else github_signature(static.get("webhookSecret", ""), raw),
    }
    return {
        "protocol": "landflow.plugin/v1",
        "workflowId": "wf_test",
        "node": {"id": "n1", "name": "GitHub", "type": "productivity.githubWebhookTrigger", "typeVersion": 1},
        "parameters": {"owner": "octo", "repository": "demo", "events": ["issues", "push"]},
        "webhookUrl": URL,
        "staticData": static,
        "request": {"method": "POST", "path": "/api/webhook/app/wf_test/n1", "headers": headers, "query": {}, "body": base64.b64encode(raw).decode()},
    }


class Transport:
    def method(self, request: dict) -> dict:  # pragma: no cover - overridden
        raise NotImplementedError

    def webhook(self, request: dict) -> dict:  # pragma: no cover - overridden
        raise NotImplementedError


class LifecycleMixin:
    plugin = None
    transport: Transport

    def setUp(self):
        self.api = FakeApi().__enter__()
        self.hooks = FakeHooks(self.api)
        self.creds = {"githubApi": {"accessToken": TOKEN, "baseUrl": self.api.url}}

    def tearDown(self):
        self.api.__exit__()

    def test_publish_deliver_unpublish(self):
        t = self.transport
        self.assertNotEqual(t.method(method_request("checkExists", {}, self.creds)).get("exists"), True)

        created = t.method(method_request("create", {}, self.creds))
        self.assertNotIn("error", created)
        static = created["staticData"]
        self.assertEqual(static["webhookEvents"], ["issues", "push"])
        self.assertEqual(len(static["webhookSecret"]), 64)
        sent = self.api.calls("POST", f"{REPO}/hooks")[0]
        self.assertEqual(sent["headers"]["authorization"], f"Bearer {TOKEN}")
        self.assertEqual(sent["json"], {"name": "web", "active": True, "events": ["issues", "push"],
                                        "config": {"url": URL, "content_type": "json", "secret": static["webhookSecret"], "insecure_ssl": "0"}})
        self.assertIn(static["webhookId"], self.hooks.hooks)
        self.assertIs(t.method(method_request("checkExists", static, self.creds)).get("exists"), True)

        # The hook was registered for another URL (the public URL changed): not ours any more.
        self.hooks.hooks[static["webhookId"]]["config"]["url"] = "https://old.example/hook"
        self.assertNotEqual(t.method(method_request("checkExists", static, self.creds)).get("exists"), True)
        self.hooks.hooks[static["webhookId"]]["config"]["url"] = URL

        ping = t.webhook(delivery(static, "ping", {"zen": "Design for failure.", "hook_id": static["webhookId"]}))
        self.assertNotIn("items", ping)
        self.assertEqual(ping["response"]["status"], 200)

        issue = {"action": "opened", "issue": {"number": 7, "title": "Bug"}, "repository": {"full_name": "octo/demo"}}
        received = t.webhook(delivery(static, "issues", issue))
        self.assertNotIn("error", received)
        self.assertEqual(received["idempotencyKey"], "72d3162e-cc78-11e3-81ab-4c9367dc0958")
        item = received["items"][0]["json"]
        self.assertEqual((item["event"], item["action"], item["deliveryId"], item["body"]), ("issues", "opened", "72d3162e-cc78-11e3-81ab-4c9367dc0958", issue))
        self.assertEqual(item["headers"]["x-github-hook-id"], str(static["webhookId"]))
        self.assertNotIn("x-hub-signature-256", item["headers"])
        self.assertNotIn("staticData", received)

        forged = t.webhook(delivery(static, "issues", issue, signature=github_signature("not-the-secret", json.dumps(issue))))
        self.assertNotIn("items", forged)
        self.assertEqual(forged["response"]["status"], 401)
        unsigned = t.webhook(delivery(static, "issues", issue, signature=""))
        self.assertEqual(unsigned["response"]["status"], 401)

        other = t.webhook(delivery(static, "star", {"action": "created"}))
        self.assertNotIn("items", other)
        self.assertEqual(other["response"]["status"], 202)

        deleted = t.method(method_request("delete", static, self.creds))
        self.assertNotIn("error", deleted)
        self.assertEqual(deleted["staticData"], {})
        self.assertEqual(self.hooks.hooks, {})
        # Deleting a hook that is already gone is fine.
        again = t.method(method_request("delete", static, self.creds))
        self.assertNotIn("error", again)

    def test_existing_hook_for_the_url_is_replaced(self):
        first = self.transport.method(method_request("create", {}, self.creds))["staticData"]
        second = self.transport.method(method_request("create", {}, self.creds, {"events": ["*"], "options": {"insecureSsl": True}}))
        self.assertNotIn("error", second)
        static = second["staticData"]
        self.assertNotEqual(static["webhookId"], first["webhookId"])
        self.assertEqual(list(self.hooks.hooks), [static["webhookId"]])
        self.assertEqual(self.hooks.hooks[static["webhookId"]]["events"], ["*"])
        self.assertEqual(self.api.calls("POST", f"{REPO}/hooks")[-1]["json"]["config"]["insecure_ssl"], "1")
        self.assertEqual(len(self.api.calls("DELETE", rf"{REPO}/hooks/\d+")), 1)

    def test_create_without_permission_explains(self):
        self.api.route("POST", f"{REPO}/hooks", (404, {"message": "Not Found"}))
        failed = self.transport.method(method_request("create", {}, self.creds))
        self.assertIn("cannot manage its webhooks", failed["error"]["message"])
        self.assertIn("admin:repo_hook", failed["error"].get("description", ""))
        self.assertNotIn("staticData", failed)


class InProcessTests(LifecycleMixin, unittest.TestCase):
    def setUp(self):
        super().setUp()
        plugin = make_plugin()

        class Direct(Transport):
            def method(self, request):
                return plugin.webhook_method(request)

            def webhook(self, request):
                return plugin.receive_webhook(request)

        self.plugin = plugin
        self.transport = Direct()

    def test_metrics_and_manual_run(self):
        static = self.transport.method(method_request("create", {}, self.creds))["staticData"]
        self.transport.webhook(delivery(static, "push", {"ref": "refs/heads/main"}))
        self.assertEqual(metric_value(self.plugin, "landflow.productivity.records_written", service="github", operation="webhook.create"), 1)
        self.assertEqual(metric_value(self.plugin, "landflow.productivity.poll.new_items", trigger="githubWebhook"), 1)
        from _support import execute

        manual = execute(self.plugin, "githubWebhookTrigger", {"owner": "octo", "repository": "demo"}, credentials=self.creds)
        self.assertEqual(manual["outputs"], [[]])
        self.assertIn("manual run", manual["logs"][0]["message"])


class HttpTests(LifecycleMixin, unittest.TestCase):
    def setUp(self):
        super().setUp()
        server = HttpPluginServer(make_plugin(), "127.0.0.1", 0)
        server.start()
        self.addCleanup(server.stop)

        def post(path: str, body: dict) -> dict:
            request = urllib.request.Request(f"http://127.0.0.1:{server.port}{path}", data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(request, timeout=10) as resp:
                return json.loads(resp.read())

        class Http(Transport):
            def method(self, request):
                return post("/landflow/v1/webhook-method", request)

            def webhook(self, request):
                return post("/landflow/v1/webhook", request)

        self.transport = Http()


@unittest.skipIf(grpc_server is None, "grpc extra not installed")
class GrpcTests(LifecycleMixin, unittest.TestCase):
    def setUp(self):
        super().setUp()
        import grpc

        from landflow_sdk._pb import plugin_pb2_grpc as pb_grpc

        server = grpc_server.GrpcPluginServer(make_plugin(), "127.0.0.1", 0)
        server.start()
        self.addCleanup(server.stop)
        channel = grpc.insecure_channel(f"127.0.0.1:{server.port}")
        self.addCleanup(channel.close)
        stub = pb_grpc.PluginServiceStub(channel)

        class Grpc(Transport):
            def method(self, request):
                return grpc_server.webhook_method_response_from_proto(stub.WebhookMethod(grpc_server.webhook_method_request_to_proto(request), timeout=10))

            def webhook(self, request):
                return grpc_server.webhook_response_from_proto(stub.ReceiveWebhook(grpc_server.webhook_request_to_proto(request), timeout=10))

        self.transport = Grpc()


if __name__ == "__main__":
    unittest.main()
