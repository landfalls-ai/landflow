"""Tracing, logs, metrics and the traced HTTP client in built-in mode (no opentelemetry). Run:

    python3 -m unittest discover -s sdks/python/tests
"""

from __future__ import annotations

import json
import shutil
import socket
import sys
import unittest
import urllib.error
import urllib.request

from _support import (
    REMOTE_SPAN_ID,
    REMOTE_TRACE_ID,
    TRACEPARENT,
    EchoServer,
    LogCapture,
    builtin_telemetry,
    grpc_server,
)

from landflow_sdk import CredentialType, HttpError, Node, NodeOperationError, Plugin
from landflow_sdk.http_server import HttpPluginServer
from landflow_sdk.logs import LogFormatter
from landflow_sdk.metrics import MAX_ATTRIBUTE_SETS, MetricsRegistry, prometheus_name
from landflow_sdk.redact import REDACTED, is_secret_key, redact_attributes, redact_text, secret_scope
from landflow_sdk.telemetry import Telemetry, extract, format_traceparent, parse_traceparent


class Traced(Node):
    """GETs ``{url}/echo`` inside a child span, records a custom metric and logs."""

    description = {
        "name": "traced",
        "displayName": "Traced",
        "version": 1,
        "kind": "action",
        "inputs": [{"type": "main"}],
        "outputs": [{"type": "main"}],
        "credentials": [{"name": "obsApi", "required": False}],
        "properties": [
            {"name": "url", "displayName": "URL", "type": "string", "default": ""},
            {"name": "fail", "displayName": "Fail", "type": "boolean", "default": False},
        ],
    }

    def execute(self, ctx):
        items = ctx.get_input_data()
        creds = ctx.get_credentials("obsApi") or {}
        if ctx.get_node_parameter("fail"):
            raise NodeOperationError(f"upstream rejected key {creds.get('apiKey')}")
        with ctx.span("obs.fetch", {"obs.items": len(items), "obs.key": creds.get("apiKey")}) as span:
            resp = ctx.http.get(ctx.get_node_parameter("url") + "/echo", params={"q": "1"})
            span.set_attribute("obs.status", resp.status)
        ctx.metrics.counter("obs.fetches", description="Fetches made").add(1, {"obs.result": "ok"})
        ctx.logger.info("fetched with %s", creds.get("apiKey", "-"), status=resp.status, input_tokens=5, auth_token="t")
        return [{"json": {**item["json"], "echo": resp.json}} for item in items]


OBS_API = CredentialType(
    name="obsApi",
    display_name="Obs API",
    properties=[{"name": "apiKey", "displayName": "API key", "type": "string", "typeOptions": {"password": True}}],
)


def make_plugin(**env: str) -> Plugin:
    return Plugin("obs", "Obs", "1.0.0", nodes=[Traced()], credential_types=[OBS_API], telemetry=builtin_telemetry("obs", **env))


def execute_request(url: str, **extra) -> dict:
    return {
        "protocol": "landflow.plugin/v1",
        "executionId": "ex_obs",
        "workflowId": "wf_obs",
        "mode": "manual",
        "node": {"id": "n1", "name": "Fetch", "type": "obs.traced", "typeVersion": 1},
        "parameters": {"url": url},
        "itemParameters": [],
        "inputs": [[{"json": {"i": 1}}, {"json": {"i": 2}}]],
        **extra,
    }


class SecretKeyTests(unittest.TestCase):
    def test_addresses_and_kinds_are_not_secrets(self):
        for key in ("accessToken", "refresh_token", "apiKey", "clientSecret", "authorization", "password"):
            self.assertTrue(is_secret_key(key), key)
        for key in ("tokenUrl", "token_uri", "tokenEndpoint", "tokenType", "baseUrl", "host"):
            self.assertFalse(is_secret_key(key), key)


