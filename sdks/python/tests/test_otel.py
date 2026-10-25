"""OpenTelemetry mode (``pip install 'landflow-sdk[otel]'``); skipped when opentelemetry is not installed. Run:

    python -m unittest discover -s sdks/python/tests      # with a venv that has the otel extra
"""

from __future__ import annotations

import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from _support import REMOTE_SPAN_ID, REMOTE_TRACE_ID, TRACEPARENT, EchoServer, LogCapture

from landflow_sdk import Node, NodeOperationError, Plugin
from landflow_sdk.telemetry import Telemetry

try:
    from opentelemetry import trace as ot_trace
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
    from opentelemetry.trace import SpanKind, StatusCode
except ImportError:  # the otel extra is optional
    ot_trace = None

THIRD_PARTY: list = []


class Instrumented(Node):
    description = {
        "name": "instrumented",
        "displayName": "Instrumented",
        "version": 1,
        "kind": "action",
        "inputs": [{"type": "main"}],
        "outputs": [{"type": "main"}],
        "properties": [{"name": "url", "displayName": "URL", "type": "string", "default": ""}],
    }

    def execute(self, ctx):
        if not ctx.get_node_parameter("url"):
            raise NodeOperationError("no url")
        with ctx.span("inst.fetch", {"inst.n": 1}):
            ctx.http.get(ctx.get_node_parameter("url") + "/x")
            # a library instrumented with plain OpenTelemetry joins the same trace
            with ot_trace.get_tracer("third.party").start_as_current_span("lib.call") as lib:
                THIRD_PARTY.append(lib)
        return ctx.get_input_data()


def request(url: str) -> dict:
    return {"node": {"type": "otel.instrumented", "name": "Inst"}, "parameters": {"url": url}, "inputs": [[{"json": {"a": 1}}]]}


@unittest.skipIf(ot_trace is None, "opentelemetry not installed")
class OtelModeTests(unittest.TestCase):
    def setUp(self):
        self.telemetry = Telemetry("otel", "2.0.0", env={}, use_otel=True)
        self.exporter = InMemorySpanExporter()
        self.telemetry._tracer_provider.add_span_processor(SimpleSpanProcessor(self.exporter))
        self.plugin = Plugin("otel", "OTel", "2.0.0", nodes=[Instrumented()], telemetry=self.telemetry)

    def tearDown(self):
        self.telemetry.shutdown()

    def test_spans_are_otel_spans_with_the_remote_parent(self):
        self.assertTrue(self.telemetry.otel)
        self.assertEqual(self.telemetry.resource["telemetry.sdk.name"], "opentelemetry")
        THIRD_PARTY.clear()
        with EchoServer() as echo, LogCapture() as logs:
            response = self.plugin.execute(request(echo.url), {"traceparent": TRACEPARENT})
        self.assertNotIn("error", response)
        spans = {s.name: s for s in self.exporter.get_finished_spans()}
        server, child, client = spans["plugin.execute otel.instrumented"], spans["inst.fetch"], spans["HTTP GET"]
        self.assertEqual(server.kind, SpanKind.SERVER)
        self.assertEqual(f"{server.context.trace_id:032x}", REMOTE_TRACE_ID)
        self.assertEqual(f"{server.parent.span_id:016x}", REMOTE_SPAN_ID)
        self.assertTrue(server.parent.is_remote)
        self.assertEqual(server.attributes["landflow.items.out"], 1)
        self.assertEqual(server.resource.attributes["service.name"], "landflow-plugin-otel")
        self.assertEqual(server.resource.attributes["landflow.plugin.language"], "python")
        self.assertEqual(child.parent.span_id, server.context.span_id)
        self.assertEqual((client.kind, client.parent.span_id), (SpanKind.CLIENT, child.context.span_id))
        self.assertEqual(echo.requests[-1]["headers"]["traceparent"], f"00-{REMOTE_TRACE_ID}-{client.context.span_id:016x}-01")
        lib = THIRD_PARTY[0]
        self.assertEqual((lib.context.trace_id, lib.parent.span_id), (server.context.trace_id, child.context.span_id))
        # span.end lines are still written (by a span processor)
        line = logs.span("plugin.execute otel.instrumented")
        self.assertEqual((line["parent_span_id"], line["kind"]), (REMOTE_SPAN_ID, "server"))
        self.assertIn("lib.call", [s["span"] for s in logs.spans()])

    def test_failure_sets_error_status_and_exception_event(self):
        self.plugin.execute(request(""))
        server = self.exporter.get_finished_spans()[-1]
        self.assertEqual((server.status.status_code, server.status.description), (StatusCode.ERROR, "no url"))
        self.assertEqual(server.events[0].name, "exception")
        self.assertIn("landflow_plugin_executions_total", self.telemetry.render_prometheus())


@unittest.skipIf(ot_trace is None, "opentelemetry not installed")
class OtlpExportTests(unittest.TestCase):
    def test_traces_and_metrics_are_exported_over_otlp_http(self):
        received: list[tuple[str, str]] = []

        class Collector(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length") or 0))
                received.append((self.path, self.headers.get("Content-Type")))
                self.send_response(200)
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, *args):
                pass

        collector = ThreadingHTTPServer(("127.0.0.1", 0), Collector)
        threading.Thread(target=collector.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()
        env = {"OTEL_EXPORTER_OTLP_ENDPOINT": f"http://127.0.0.1:{collector.server_address[1]}", "OTEL_METRIC_EXPORT_INTERVAL": "100000"}
        telemetry = Telemetry("otlp", "1.0.0", env=env, use_otel=True)
        try:
            plugin = Plugin("otel", "OTel", "1.0.0", nodes=[Instrumented()], telemetry=telemetry)
            plugin.execute(request(""))
            telemetry.flush()
            deadline = time.monotonic() + 5
            while {p for p, _ in received} != {"/v1/traces", "/v1/metrics"} and time.monotonic() < deadline:
                time.sleep(0.05)
        finally:
            telemetry.shutdown()
            collector.shutdown()
            collector.server_close()
        self.assertIn(("/v1/traces", "application/x-protobuf"), received)
        self.assertIn(("/v1/metrics", "application/x-protobuf"), received)

    def test_sdk_disabled_skips_otel(self):
        telemetry = Telemetry("off", env={"OTEL_SDK_DISABLED": "true", "OTEL_EXPORTER_OTLP_ENDPOINT": "http://127.0.0.1:9"})
        self.assertFalse(telemetry.otel)
        self.assertFalse(telemetry.start_span("x").is_recording)


if __name__ == "__main__":
    unittest.main()
