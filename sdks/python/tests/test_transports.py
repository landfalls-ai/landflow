"""The transport abstraction (docs/transports.md, phase 1): ``Dispatcher`` (deadline, cancel, concurrency),
``Binding`` with a fake third face under ``PluginServer``, ``LANDFLOW_TRANSPORTS`` and the manifest hints."""

from __future__ import annotations

import json
import os
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from _support import LogCapture, builtin_telemetry  # noqa: E402

from landflow_sdk import (  # noqa: E402
    Binding,
    BindingContext,
    BindingInfo,
    CallCancelledError,
    CancelToken,
    Dispatcher,
    HttpBinding,
    Node,
    OverloadedError,
    Plugin,
    PluginServer,
)
from landflow_sdk.http_server import HttpPluginServer  # noqa: E402

try:
    import grpc

    from landflow_sdk import grpc_server
    from landflow_sdk._pb import plugin_pb2_grpc as pb_grpc
except Exception:  # noqa: BLE001 - grpc extra not installed
    grpc = None


class Block(Node):
    """Waits until the call is cancelled, its deadline passes or ``release`` is set; records what it saw."""

    description = {
        "name": "block", "displayName": "Block", "description": "waits", "version": 1, "kind": "action",
        "inputs": [{"type": "main"}], "outputs": [{"type": "main"}], "properties": [],
    }
    release = threading.Event()
    seen: list[dict] = []

    def execute(self, ctx):
        entered = time.monotonic()
        while not ctx.cancel.wait(0.02):
            if Block.release.is_set():
                break
        Block.seen.append({"cancelled": ctx.is_cancelled(), "reason": ctx.cancel.reason, "deadline": ctx.deadline is not None})
        ctx.check_cancelled()  # a cancelled call ends as a node error
        return [{"waited_ms": int((time.monotonic() - entered) * 1000)}]


class Upper(Node):
    description = {
        "name": "upper", "displayName": "Upper", "description": "upper", "version": 1, "kind": "action",
        "inputs": [{"type": "main"}], "outputs": [{"type": "main"}], "properties": [],
    }

    def execute(self, ctx):
        return [{"v": item["json"]["v"].upper()} for item in ctx.get_input_data()]


def make_plugin() -> Plugin:
    return Plugin("tp", "Transport Plugin", "1.0.0", nodes=[Block, Upper], telemetry=builtin_telemetry("tp"))


def request(node: str, items: list[dict] | None = None) -> dict:
    return {
        "protocol": "landflow.plugin/v1", "executionId": "ex1", "mode": "manual",
        "node": {"id": "n1", "name": node, "type": f"tp.{node}", "typeVersion": 1},
        "parameters": {}, "itemParameters": [], "inputs": [[{"json": j} for j in (items if items is not None else [{"v": "a"}])]],
    }


def in_thread(fn, *args, **kwargs):
    box: dict = {}

    def run():
        try:
            box["result"] = fn(*args, **kwargs)
        except BaseException as exc:  # noqa: BLE001
            box["error"] = exc

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    box["thread"] = thread
    return box