class TraceparentTests(unittest.TestCase):
    def test_parse_and_format(self):
        self.assertEqual(parse_traceparent(TRACEPARENT), (REMOTE_TRACE_ID, REMOTE_SPAN_ID, True))
        self.assertEqual(parse_traceparent(f"00-{REMOTE_TRACE_ID}-{REMOTE_SPAN_ID}-00")[2], False)
        self.assertEqual(parse_traceparent(f"01-{REMOTE_TRACE_ID}-{REMOTE_SPAN_ID}-01-future"), (REMOTE_TRACE_ID, REMOTE_SPAN_ID, True))
        for bad in (
            None, "", "garbage", f"ff-{REMOTE_TRACE_ID}-{REMOTE_SPAN_ID}-01", f"00-{'0' * 32}-{REMOTE_SPAN_ID}-01",
            f"00-{REMOTE_TRACE_ID}-{'0' * 16}-01", f"00-{REMOTE_TRACE_ID.upper()}-{REMOTE_SPAN_ID}-01",
            f"00-{REMOTE_TRACE_ID}-{REMOTE_SPAN_ID}-01-extra",
        ):
            self.assertIsNone(parse_traceparent(bad), bad)
        self.assertEqual(format_traceparent(REMOTE_TRACE_ID, REMOTE_SPAN_ID, True), TRACEPARENT)

    def test_extract_is_case_insensitive(self):
        ctx = extract({"TraceParent": TRACEPARENT, "tracestate": "vendor=1", "Baggage": "user=a"})
        self.assertEqual((ctx.trace_id, ctx.span_id, ctx.tracestate, ctx.baggage, ctx.remote), (REMOTE_TRACE_ID, REMOTE_SPAN_ID, "vendor=1", "user=a", True))
        self.assertEqual(extract([("traceparent", TRACEPARENT)]).span_id, REMOTE_SPAN_ID)  # gRPC metadata pairs
        self.assertIsNone(extract({}))


class HttpPropagationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.echo = EchoServer().__enter__()
        cls.plugin = make_plugin()
        cls.server = HttpPluginServer(cls.plugin, "127.0.0.1", 0)
        cls.server.start()
        cls.base = f"http://127.0.0.1:{cls.server.port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.stop()
        cls.echo.__exit__()

    def _call(self, path, body=None, headers=None):
        request = urllib.request.Request(self.base + path, data=body, headers={"Content-Type": "application/json", **(headers or {})})
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return response.status, response.headers, response.read()
        except urllib.error.HTTPError as exc:
            with exc:
                return exc.code, exc.headers, exc.read()

    def test_server_child_and_client_spans_share_the_callers_trace(self):
        self.echo.requests.clear()
        body = json.dumps(execute_request(self.echo.url)).encode()
        with LogCapture() as logs:
            status, _, raw = self._call("/landflow/v1/execute", body, {"traceparent": TRACEPARENT, "tracestate": "vendor=1"})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw)["outputs"][0][0]["json"]["echo"], {"ok": True, "path": "/echo"})

        server = logs.span("plugin.execute obs.traced")
        self.assertEqual((server["trace_id"], server["parent_span_id"], server["kind"]), (REMOTE_TRACE_ID, REMOTE_SPAN_ID, "server"))
        self.assertEqual(server["service"], "landflow-plugin-obs")
        self.assertEqual(
            {k: server["attributes"][k] for k in ("landflow.plugin.id", "landflow.node.type", "landflow.node.name", "landflow.workflow.id",
                                                  "landflow.execution.id", "landflow.execution.mode", "landflow.items.in", "landflow.items.out")},
            {"landflow.plugin.id": "obs", "landflow.node.type": "obs.traced", "landflow.node.name": "Fetch", "landflow.workflow.id": "wf_obs",
             "landflow.execution.id": "ex_obs", "landflow.execution.mode": "manual", "landflow.items.in": 2, "landflow.items.out": 2},
        )
        child = logs.span("obs.fetch")
        self.assertEqual((child["trace_id"], child["parent_span_id"], child["kind"]), (REMOTE_TRACE_ID, server["span_id"], "internal"))
        self.assertEqual(child["attributes"]["obs.status"], 200)
        client = logs.span("HTTP GET")
        self.assertEqual((client["parent_span_id"], client["kind"]), (child["span_id"], "client"))
        self.assertEqual(client["attributes"]["url.full"], f"{self.echo.url}/echo")  # query string stripped
        self.assertEqual(client["attributes"]["http.response.status_code"], 200)
        self.assertEqual(client["attributes"]["server.address"], "127.0.0.1")

        sent = self.echo.requests[-1]
        self.assertEqual(sent["headers"]["traceparent"], f"00-{REMOTE_TRACE_ID}-{client['span_id']}-01")
        self.assertEqual(sent["headers"]["tracestate"], "vendor=1")
        self.assertEqual(sent["query"], {"q": ["1"]})

        node_log = next(line for line in logs.lines if line["msg"].startswith("fetched"))
        self.assertEqual((node_log["trace_id"], node_log["span_id"]), (REMOTE_TRACE_ID, server["span_id"]))
        self.assertEqual((node_log["landflow.node.type"], node_log["landflow.execution.id"], node_log["status"]), ("obs.traced", "ex_obs", 200))

    def test_new_trace_without_traceparent(self):
        with LogCapture() as logs:
            self._call("/landflow/v1/execute", json.dumps(execute_request(self.echo.url)).encode())
        server = logs.span("plugin.execute obs.traced")
        self.assertNotIn("parent_span_id", server)
        self.assertNotEqual(server["trace_id"], REMOTE_TRACE_ID)

    def test_no_spans_for_health_manifest_metrics(self):
        with LogCapture() as logs:
            for path in ("/landflow/v1/health", "/landflow/v1/manifest", "/.well-known/landflow", "/metrics"):
                self.assertEqual(self._call(path, headers={"traceparent": TRACEPARENT})[0], 200, path)
        self.assertEqual(logs.spans(), [])

    def test_metrics_endpoint(self):
        self._call("/landflow/v1/execute", json.dumps(execute_request(self.echo.url)).encode())
        failing = execute_request(self.echo.url, parameters={"url": self.echo.url, "fail": True})
        self._call("/landflow/v1/execute", json.dumps(failing).encode())
        status, headers, raw = self._call("/metrics")
        text = raw.decode()
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "text/plain; version=0.0.4; charset=utf-8")
        self.assertIn('target_info{service_name="landflow-plugin-obs",service_version="1.0.0",service_namespace="landflow",'
                      'landflow_plugin_id="obs",landflow_plugin_language="python"', text)
        self.assertIn("# TYPE landflow_plugin_executions_total counter", text)
        self.assertRegex(text, r'landflow_plugin_executions_total\{landflow_node_status="success",landflow_node_type="obs.traced"\} [1-9]')
        self.assertIn('landflow_plugin_executions_total{landflow_node_status="error",landflow_node_type="obs.traced"} 1', text)
        self.assertIn("# TYPE landflow_plugin_execute_duration_milliseconds histogram", text)
        self.assertIn('landflow_plugin_execute_duration_milliseconds_bucket{landflow_node_status="success",landflow_node_type="obs.traced",le="60000"}', text)
        self.assertIn('landflow_plugin_execute_duration_milliseconds_bucket{landflow_node_status="success",landflow_node_type="obs.traced",le="+Inf"}', text)
        self.assertRegex(text, r'landflow_plugin_items_total\{landflow_direction="in",landflow_node_type="obs.traced"\} \d+')
        self.assertIn('http_client_request_duration_seconds_bucket{http_request_method="GET",http_response_status_code="200",'
                      'server_address="127.0.0.1"', text)
        # custom metric + the SDK's automatic attributes
        self.assertRegex(text, r'obs_fetches_total\{landflow_node_type="obs.traced",landflow_plugin_id="obs",'
                               r'landflow_workflow_id="wf_obs",obs_result="ok"\} [1-9]')

    def test_metrics_endpoint_can_be_disabled(self):
        plugin = make_plugin(LANDFLOW_METRICS_PROMETHEUS="false")
        server = HttpPluginServer(plugin, "127.0.0.1", 0)
        server.start()
        try:
            with self.assertRaises(urllib.error.HTTPError) as caught:
                urllib.request.urlopen(f"http://127.0.0.1:{server.port}/metrics", timeout=5)
            caught.exception.close()
            self.assertEqual(caught.exception.code, 404)
        finally:
            server.stop()


