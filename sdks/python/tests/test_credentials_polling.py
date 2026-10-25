"""Credentials (manifest, ctx.get_credentials, load_options, TestCredentials) and polling triggers. Run:

    python3 -m unittest discover -s sdks/python/tests
"""

from __future__ import annotations

import json
import unittest
import urllib.error
import urllib.request

from _support import TRACEPARENT, REMOTE_SPAN_ID, EchoServer, LogCapture, builtin_telemetry, grpc_server

from landflow_sdk import (
    CredentialType,
    DescriptorError,
    Node,
    NodeOperationError,
    Plugin,
    ProtocolError,
    UnknownCredentialTypeError,
    poll_interval_property,
)
from landflow_sdk.http_server import HttpPluginServer

SECRET = "ghp_fake0123456789abcdefTOKEN"


def check_token(data, ctx):
    """A cheap authenticated call against the configured base URL (an EchoServer in the tests)."""
    resp = ctx.http.get(f"{data['baseUrl']}/status/{200 if data['accessToken'] == SECRET else 401}",
                        headers={"Authorization": f"Bearer {data['accessToken']}"})
    ctx.logger.info("checked token %s", data["accessToken"])
    resp.raise_for_status()
    return True, f"authenticated against {data['baseUrl']}"


DEMO_API = CredentialType(
    name="demoApi",
    display_name="Demo API",
    documentation_url="https://example.invalid/docs/tokens",
    properties=[
        {"name": "accessToken", "displayName": "Access token", "type": "string", "required": True, "typeOptions": {"password": True}},
        {"name": "baseUrl", "displayName": "API base URL", "type": "string", "default": "https://api.example.invalid"},
    ],
    test=check_token,
)
OTHER_API = {"name": "otherApi", "displayName": "Other API", "properties": [{"name": "key", "displayName": "Key", "type": "string"}]}
FEED = [{"id": i, "title": f"event {i}"} for i in range(1, 8)]


class Lister(Node):
    description = {
        "name": "lister",
        "displayName": "Lister",
        "version": 1,
        "kind": "action",
        "inputs": [{"type": "main"}],
        "outputs": [{"type": "main"}],
        "credentials": [{"name": "demoApi", "required": True}, {"name": "otherApi"}],
        "properties": [{"name": "project", "displayName": "Project", "type": "options", "typeOptions": {"loadOptionsMethod": "projects"}}],
    }

    def execute(self, ctx):
        demo = ctx.get_credentials("demoApi")
        other = ctx.get_credentials("otherApi")
        return [{"json": {"baseUrl": demo["baseUrl"], "hasOther": other is not None, "raw": sorted(ctx.credentials)}}]

    def load_options(self, method, parameters, ctx):
        if method == "projects":
            creds = ctx.get_credentials("demoApi")
            ctx.logger.info("listing projects")
            return [{"name": f"{creds['baseUrl']} / main", "value": "main"}]
        return super().load_options(method, parameters, ctx)


class LegacyOptions(Node):
    """A pre-credentials node: two-argument load_options keeps working."""

    description = {"name": "legacy", "displayName": "Legacy", "version": 1, "kind": "action",
                   "inputs": [{"type": "main"}], "outputs": [{"type": "main"}], "properties": []}

    def execute(self, ctx):
        return ctx.get_input_data()

    def load_options(self, method, parameters):
        return ["a", "b"] if method == "letters" else super().load_options(method, parameters)


class FeedTrigger(Node):
    """Polls FEED for ids above ``pollState.lastId`` (docs/protocol.md §8)."""

    description = {
        "name": "feed",
        "displayName": "Feed Trigger",
        "version": 1,
        "kind": "trigger",
        "triggerSource": "poll",
        "inputs": [],
        "outputs": [{"type": "main"}],
        "credentials": [{"name": "demoApi", "required": False}],
        "properties": [poll_interval_property(30), {"name": "silent", "displayName": "Keep state", "type": "boolean", "default": False}],
    }

    def execute(self, ctx):
        newest = max(e["id"] for e in FEED)
        if ctx.mode != "poll":
            ctx.set_poll_state({"lastId": newest})  # dropped by the SDK outside poll mode
            return [{"json": e} for e in FEED[-2:]]
        if ctx.get_node_parameter("silent"):
            return []  # no set_poll_state(): the incoming state is passed back
        if ctx.is_first_poll():
            ctx.set_poll_state({"lastId": newest})
            return []
        last = ctx.get_poll_state()["lastId"]
        if last < 0:
            raise NodeOperationError("feed rejected the cursor")
        ctx.set_poll_state({"lastId": newest})
        return [{"json": e} for e in FEED if e["id"] > last]