def wait_until(cond, what: str, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if cond():
            return
        time.sleep(0.01)
    raise AssertionError(f"timed out waiting for {what}")


class CancelTokenTest(unittest.TestCase):
    def test_deadline_and_cancel(self):
        token = CancelToken(timeout=0.05)
        self.assertFalse(token.is_set())
        self.assertGreater(token.remaining(), 0)
        self.assertTrue(token.wait(5))  # returns at the deadline, not after 5 s
        self.assertTrue(token.is_set())
        self.assertEqual(token.reason, "deadline exceeded")
        with self.assertRaises(CallCancelledError) as caught:
            token.check()
        self.assertTrue(caught.exception.deadline)

        token = CancelToken()
        self.assertIsNone(token.remaining())
        self.assertIsNone(token.reason)
        token.cancel("client went away")
        self.assertTrue(token.is_set())
        with self.assertRaises(CallCancelledError) as caught:
            token.check()
        self.assertFalse(caught.exception.deadline)
        self.assertEqual(str(caught.exception), "client went away")

        never = CancelToken.never()
        never.cancel()
        self.assertFalse(never.is_set())
        never.check()


class DispatcherTest(unittest.TestCase):
    def setUp(self):
        Block.release = threading.Event()
        Block.seen = []
        self.plugin = make_plugin()

    def test_deadline_reaches_node(self):
        dispatcher = Dispatcher(self.plugin)
        started = time.monotonic()
        response = dispatcher.execute(request("block"), deadline=time.monotonic() + 0.1, transport="fake")
        self.assertLess(time.monotonic() - started, 3)
        self.assertEqual(response["error"]["message"], "deadline exceeded")
        self.assertEqual(Block.seen, [{"cancelled": True, "reason": "deadline exceeded", "deadline": True}])
        self.assertEqual(dispatcher.in_flight, 0)
        # An already-expired deadline never starts the node.
        with self.assertRaises(CallCancelledError):
            dispatcher.execute(request("block"), deadline=time.monotonic() - 1)
        self.assertEqual(len(Block.seen), 1)

    def test_cancel_reaches_node(self):
        dispatcher = Dispatcher(self.plugin)
        token = CancelToken()
        box = in_thread(dispatcher.execute, request("block"), cancel=token)
        wait_until(lambda: dispatcher.in_flight == 1, "call in flight")
        token.cancel("rpc cancelled by the client")
        box["thread"].join(5)
        self.assertEqual(box["result"]["error"]["message"], "rpc cancelled by the client")
        self.assertEqual(Block.seen[0]["deadline"], False)
        self.assertEqual(dispatcher.in_flight, 0)

    def test_without_a_token_nodes_see_a_never_set_token(self):
        dispatcher = Dispatcher(self.plugin)
        box = in_thread(dispatcher.execute, request("block"))
        wait_until(lambda: dispatcher.in_flight == 1, "call in flight")
        Block.release.set()
        box["thread"].join(5)
        self.assertNotIn("error", box["result"])
        self.assertEqual(Block.seen, [{"cancelled": False, "reason": None, "deadline": False}])
        # Plugin.execute without the dispatcher behaves as before.
        self.assertNotIn("error", self.plugin.execute(request("upper")))

    def test_concurrency_limit(self):
        dispatcher = Dispatcher(self.plugin, max_concurrency=2)
        self.assertEqual(dispatcher.max_concurrency, 2)
        first = [in_thread(dispatcher.execute, request("block"), transport="http") for _ in range(2)]
        wait_until(lambda: dispatcher.in_flight == 2, "two calls in flight")

        # The third waits for a slot (the queue holds max_concurrency by default) and gives up at its deadline: it
        # never ran but it did wait, so it is a deadline, not a capacity refusal.
        with self.assertRaises(CallCancelledError) as caught:
            dispatcher.execute(request("block"), deadline=time.monotonic() + 0.15)
        self.assertIn("limit 2", str(caught.exception))
        self.assertTrue(caught.exception.deadline)
        self.assertEqual((dispatcher.in_flight, dispatcher.waiting), (2, 0))

        # A fourth, cancelled while waiting, gives up too (cancelled, not a deadline).
        token = CancelToken()
        waiting = in_thread(dispatcher.execute, request("block"), cancel=token)
        wait_until(lambda: dispatcher.waiting == 1, "a waiter")
        token.cancel("client went away")
        waiting["thread"].join(5)
        self.assertIsInstance(waiting.get("error"), CallCancelledError)
        self.assertFalse(waiting["error"].deadline)
        self.assertIn("client went away", str(waiting["error"]))

        # A fifth waits and runs once a slot frees up.
        fifth = in_thread(dispatcher.execute, request("upper"))
        wait_until(lambda: dispatcher.waiting == 1, "the fifth waiting")
        Block.release.set()
        for box in first + [fifth]:
            box["thread"].join(5)
            self.assertNotIn("error", box["result"], box)
        self.assertEqual((dispatcher.in_flight, dispatcher.waiting), (0, 0))
        self.assertEqual(self.plugin.telemetry.in_flight._series, {(("landflow.plugin.id", "tp"),): 0})

    def test_queue_limit_refuses_at_once_and_keeps_arrival_order(self):
        dispatcher = Dispatcher(self.plugin, max_concurrency=1, max_queue=2)
        self.assertEqual((Dispatcher(self.plugin, 3).max_queue, Dispatcher(self.plugin, 3, 0).max_queue, dispatcher.max_queue), (3, 0, 2))
        first = in_thread(dispatcher.execute, request("block"), transport="first")
        wait_until(lambda: dispatcher.in_flight == 1, "first in flight")
        second = in_thread(dispatcher.execute, request("upper", [{"v": "second"}]))
        wait_until(lambda: dispatcher.waiting == 1, "second waiting")
        token = CancelToken()
        third = in_thread(dispatcher.execute, request("upper", [{"v": "third"}]), cancel=token)
        wait_until(lambda: dispatcher.waiting == 2, "third waiting")

        # Queue full: refused at once, the node never sees it.
        started = time.monotonic()
        with self.assertRaises(OverloadedError) as caught:
            dispatcher.execute(request("upper"))
        self.assertLess(time.monotonic() - started, 1)
        self.assertIn("2 waiting", str(caught.exception))
        # A cancelled waiter frees its place.
        token.cancel()
        third["thread"].join(5)
        self.assertIsInstance(third.get("error"), CallCancelledError)
        wait_until(lambda: dispatcher.waiting == 1, "place freed")
        fourth = in_thread(dispatcher.execute, request("upper", [{"v": "fourth"}]))
        wait_until(lambda: dispatcher.waiting == 2, "fourth waiting")
        # Release: the waiters run in arrival order.
        Block.release.set()
        for box in (first, second, fourth):
            box["thread"].join(5)
            self.assertNotIn("error", box["result"], box)
        self.assertEqual((dispatcher.in_flight, dispatcher.waiting), (0, 0))
        self.assertTrue(dispatcher.drain(1))
        self.assertEqual(len(Block.seen), 1)

        # max_queue=0: no waiting at all.
        Block.release = threading.Event()
        strict = Dispatcher(self.plugin, max_concurrency=1, max_queue=0)
        held = in_thread(strict.execute, request("block"))
        wait_until(lambda: strict.in_flight == 1, "slot taken")
        with self.assertRaises(OverloadedError):
            strict.execute(request("upper"))
        Block.release.set()
        held["thread"].join(5)

    def test_http_status_mapping_and_deadline_header(self):
        from landflow_sdk.http_server import DEADLINE_HEADER, deadline_from_header

        self.assertIsNone(deadline_from_header(None))
        self.assertIsNone(deadline_from_header("soon"))
        self.assertIsNone(deadline_from_header("0"))
        self.assertAlmostEqual(deadline_from_header(str(int((time.time() + 10) * 1000))) - time.monotonic(), 10, delta=0.5)

        dispatcher = Dispatcher(self.plugin, max_concurrency=1)
        self.plugin.dispatcher = dispatcher
        server = HttpPluginServer(dispatcher, "127.0.0.1", 0)
        server.start()
        try:
            url = f"http://127.0.0.1:{server.port}/landflow/v1/execute"

            def post(node: str, deadline_ms: int | None = None, timeout: float = 5):
                headers = {"Content-Type": "application/json"}
                if deadline_ms is not None:
                    headers[DEADLINE_HEADER] = str(deadline_ms)
                req = urllib.request.Request(url, data=json.dumps(request(node)).encode(), headers=headers, method="POST")
                try:
                    with urllib.request.urlopen(req, timeout=timeout) as resp:
                        return resp.status, dict(resp.headers), json.loads(resp.read())
                except urllib.error.HTTPError as exc:
                    with exc:
                        return exc.code, dict(exc.headers), json.loads(exc.read())

            # The header's deadline reaches the node: a node error, not a transport error.
            started = time.monotonic()
            status, _, body = post("block", int((time.time() + 0.1) * 1000))
            self.assertEqual((status, body["error"]["message"]), (200, "deadline exceeded"))
            self.assertLess(time.monotonic() - started, 3)
            self.assertEqual(Block.seen[0]["deadline"], True)
            # An expired deadline never runs: 504.
            status, _, body = post("upper", int((time.time() - 1) * 1000))
            self.assertEqual(status, 504)
            self.assertEqual(len(Block.seen), 1)

            # Fill the slot and the queue (max_queue defaults to max_concurrency = 1).
            held = in_thread(post, "block")
            wait_until(lambda: dispatcher.in_flight == 1, "slot taken")
            # A waiter whose deadline passes: 504.
            status, _, body = post("upper", int((time.time() + 0.15) * 1000))
            self.assertEqual(status, 504)
            self.assertIn("deadline exceeded while waiting", body["error"]["message"])
            waiter = in_thread(post, "upper")
            wait_until(lambda: dispatcher.waiting == 1, "a waiter")
            # Queue full: 429 + Retry-After: 1, at once.
            started = time.monotonic()
            status, headers, body = post("upper")
            self.assertEqual((status, headers.get("Retry-After")), (429, "1"))
            self.assertLess(time.monotonic() - started, 1)
            self.assertIn("concurrency limit", body["error"]["message"])
            Block.release.set()
            for box in (held, waiter):
                box["thread"].join(5)
                self.assertEqual(box["result"][0], 200)
        finally:
            server.stop()

    def test_transport_on_the_span_and_in_flight_gauge(self):
        plugin = Plugin("tp", "Transport Plugin", "1.0.0", nodes=[Upper], telemetry=builtin_telemetry("tp", LANDFLOW_LOG_SPANS="true"))
        with LogCapture("tp") as logs:
            plugin.dispatcher.execute(request("upper"), transport="fakebus")
        span = logs.span("plugin.execute tp.upper")
        self.assertEqual(span["attributes"]["landflow.transport"], "fakebus")
        # The plugin's own dispatcher is shared and unlimited.
        self.assertIs(plugin.dispatcher, plugin.dispatcher)
        self.assertIsNone(plugin.dispatcher.max_concurrency)
        with LogCapture("tp") as logs:
            plugin.execute(request("upper"))
        self.assertNotIn("landflow.transport", logs.span("plugin.execute tp.upper")["attributes"])

    def test_http_binding_reports_its_kind(self):
        plugin = Plugin("tp", "Transport Plugin", "1.0.0", nodes=[Upper], telemetry=builtin_telemetry("tp", LANDFLOW_LOG_SPANS="true"))
        server = HttpPluginServer(plugin, "127.0.0.1", 0)
        server.start()
        try:
            with LogCapture("tp") as logs:
                req = urllib.request.Request(
                    f"http://127.0.0.1:{server.port}/landflow/v1/execute", data=json.dumps(request("upper")).encode(),
                    headers={"Content-Type": "application/json"}, method="POST",
                )
                with urllib.request.urlopen(req, timeout=5) as resp:
                    body = json.loads(resp.read())
            self.assertEqual(body["outputs"][0][0]["json"]["v"], "A")
            self.assertEqual(logs.span("plugin.execute tp.upper")["attributes"]["landflow.transport"], "http")
        finally:
            server.stop()


@unittest.skipIf(grpc is None, "grpcio not installed")
class GrpcDeadlineTest(unittest.TestCase):
    def setUp(self):
        Block.release = threading.Event()
        Block.seen = []
        self.plugin = make_plugin()

    def test_client_cancel_and_deadline_reach_the_node(self):
        server = grpc_server.GrpcPluginServer(self.plugin, "127.0.0.1", 0)
        server.start()
        try:
            with grpc.insecure_channel(f"127.0.0.1:{server.port}") as channel:
                stub = pb_grpc.PluginServiceStub(channel)
                # The client cancels: the node sees ctx.cancel set and stops.
                future = stub.Execute.future(grpc_server.execute_request_to_proto(request("block")))
                wait_until(lambda: self.plugin.dispatcher.in_flight == 1, "call in flight")
                future.cancel()
                wait_until(lambda: len(Block.seen) == 1, "the node to notice")
                self.assertTrue(Block.seen[0]["cancelled"])
                self.assertIn("cancelled", Block.seen[0]["reason"])
                # The client's deadline becomes the node's deadline: the node stops at it and answers a node error,
                # which the client sees unless its own deadline fired first (the two coincide).
                try:
                    reply = stub.Execute(grpc_server.execute_request_to_proto(request("block")), timeout=0.2)
                except grpc.RpcError as exc:
                    self.assertEqual(exc.code(), grpc.StatusCode.DEADLINE_EXCEEDED)
                else:
                    self.assertEqual(reply.error.message, "deadline exceeded")
                wait_until(lambda: len(Block.seen) == 2, "the node to notice the deadline")
                self.assertTrue(Block.seen[1]["deadline"])
                self.assertTrue(Block.seen[1]["cancelled"])
                # Health and manifest still answer, through the dispatcher.
                self.assertEqual(stub.Health(grpc_server.pb.HealthRequest()).plugin_id, "tp")
        finally:
            server.stop()

    def test_resource_exhausted_at_the_limit(self):
        dispatcher = Dispatcher(self.plugin, max_concurrency=1)
        self.plugin.dispatcher = dispatcher
        server = grpc_server.GrpcPluginServer(self.plugin, "127.0.0.1", 0)
        server.start()
        try:
            with grpc.insecure_channel(f"127.0.0.1:{server.port}") as channel:
                stub = pb_grpc.PluginServiceStub(channel)
                held = stub.Execute.future(grpc_server.execute_request_to_proto(request("block")))
                wait_until(lambda: dispatcher.in_flight == 1, "the slot taken")
                # A waiter gives up at its deadline with DEADLINE_EXCEEDED (the server's and the client's coincide).
                with self.assertRaises(grpc.RpcError) as caught:
                    stub.Execute(grpc_server.execute_request_to_proto(request("upper")), timeout=0.3)
                self.assertEqual(caught.exception.code(), grpc.StatusCode.DEADLINE_EXCEEDED)
                wait_until(lambda: dispatcher.waiting == 0, "the waiter to give up")
                self.assertEqual(dispatcher.in_flight, 1)
                # With the queue full (max_queue defaults to 1) the next call is refused at once: RESOURCE_EXHAUSTED.
                waiter = stub.Execute.future(grpc_server.execute_request_to_proto(request("upper")))
                wait_until(lambda: dispatcher.waiting == 1, "a waiter")
                started = time.monotonic()
                with self.assertRaises(grpc.RpcError) as caught:
                    stub.Execute(grpc_server.execute_request_to_proto(request("upper")), timeout=5)
                self.assertEqual(caught.exception.code(), grpc.StatusCode.RESOURCE_EXHAUSTED)
                self.assertLess(time.monotonic() - started, 1)
                # A waiter the client cancels ends CANCELLED on the server side and frees its place.
                waiter.cancel()
                wait_until(lambda: dispatcher.waiting == 0, "the cancelled waiter to leave")
                Block.release.set()
                self.assertFalse(held.result(timeout=5).HasField("error"))
                self.assertEqual(stub.Execute(grpc_server.execute_request_to_proto(request("upper"))).outputs[0].items[0].json.json, b'{"v":"A"}')
        finally:
            server.stop()


class FakeBinding(Binding):
    """A third face: records its context, announces a logical endpoint, delivers calls on demand."""

    kind = "fakebus"

    def __init__(self, fail_on_start: bool = False) -> None:
        self.fail_on_start = fail_on_start
        self.context: BindingContext | None = None
        self.stopped = False
        self.events: list[str] = []

    def start(self, context: BindingContext) -> BindingInfo:
        if self.fail_on_start:
            raise ConnectionError("cannot connect to fakebus")
        self.context = context
        self.events.append("start")
        return BindingInfo([f"fakebus://conn-1/{context.plugin.id}"])

    def stop(self) -> None:
        self.stopped = True
        self.events.append("stop")

    def deliver(self, req: dict, timeout: float | None = None) -> dict:
        assert self.context is not None
        return self.context.dispatcher.execute(req, cancel=CancelToken(timeout=timeout), transport=self.kind)


class RecordingBinding(FakeBinding):
    kind = "recorder"

    def __init__(self, events: list[str]) -> None:
        super().__init__()
        self.shared = events

    def start(self, context):
        info = super().start(context)
        self.shared.append("recorder:start")
        return info

    def stop(self):
        super().stop()
        self.shared.append("recorder:stop")


class FakeRegistry:
    def __init__(self) -> None:
        self.announces: list[dict] = []
        self.withdraws: list[dict] = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def _body(self) -> dict:
                return json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")

            def _reply(self) -> None:
                data = json.dumps({"accepted": True, "heartbeatIntervalSeconds": 1}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_POST(self) -> None:  # noqa: N802
                outer.announces.append(self._body())
                self._reply()

            def do_DELETE(self) -> None:  # noqa: N802
                outer.withdraws.append(self._body())
                self._reply()

            def log_message(self, *args: object) -> None:
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        self._thread = threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)

    def __enter__(self):
        self._thread.start()
        return self

    def __exit__(self, *exc):
        self.httpd.shutdown()
        self.httpd.server_close()


CLEAN_ENV = {
    "LANDFLOW_HTTP_PORT": "", "LANDFLOW_GRPC_PORT": "", "LANDFLOW_TRANSPORTS": "", "LANDFLOW_MAX_CONCURRENCY": "",
    "LANDFLOW_REGISTRY_URL": "off", "LANDFLOW_ADVERTISE_HOST": "", "LANDFLOW_BIND_HOST": "",
}


class PluginServerBindingsTest(unittest.TestCase):
    def setUp(self):
        Block.release = threading.Event()
        Block.seen = []

    def test_third_binding_announce_and_hints(self):
        plugin = make_plugin()
        fake = FakeBinding()
        with FakeRegistry() as registry, mock.patch.dict(os.environ, {**CLEAN_ENV, "LANDFLOW_REGISTRY_URL": registry.url}):
            server = PluginServer(plugin, http=0, grpc=False, bindings=[fake], max_concurrency=3)
            server.start()
            try:
                self.assertEqual(server.transports, ["http", "fakebus"])
                self.assertEqual(len(server.endpoints), 2)
                self.assertEqual(server.endpoints[1], "fakebus://conn-1/tp")
                # The binding got the shared dispatcher, the manifest with hints, and the hooks.
                ctx = fake.context
                self.assertIs(ctx.dispatcher, plugin.dispatcher)
                self.assertIs(ctx.dispatcher, server.dispatcher)
                self.assertEqual(ctx.dispatcher.max_concurrency, 3)
                self.assertEqual(ctx.manifest["transports"], ["http", "fakebus"])
                self.assertEqual(ctx.manifest["maxConcurrency"], 3)
                self.assertIs(ctx.plugin, plugin)
                self.assertIs(ctx.telemetry, plugin.telemetry)
                self.assertEqual(ctx.bind_host, "127.0.0.1")
                # …and the manifest over HTTP carries them too.
                with urllib.request.urlopen(f"http://127.0.0.1:{server.http_port}/landflow/v1/manifest", timeout=5) as resp:
                    manifest = json.loads(resp.read())
                self.assertEqual((manifest["transports"], manifest["maxConcurrency"]), (["http", "fakebus"], 3))
                # Every announce carries the hints and both endpoints get announced.
                wait_until(lambda: len({a["endpoint"] for a in registry.announces}) == 2, "both endpoints announced")
                for announce in registry.announces:
                    self.assertEqual((announce["transports"], announce["maxConcurrency"]), (["http", "fakebus"], 3))
                # A call delivered by the third binding runs through the dispatcher, with its deadline.
                out = fake.deliver(request("upper"), timeout=5)
                self.assertEqual(out["outputs"][0][0]["json"]["v"], "A")
                out = fake.deliver(request("block"), timeout=0.1)
                self.assertEqual(out["error"]["message"], "deadline exceeded")
                # The announce hook registers late endpoints on the next heartbeat.
                ctx.announce(["fakebus://conn-2/tp"])
                wait_until(lambda: any(a["endpoint"] == "fakebus://conn-2/tp" for a in registry.announces), "late endpoint announced")
            finally:
                server.stop()
            self.assertTrue(fake.stopped)
            self.assertEqual({w["endpoint"] for w in registry.withdraws}, set(server.endpoints))
            self.assertEqual(len(server.endpoints), 3)

    def test_start_failure_stops_earlier_bindings_in_reverse(self):
        events: list[str] = []
        ok = RecordingBinding(events)
        bad = FakeBinding(fail_on_start=True)
        with mock.patch.dict(os.environ, CLEAN_ENV):
            server = PluginServer(make_plugin(), http=False, bindings=[ok, bad], announce=False)
            with self.assertRaises(ConnectionError):
                server.start()
        self.assertEqual(events, ["recorder:start", "recorder:stop"])

    def test_fail_hook_ends_wait(self):
        fake = FakeBinding()
        with mock.patch.dict(os.environ, CLEAN_ENV):
            server = PluginServer(make_plugin(), http=False, bindings=[fake], announce=False)
            server.start()
            threading.Timer(0.1, lambda: fake.context.fail(ConnectionError("broker connection lost"))).start()
            with self.assertRaises(RuntimeError) as caught:
                server.wait()
        self.assertIn("broker connection lost", str(caught.exception))
        self.assertTrue(fake.stopped)

    def test_transports_env_selects_bindings(self):
        fake = FakeBinding()
        with mock.patch.dict(os.environ, {**CLEAN_ENV, "LANDFLOW_TRANSPORTS": "FAKEBUS, nats"}), self.assertLogs("landflow_sdk", "WARNING") as logs:
            server = PluginServer(make_plugin(), http=0, grpc=0, bindings=[fake], announce=False)
            server.start()
            try:
                self.assertEqual(server.transports, ["fakebus"])
                self.assertIsNone(server.http_port)
                self.assertIsNone(server.grpc_port)
                self.assertEqual(server.endpoints, ["fakebus://conn-1/tp"])
            finally:
                server.stop()
        self.assertTrue(any("'nats'" in line for line in logs.output), logs.output)

        with mock.patch.dict(os.environ, {**CLEAN_ENV, "LANDFLOW_TRANSPORTS": "mcp"}):
            with self.assertRaises(RuntimeError):
                PluginServer(make_plugin(), http=0, announce=False).start()

        # The argument form; the env beats it.
        with mock.patch.dict(os.environ, CLEAN_ENV):
            server = PluginServer(make_plugin(), http=0, bindings=[fake], transports=["http"], announce=False)
            server.start()
            self.assertEqual(server.transports, ["http"])
            server.stop()
        with mock.patch.dict(os.environ, {**CLEAN_ENV, "LANDFLOW_TRANSPORTS": "fakebus"}):
            server = PluginServer(make_plugin(), http=0, bindings=[FakeBinding()], transports=["http"], announce=False)
            server.start()
            self.assertEqual(server.transports, ["fakebus"])
            server.stop()

    def test_max_concurrency_env_and_default_hints(self):
        with mock.patch.dict(os.environ, {**CLEAN_ENV, "LANDFLOW_MAX_CONCURRENCY": "8"}):
            server = PluginServer(make_plugin(), http=0, max_concurrency=4, announce=False)
            self.assertEqual(server.max_concurrency, 8)
        with mock.patch.dict(os.environ, {**CLEAN_ENV, "LANDFLOW_MAX_CONCURRENCY": "nope"}):
            with self.assertRaises(ValueError):
                PluginServer(make_plugin(), http=0, announce=False)
        # Without a server the manifest carries no hints, as before.
        plugin = make_plugin()
        self.assertNotIn("transports", plugin.manifest())
        self.assertNotIn("maxConcurrency", plugin.manifest())
        with mock.patch.dict(os.environ, CLEAN_ENV):
            server = PluginServer(plugin, http_port=0, grpc_port=None, announce=False)  # today's positional signature
            server.start()
            try:
                self.assertEqual(server.transports, ["http"])
                self.assertEqual(plugin.manifest()["transports"], ["http"])
                self.assertNotIn("maxConcurrency", plugin.manifest())
                self.assertIsNotNone(server.http)
                self.assertIsNone(server.grpc)
                self.assertIsInstance(server.bindings[0], HttpBinding)
            finally:
                server.stop()

    def test_bindings_must_be_bindings(self):
        with mock.patch.dict(os.environ, CLEAN_ENV), self.assertRaises(TypeError):
            PluginServer(make_plugin(), http=0, bindings=[object()])  # type: ignore[list-item]


if __name__ == "__main__":
    unittest.main()