@unittest.skipIf(grpc_server is None, "grpc extra not installed")
class GrpcPropagationTests(unittest.TestCase):
    def test_metadata_traceparent_is_continued(self):
        import grpc

        from landflow_sdk._pb import plugin_pb2 as pb
        from landflow_sdk._pb import plugin_pb2_grpc as pb_grpc

        plugin = make_plugin()
        server = grpc_server.GrpcPluginServer(plugin, "127.0.0.1", 0)
        server.start()
        channel = grpc.insecure_channel(f"127.0.0.1:{server.port}")
        try:
            stub = pb_grpc.PluginServiceStub(channel)
            with EchoServer() as echo, LogCapture() as logs:
                request = grpc_server.execute_request_to_proto(execute_request(echo.url))
                response = stub.Execute(request, metadata=(("traceparent", TRACEPARENT), ("baggage", "tenant=t1")), timeout=5)
                self.assertFalse(response.HasField("error") and response.error.message)
                stub.Health(pb.HealthRequest(), metadata=(("traceparent", TRACEPARENT),), timeout=5)
                stub.GetManifest(pb.GetManifestRequest(), metadata=(("traceparent", TRACEPARENT),), timeout=5)
            server_span = logs.span("plugin.execute obs.traced")
            self.assertEqual((server_span["trace_id"], server_span["parent_span_id"]), (REMOTE_TRACE_ID, REMOTE_SPAN_ID))
            self.assertEqual(logs.span("obs.fetch")["parent_span_id"], server_span["span_id"])
            self.assertEqual(len(logs.spans()), 3)  # execute, obs.fetch, HTTP GET: none for Health / GetManifest
            sent = echo.requests[-1]["headers"]
            self.assertTrue(sent["traceparent"].startswith(f"00-{REMOTE_TRACE_ID}-"))
            self.assertEqual(sent["baggage"], "tenant=t1")
        finally:
            channel.close()
            server.stop()


class RedactionTests(unittest.TestCase):
    SECRET = "sk-live-0123456789abcdef"

    def test_credential_values_never_reach_logs_spans_or_errors(self):
        plugin = make_plugin()
        with EchoServer() as echo, LogCapture() as logs:
            ok = plugin.execute(execute_request(echo.url, credentials={"obsApi": {"apiKey": self.SECRET}}), {"traceparent": TRACEPARENT})
            failed = plugin.execute(
                execute_request(echo.url, parameters={"url": echo.url, "fail": True}, credentials={"obsApi": {"apiKey": self.SECRET}})
            )
        self.assertNotIn(self.SECRET, logs.text)
        self.assertNotIn(self.SECRET, json.dumps(ok))
        self.assertNotIn(self.SECRET, json.dumps(failed))
        self.assertEqual(ok["logs"][0]["message"], f"fetched with {REDACTED}")
        self.assertEqual(failed["error"]["message"], f"upstream rejected key {REDACTED}")
        self.assertEqual(logs.span("obs.fetch")["attributes"]["obs.key"], REDACTED)
        node_log = next(line for line in logs.lines if line["msg"].startswith("fetched"))
        self.assertEqual(node_log["auth_token"], REDACTED)  # by key
        self.assertEqual(node_log["input_tokens"], 5)  # numbers are kept even under a matching key
        error_span = [s for s in logs.spans("plugin.execute") if s["status"] == "error"][0]
        self.assertEqual((error_span["level"], error_span["error"]), ("error", f"upstream rejected key {REDACTED}"))

    def test_helpers(self):
        self.assertEqual(
            redact_attributes({"Authorization": "Bearer x", "x-api-key": "k", "API_KEY": "k", "cookie": "c", "password": "p",
                               "client_secret": "s", "count": 3, "gen_ai.usage.output_tokens": 7, "nested": {"token": "t", "ok": "v"}}),
            {"Authorization": REDACTED, "x-api-key": REDACTED, "API_KEY": REDACTED, "cookie": REDACTED, "password": REDACTED,
             "client_secret": REDACTED, "count": 3, "gen_ai.usage.output_tokens": 7, "nested": {"token": REDACTED, "ok": "v"}},
        )
        with secret_scope(["abc", "p@ss word!"]):  # "abc" is too short to redact by value
            self.assertEqual(redact_text("abc p@ss word! p%40ss%20word%21"), f"abc {REDACTED} {REDACTED}")
        self.assertEqual(redact_text("p@ss word!"), "p@ss word!")  # scope ended