def make_plugin() -> Plugin:
    return Plugin(
        "creds",
        "Creds",
        "1.0.0",
        nodes=[Lister(), LegacyOptions(), FeedTrigger()],
        credential_types=[DEMO_API, OTHER_API],
        telemetry=builtin_telemetry("creds"),
    )


def execute_request(node: str, mode: str = "manual", **extra) -> dict:
    return {
        "protocol": "landflow.plugin/v1",
        "executionId": "ex_c",
        "workflowId": "wf_c",
        "mode": mode,
        "node": {"id": "n1", "name": node.title(), "type": f"creds.{node}", "typeVersion": 1},
        "parameters": extra.pop("parameters", {}),
        "itemParameters": [],
        "inputs": extra.pop("inputs", []),
        **extra,
    }


class ManifestTests(unittest.TestCase):
    def test_credential_types_in_manifest(self):
        manifest = make_plugin().manifest()
        demo, other = manifest["credentialTypes"]
        self.assertEqual(
            {k: demo[k] for k in ("name", "displayName", "documentationUrl", "testable")},
            {"name": "demoApi", "displayName": "Demo API", "documentationUrl": "https://example.invalid/docs/tokens", "testable": True},
        )
        self.assertEqual(demo["properties"][0]["typeOptions"], {"password": True})
        self.assertNotIn("testable", other)
        lister = next(n for n in manifest["nodes"] if n["name"] == "lister")
        self.assertEqual(lister["credentials"], [{"name": "demoApi", "required": True}, {"name": "otherApi"}])
        feed = next(n for n in manifest["nodes"] if n["name"] == "feed")
        self.assertEqual(feed["properties"][0]["name"], "pollInterval")
        self.assertEqual((feed["properties"][0]["default"], feed["properties"][0]["typeOptions"]["minValue"]), (30, 10))
        self.assertEqual(make_plugin().well_known()["endpoints"]["testCredentials"], "/landflow/v1/test-credentials")

    def test_validation(self):
        class Orphan(Node):
            description = {**Lister.description, "credentials": [{"name": "nope"}]}

            def execute(self, ctx):
                return []

        with self.assertRaisesRegex(DescriptorError, "not declared"):
            Plugin("x", "X", "1", nodes=[Orphan()], credential_types=[DEMO_API])
        with self.assertRaises(DescriptorError):
            Plugin("x", "X", "1", nodes=[LegacyOptions()], credential_types=[CredentialType(name="bad name", display_name="B")])
        with self.assertRaises(DescriptorError):
            Plugin("x", "X", "1", nodes=[LegacyOptions()], credential_types=[DEMO_API, DEMO_API])
        with self.assertRaises(DescriptorError):
            Plugin("x", "X", "1", nodes=[LegacyOptions()], credential_types=[CredentialType(name="a", display_name="A", test="nope")])
        with self.assertRaises(ValueError):
            poll_interval_property(5)

        class BadTrigger(Node):
            description = {**FeedTrigger.description, "triggerSource": "cron"}

            def execute(self, ctx):
                return []

        with self.assertRaisesRegex(DescriptorError, "triggerSource"):
            Plugin("x", "X", "1", nodes=[BadTrigger()], credential_types=[DEMO_API])


class GetCredentialsTests(unittest.TestCase):
    plugin = make_plugin()

    def test_defaults_optional_and_raw_access(self):
        response = self.plugin.execute(execute_request("lister", credentials={"demoApi": {"accessToken": SECRET}}))
        self.assertEqual(response["outputs"][0][0]["json"], {"baseUrl": "https://api.example.invalid", "hasOther": False, "raw": ["demoApi"]})
        response = self.plugin.execute(
            execute_request("lister", credentials={"demoApi": {"accessToken": SECRET, "baseUrl": "http://self-hosted"}, "otherApi": {"key": "k"}})
        )
        self.assertEqual(response["outputs"][0][0]["json"]["baseUrl"], "http://self-hosted")
        self.assertTrue(response["outputs"][0][0]["json"]["hasOther"])

    def test_missing_required_credential_is_a_node_error(self):
        response = self.plugin.execute(execute_request("lister"))
        self.assertEqual(response["error"]["message"], "No credentials set for 'demoApi'")

    def test_malformed_credentials(self):
        with self.assertRaises(ProtocolError):
            self.plugin.execute(execute_request("lister", credentials={"demoApi": "token"}))

    def test_name_may_be_omitted_for_a_single_credential(self):
        from landflow_sdk import ExecuteContext

        descriptor = {"name": "x", "credentials": [{"name": "demoApi", "required": True}], "properties": []}
        ctx = ExecuteContext({"node": {"type": "creds.x"}, "credentials": {"demoApi": {"accessToken": "t"}}}, descriptor)
        self.assertEqual(ctx.get_credentials(), {"accessToken": "t"})
        self.assertEqual(ctx.credentials, {"demoApi": {"accessToken": "t"}})  # the old attribute still works