class SpanTests(unittest.TestCase):
    def test_exception_in_child_span_sets_error_status_and_event(self):
        telemetry = builtin_telemetry("spans")
        with LogCapture() as logs, self.assertRaises(ValueError):
            with telemetry.span("work.step", {"work.n": 1}) as span:
                raise ValueError("broken step")
        self.assertEqual((span.status, span.events[0][0]), ("error", "exception"))
        self.assertEqual(span.events[0][1]["exception.type"], "ValueError")
        line = logs.span("work.step")
        self.assertEqual((line["level"], line["status"], line["error"]), ("error", "error", "broken step"))

    def test_log_spans_off(self):
        telemetry = builtin_telemetry("spans", LANDFLOW_LOG_SPANS="false")
        with LogCapture() as logs:
            with telemetry.span("quiet"):
                pass
        self.assertEqual(logs.spans(), [])

    def test_sampling(self):
        off = builtin_telemetry("spans", OTEL_TRACES_SAMPLER="always_off")
        unsampled_parent = extract({"traceparent": f"00-{REMOTE_TRACE_ID}-{REMOTE_SPAN_ID}-00"})
        on = builtin_telemetry("spans")
        with LogCapture() as logs:
            with off.span("dropped") as dropped:
                pass
            span = on.start_span("child-of-unsampled", parent=unsampled_parent)
            span.end()
        self.assertEqual(logs.spans(), [])
        self.assertFalse(dropped.is_recording)
        self.assertTrue(dropped.traceparent().endswith("-00"))  # ids still propagate, unsampled
        self.assertEqual(span.trace_id, REMOTE_TRACE_ID)

    def test_disabled_sdk_is_a_passthrough(self):
        plugin = make_plugin(OTEL_SDK_DISABLED="true")
        with EchoServer() as echo, LogCapture() as logs:
            response = plugin.execute(execute_request(echo.url), {"traceparent": TRACEPARENT})
        self.assertNotIn("error", response)
        self.assertEqual(logs.spans(), [])
        self.assertEqual(echo.requests[-1]["headers"]["traceparent"], TRACEPARENT)  # caller's context passed on
        self.assertEqual(plugin.telemetry.render_prometheus(), "")
        node_log = next(line for line in logs.lines if line["msg"].startswith("fetched"))
        self.assertEqual(node_log["trace_id"], REMOTE_TRACE_ID)

    def test_service_name_and_resource_from_env(self):
        telemetry = builtin_telemetry("svc", OTEL_RESOURCE_ATTRIBUTES="deployment.environment=dev,team=data%20eng")
        self.assertEqual(telemetry.service_name, "landflow-plugin-svc")
        self.assertEqual((telemetry.resource["deployment.environment"], telemetry.resource["team"]), ("dev", "data eng"))
        self.assertEqual(builtin_telemetry("svc", OTEL_SERVICE_NAME="custom").service_name, "custom")


class FallbackTests(unittest.TestCase):
    def test_works_without_opentelemetry_installed(self):
        saved = {name: module for name, module in sys.modules.items() if name == "opentelemetry" or name.startswith("opentelemetry.")}
        for name in saved:
            del sys.modules[name]
        sys.modules["opentelemetry"] = None  # makes `import opentelemetry...` raise ImportError
        try:
            telemetry = Telemetry("fallback", "1.0.0", env={"OTEL_EXPORTER_OTLP_ENDPOINT": "http://127.0.0.1:9"})
            self.assertFalse(telemetry.otel)
            self.assertEqual(telemetry.resource["telemetry.sdk.name"], "landflow-sdk-python")
            with self.assertRaises(ImportError):
                Telemetry("fallback", "1.0.0", env={}, use_otel=True)
            plugin = Plugin("obs", "Obs", "1.0.0", nodes=[Traced()], credential_types=[OBS_API], telemetry=telemetry)
            with EchoServer() as echo, LogCapture() as logs:
                response = plugin.execute(execute_request(echo.url), {"traceparent": TRACEPARENT})
            self.assertNotIn("error", response)
            self.assertEqual(logs.span("plugin.execute obs.traced")["parent_span_id"], REMOTE_SPAN_ID)
            self.assertIn("landflow_plugin_executions_total", telemetry.render_prometheus())
        finally:
            del sys.modules["opentelemetry"]
            sys.modules.update(saved)