class LoadOptionsCredentialTests(unittest.TestCase):
    def test_credentials_reach_load_options(self):
        plugin = make_plugin()
        options = plugin.load_options("lister", "projects", {}, {"demoApi": {"accessToken": SECRET, "baseUrl": "http://gh.local"}})
        self.assertEqual(options, [{"name": "http://gh.local / main", "value": "main"}])
        self.assertEqual(plugin.load_options("legacy", "letters", {}), [{"name": "a", "value": "a"}, {"name": "b", "value": "b"}])
        with self.assertRaises(NodeOperationError):
            plugin.load_options("lister", "projects", {})
        with self.assertRaises(ProtocolError):
            plugin.load_options("lister", "projects", {}, ["not", "an", "object"])
        metrics = plugin.telemetry.render_prometheus()
        self.assertIn('landflow_plugin_load_options_total{landflow_load_options_method="projects",landflow_outcome="ok"} 1', metrics)
        self.assertIn('landflow_plugin_load_options_total{landflow_load_options_method="projects",landflow_outcome="error"} 1', metrics)

    def test_load_options_span(self):
        plugin = make_plugin()
        with LogCapture() as logs:
            plugin.load_options("lister", "projects", {}, {"demoApi": {"accessToken": SECRET}}, {"traceparent": TRACEPARENT})
        span = logs.span("plugin.load_options projects")
        self.assertEqual((span["kind"], span["parent_span_id"]), ("server", REMOTE_SPAN_ID))
        self.assertEqual(span["attributes"], {"landflow.plugin.id": "creds", "landflow.node.type": "creds.lister", "landflow.load_options.method": "projects"})


class TestCredentialsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.echo = EchoServer().__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.echo.__exit__()

    def test_dispatcher(self):
        plugin = make_plugin()
        with LogCapture() as logs:
            ok = plugin.test_credentials("demoApi", {"accessToken": SECRET, "baseUrl": self.echo.url}, {"traceparent": TRACEPARENT})
            bad = plugin.test_credentials("creds.demoApi", {"accessToken": "wrong-token-value", "baseUrl": self.echo.url})
        self.assertEqual(ok, {"ok": True, "message": f"authenticated against {self.echo.url}"})
        self.assertEqual(bad["ok"], False)
        self.assertTrue(bad["message"].startswith("HTTP 401"), bad)
        self.assertEqual(self.echo.requests[-1]["headers"]["authorization"], "Bearer wrong-token-value")
        spans = logs.spans("plugin.test_credentials demoApi")
        self.assertEqual([s["attributes"]["landflow.credential.ok"] for s in spans], [True, False])
        self.assertEqual(spans[0]["parent_span_id"], REMOTE_SPAN_ID)
        self.assertEqual(spans[0]["attributes"]["landflow.credential.type"], "demoApi")
        client = [s for s in logs.spans("HTTP GET")]
        self.assertEqual(client[0]["parent_span_id"], spans[0]["span_id"])
        self.assertNotIn(SECRET, logs.text)
        self.assertNotIn("wrong-token-value", logs.text)

        with self.assertRaises(UnknownCredentialTypeError):
            plugin.test_credentials("missingApi", {})
        with self.assertRaises(UnknownCredentialTypeError):
            plugin.test_credentials("otherApi", {})  # declared but not testable
        with self.assertRaises(ProtocolError):
            plugin.test_credentials("demoApi", ["x"])

    def test_result_shapes(self):
        def plugin_with(test):
            ctype = CredentialType(name="t", display_name="T", test=test, properties=[{"name": "password", "displayName": "P", "type": "string"}])
            return Plugin("shapes", "S", "1", nodes=[LegacyOptions()], credential_types=[ctype], telemetry=builtin_telemetry("shapes"))

        def boom(data):
            raise ConnectionError(f"cannot reach host with {data['password']}")

        cases = [
            (lambda data, ctx: {"ok": False, "message": "nope"}, {"ok": False, "message": "nope"}),
            (lambda data: True, {"ok": True}),  # one-argument test functions work too
            (lambda data, ctx: None, {"ok": True}),
            (lambda data, ctx: (False,), {"ok": False}),
            (boom, {"ok": False, "message": "cannot reach host with [REDACTED]"}),
            (lambda data, ctx: 42, None),
        ]
        for test, expected in cases:
            result = plugin_with(test).test_credentials("t", {"password": "hunter2-secret"})
            if expected is None:
                self.assertEqual(result["ok"], False)
                self.assertIn("credential test must return", result["message"])
            else:
                self.assertEqual(result, expected)

    def test_http_endpoint(self):
        server = HttpPluginServer(make_plugin(), "127.0.0.1", 0)
        server.start()
        try:
            def call(body):
                request = urllib.request.Request(
                    f"http://127.0.0.1:{server.port}/landflow/v1/test-credentials",
                    data=json.dumps(body).encode(),
                    headers={"Content-Type": "application/json", "traceparent": TRACEPARENT},
                )
                try:
                    with urllib.request.urlopen(request, timeout=5) as response:
                        return response.status, json.loads(response.read())
                except urllib.error.HTTPError as exc:
                    with exc:
                        return exc.code, json.loads(exc.read())

            with LogCapture() as logs:
                status, body = call({"credentialType": "demoApi", "data": {"accessToken": SECRET, "baseUrl": self.echo.url}})
            self.assertEqual((status, body["ok"]), (200, True))
            self.assertEqual(logs.span("plugin.test_credentials demoApi")["parent_span_id"], REMOTE_SPAN_ID)
            status, body = call({"credentialType": "demoApi", "data": {"accessToken": "nope-nope", "baseUrl": self.echo.url}})
            self.assertEqual((status, body["ok"]), (200, False))
            self.assertEqual(call({"credentialType": "unknownApi", "data": {}})[0], 404)
            self.assertEqual(call({"credentialType": "demoApi", "data": "x"})[0], 400)
        finally:
            server.stop()

    @unittest.skipIf(grpc_server is None, "grpc extra not installed")
    def test_grpc(self):
        import grpc

        from landflow_sdk._pb import plugin_pb2 as pb
        from landflow_sdk._pb import plugin_pb2_grpc as pb_grpc

        server = grpc_server.GrpcPluginServer(make_plugin(), "127.0.0.1", 0)
        server.start()
        channel = grpc.insecure_channel(f"127.0.0.1:{server.port}")
        try:
            stub = pb_grpc.PluginServiceStub(channel)
            manifest = stub.GetManifest(pb.GetManifestRequest(), timeout=5)
            self.assertEqual([json.loads(c.json)["name"] for c in manifest.credential_types], ["demoApi", "otherApi"])
            data = grpc_server.to_dynamic({"accessToken": SECRET, "baseUrl": self.echo.url})
            with LogCapture() as logs:
                ok = stub.TestCredentials(
                    pb.TestCredentialsRequest(credential_type="demoApi", data=data), metadata=(("traceparent", TRACEPARENT),), timeout=5
                )
            self.assertEqual((ok.ok, ok.message), (True, f"authenticated against {self.echo.url}"))
            self.assertEqual(logs.span("plugin.test_credentials demoApi")["parent_span_id"], REMOTE_SPAN_ID)
            bad = stub.TestCredentials(pb.TestCredentialsRequest(credential_type="demoApi", data=grpc_server.to_dynamic(
                {"accessToken": "wrong-wrong", "baseUrl": self.echo.url})), timeout=5)
            self.assertFalse(bad.ok)
            with self.assertRaises(grpc.RpcError) as caught:
                stub.TestCredentials(pb.TestCredentialsRequest(credential_type="otherApi"), timeout=5)
            self.assertEqual(caught.exception.code(), grpc.StatusCode.NOT_FOUND)
            options = stub.LoadOptions(pb.LoadOptionsRequest(
                node_type="lister", method="projects", parameters=grpc_server.to_dynamic({}),
                credentials=grpc_server.to_dynamic({"demoApi": {"accessToken": SECRET, "baseUrl": "http://grpc.local"}})), timeout=5)
            self.assertEqual(json.loads(options.options.json), [{"name": "http://grpc.local / main", "value": "main"}])
        finally:
            channel.close()
            server.stop()