class MetricsTests(unittest.TestCase):
    def test_names_are_validated(self):
        registry = MetricsRegistry()
        for bad in ("Telegram.sent", "1x", "x-y", "", "a" * 102):
            with self.assertRaises(ValueError, msg=bad):
                registry.counter(bad)
        registry.counter("telegram.messages.sent")
        with self.assertRaises(ValueError):
            registry.gauge("telegram.messages.sent")  # same name, other type

    def test_cardinality_guard(self):
        registry = MetricsRegistry()
        counter = registry.counter("x.calls")
        for i in range(MAX_ATTRIBUTE_SETS + 5):
            counter.add(1, {"x.user": f"user-{i}"})
        counter.add(1, {"x.user": "y" * 300})
        series = dict(counter.snapshot())
        self.assertEqual(len(series), MAX_ATTRIBUTE_SETS + 1)
        self.assertEqual(series[(("otel.metric.overflow", True),)], 6)
        self.assertIn('x_calls_total{otel_metric_overflow="true"} 6', registry.render_prometheus())
        truncated = MetricsRegistry().counter("x.calls")
        truncated.add(1, {"x.user": "y" * 300})
        self.assertEqual(truncated.snapshot()[0][0], (("x.user", "y" * 100),))

    def test_instruments_and_prometheus_names(self):
        registry = MetricsRegistry()
        registry.gauge("queue.depth", description="Depth").set(7, {"queue": 'a"b'})
        histogram = registry.histogram("postgres.query.duration", unit="ms")
        for v in (3, 30, 70000):
            histogram.record(v)
        registry.counter("bad.values").add(-1)
        text = registry.render_prometheus()
        self.assertIn('queue_depth{queue="a\\"b"} 7', text)
        self.assertIn('postgres_query_duration_milliseconds_bucket{le="5"} 1', text)
        self.assertIn('postgres_query_duration_milliseconds_bucket{le="50"} 2', text)
        self.assertIn('postgres_query_duration_milliseconds_bucket{le="+Inf"} 3', text)
        self.assertIn("postgres_query_duration_milliseconds_count 3", text)
        self.assertNotIn("bad_values", text)  # negative counter increments are ignored
        self.assertEqual(prometheus_name("http.client.request.duration", "s", "histogram"), "http_client_request_duration_seconds")
        self.assertEqual(prometheus_name("landflow.plugin.items", "{item}", "counter"), "landflow_plugin_items_total")
        self.assertEqual(prometheus_name("payload.size", "By", "histogram"), "payload_size_bytes")

    def test_ctx_metrics_through_disabled_telemetry_are_noops(self):
        telemetry = builtin_telemetry("m", OTEL_SDK_DISABLED="true")
        telemetry.metrics.counter("x.y").add(1)
        self.assertEqual(telemetry.render_prometheus(), "")


class HttpClientTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.echo = EchoServer().__enter__()
        cls.telemetry = builtin_telemetry("http")
        from landflow_sdk import HttpClient

        cls.http = HttpClient(cls.telemetry)

    @classmethod
    def tearDownClass(cls):
        cls.echo.__exit__()

    def test_json_body_headers_and_response(self):
        with LogCapture() as logs:
            resp = self.http.request("post", self.echo.url + "/items?a=1", json={"x": 1}, params={"b": [2, 3]},
                                     headers={"authorization": "Bearer t0k", "user-agent": "custom"})
        sent = self.echo.requests[-1]
        self.assertEqual((sent["method"], sent["query"], sent["body"]), ("POST", {"a": ["1"], "b": ["2", "3"]}, b'{"x":1}'))
        self.assertEqual(sent["headers"]["content-type"], "application/json; charset=utf-8")
        self.assertEqual(sent["headers"]["user-agent"], "custom")
        self.assertRegex(sent["headers"]["traceparent"], r"^00-[0-9a-f]{32}-[0-9a-f]{16}-01$")  # a root client span
        self.assertEqual((resp.status, resp.ok, resp.headers["x-echo"], resp.json["path"]), (200, True, "yes", "/items"))
        self.assertIn('"ok": true', resp.text)
        span = logs.span("HTTP POST")
        self.assertEqual(span["attributes"]["url.full"], f"{self.echo.url}/items")
        self.assertNotIn("Bearer", logs.text)

    @unittest.skipUnless(shutil.which("openssl"), "needs openssl to make a self-signed certificate")
    def test_verify_false_accepts_a_self_signed_certificate(self):
        import http.server
        import ssl
        import subprocess
        import tempfile
        import threading

        with tempfile.TemporaryDirectory() as tmp:
            cert, key = f"{tmp}/cert.pem", f"{tmp}/key.pem"
            subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1",
                            "-keyout", key, "-out", cert], check=True, capture_output=True)

            class Handler(http.server.BaseHTTPRequestHandler):
                def do_GET(self):  # noqa: N802
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b'{"secure": true}')

                def log_message(self, *args):
                    pass

            server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
            tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            tls.load_cert_chain(cert, key)
            server.socket = tls.wrap_socket(server.socket, server_side=True)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            url = f"https://127.0.0.1:{server.server_address[1]}/"
            try:
                with self.assertRaises(HttpError):
                    self.http.get(url, timeout=5)
                self.assertEqual(self.http.get(url, timeout=5, verify=False).json, {"secure": True})
            finally:
                server.shutdown()
                server.server_close()

    def test_error_statuses_are_returned_then_raised_on_demand(self):
        with LogCapture() as logs:
            resp = self.http.get(self.echo.url + "/status/404")
        self.assertEqual((resp.status, resp.ok, resp.json), (404, False, {"message": "not here"}))
        line = logs.span("HTTP GET")
        self.assertEqual((line["status"], line["attributes"]["error.type"]), ("error", "404"))
        with self.assertRaises(HttpError) as caught:
            resp.raise_for_status()
        self.assertEqual((caught.exception.status, caught.exception.description), (404, "not here"))
        self.assertIsInstance(caught.exception, NodeOperationError)

    def test_network_failure_raises(self):
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        with LogCapture() as logs, self.assertRaises(HttpError) as caught:
            self.http.get(f"http://127.0.0.1:{port}/x", timeout=2)
        self.assertIsNone(caught.exception.status)
        self.assertIn(f"GET http://127.0.0.1:{port}/x failed", caught.exception.message)
        self.assertEqual(logs.span("HTTP GET")["status"], "error")
        with self.assertRaises(ValueError):
            self.http.get("ftp://example.invalid/x")


class LogFormatTests(unittest.TestCase):
    def test_pretty_and_json_lines(self):
        telemetry = builtin_telemetry("fmt")
        with LogCapture(fmt="pretty") as pretty:
            with telemetry.span("fmt.op", {"fmt.n": 2}):
                import logging

                logging.getLogger("landflow_sdk.test").info("hello %s", "world", extra={"landflow_fields": {"k": "v w"}})
        first = pretty.text.splitlines()[0]
        self.assertRegex(first, r'^\d\d:\d\d:\d\d info  test-service hello world \(trace=[0-9a-f]{32}/span=[0-9a-f]{16}\) k="v w" logger=landflow_sdk.test$')
        self.assertIn("span.end fmt.op", pretty.text)
        line = json.loads(LogFormatter("svc").format(_record("warn me")))
        self.assertEqual(list(line)[:4], ["ts", "level", "service", "msg"])
        self.assertEqual((line["level"], line["service"], line["msg"]), ("warn", "svc", "warn me"))
        self.assertRegex(line["ts"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$")


def _record(msg: str):
    import logging

    return logging.LogRecord("x", logging.WARNING, __file__, 1, msg, None, None)


if __name__ == "__main__":
    unittest.main()