class PollingTests(unittest.TestCase):
    plugin = make_plugin()

    def poll(self, state=None, mode="poll", parameters=None):
        extra = {"pollState": state} if state is not None else {}
        return self.plugin.execute(execute_request("feed", mode, parameters=parameters or {}, **extra))

    def test_round_trip(self):
        first = self.poll()
        self.assertEqual((first["outputs"], first["pollState"]), ([[]], {"lastId": 7}))
        FEED.append({"id": 8, "title": "event 8"})
        try:
            second = self.poll(first["pollState"])
        finally:
            FEED.pop()
        self.assertEqual([i["json"]["id"] for i in second["outputs"][0]], [8])
        self.assertEqual(second["pollState"], {"lastId": 8})
        quiet = self.poll({"lastId": 8})
        self.assertEqual((quiet["outputs"], quiet["pollState"]), ([[]], {"lastId": 7}))

    def test_manual_mode_returns_recent_items_without_state(self):
        manual = self.poll(mode="manual")
        self.assertEqual([i["json"]["id"] for i in manual["outputs"][0]], [6, 7])
        self.assertNotIn("pollState", manual)

    def test_state_is_echoed_when_not_set_and_dropped_on_error(self):
        echoed = self.poll({"lastId": 3, "cursor": "abc"}, parameters={"silent": True})
        self.assertEqual(echoed["pollState"], {"lastId": 3, "cursor": "abc"})
        failed = self.poll({"lastId": -1})
        self.assertEqual(failed["error"]["message"], "feed rejected the cursor")
        self.assertNotIn("pollState", failed)
        with self.assertRaises(ProtocolError):
            self.poll("not-an-object")

    def test_context_helpers(self):
        from landflow_sdk import ExecuteContext

        ctx = ExecuteContext({"node": {"type": "creds.feed"}, "mode": "poll"}, FeedTrigger.description)
        self.assertTrue(ctx.is_first_poll())
        self.assertIsNone(ctx.get_poll_state())
        with self.assertRaises(TypeError):
            ctx.set_poll_state(["x"])
        ctx = ExecuteContext({"node": {"type": "creds.feed"}, "mode": "poll", "pollState": {"a": [1]}}, FeedTrigger.description)
        self.assertFalse(ctx.is_first_poll())
        ctx.get_poll_state()["a"].append(2)  # a copy
        self.assertEqual(ctx.get_poll_state(), {"a": [1]})
        self.assertFalse(ExecuteContext({"node": {"type": "creds.feed"}}, FeedTrigger.description).is_first_poll())

    @unittest.skipIf(grpc_server is None, "grpc extra not installed")
    def test_grpc_round_trip(self):
        request = execute_request("feed", "poll", pollState={"lastId": 5})
        decoded = grpc_server.execute_request_from_proto(grpc_server.execute_request_to_proto(request))
        self.assertEqual((decoded["mode"], decoded["pollState"]), ("poll", {"lastId": 5}))
        response = self.plugin.execute(decoded)
        back = grpc_server.execute_response_from_proto(grpc_server.execute_response_to_proto(response))
        self.assertEqual(back["pollState"], {"lastId": 7})
        self.assertEqual([i["json"]["id"] for i in back["outputs"][0]], [6, 7])
        first = grpc_server.execute_request_from_proto(grpc_server.execute_request_to_proto(execute_request("feed", "poll")))
        self.assertNotIn("pollState", first)

    def test_http_round_trip(self):
        server = HttpPluginServer(self.plugin, "127.0.0.1", 0)
        server.start()
        try:
            body = json.dumps(execute_request("feed", "poll", pollState={"lastId": 6})).encode()
            request = urllib.request.Request(f"http://127.0.0.1:{server.port}/landflow/v1/execute", data=body,
                                             headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(request, timeout=5) as response:
                payload = json.loads(response.read())
            self.assertEqual((payload["pollState"], [i["json"]["id"] for i in payload["outputs"][0]]), ({"lastId": 7}, [7]))
        finally:
            server.stop()


if __name__ == "__main__":
    unittest.main()
