"""The driver conformance suite (the counterpart of ``@landflow/transports/conformance`` and Go's ``conformance.Run``).

``DriverConformance`` checks a driver's contract against its claimed capabilities; ``CoreConformance`` runs the messaging
core (a ``MessagingClient`` calling a ``MessagingServer``) over it. A driver's test subclasses both with a ``target``::

    class KafkaConformance(DriverConformance, CoreConformance, unittest.TestCase):
        target = ConformanceTarget("kafka", KafkaDriver, config, delivery_timeout_s=15)

Every run uses random channel prefixes (``lfconf.<hex>.`` for driver channels, ``lfcore<hex>`` as the core's channel
prefix), so suites can run side by side on one broker; a test that needs a capability the driver does not claim skips.
"""

from __future__ import annotations

import secrets
import threading
import time
import unittest
from dataclasses import dataclass, replace
from typing import Any, Callable

from ..dispatcher import CancelToken
from .claim import MemoryClaimStore
from .client import MessagingClient
from .driver import BrokerDriver, Capabilities, ChannelSpec, ConsumeOptions, Delivery, NotConnectedError, PublishOptions, WireEvent
from .envelope import now_ms
from .errors import ClaimUnavailableError, ConnectionLostError, ManifestMismatchError, RemoteError, TimeoutError_, UndeliverableError
from .security import Keyring
from .server import DispatchContext, DispatchError, MessagingServer

SECRET = "conformance-s3cret"


@dataclass
class ConformanceTarget:
    name: str
    driver: Callable[[], BrokerDriver]
    config: Any
    #: How long to wait for a delivery (a real broker needs more than the memory one).
    delivery_timeout_s: float = 5.0
    #: ``False`` for brokers whose work-sharing cannot be observed with two consumers in one process.
    two_consumers: bool = True
    #: ``True`` when the client acknowledges in batches and cannot fetch more while one delivery of a batch is held
    #: (Kafka share mode): the "holds further deliveries while prefetch is exhausted" test is skipped.
    batch_acks: bool = False


def wait_for(predicate: Callable[[], bool], timeout_s: float, what: str = "condition") -> None:
    until = time.monotonic() + timeout_s
    while time.monotonic() < until:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError(f"timed out after {timeout_s}s waiting for {what}")


class _Collector:
    """Collects deliveries; ``on_event`` acks (``mode='ack'``), holds (``'hold'``) or runs ``handler``."""

    def __init__(self, mode: str = "ack", handler: Callable[[WireEvent, Delivery], None] | None = None) -> None:
        self.mode = mode
        self.handler = handler
        self.events: list[tuple[WireEvent, Delivery]] = []
        self.lock = threading.Lock()

    def on_event(self, event: WireEvent, delivery: Delivery) -> None:
        with self.lock:
            self.events.append((event, delivery))
        if self.handler is not None:
            self.handler(event, delivery)
        elif self.mode == "ack":
            delivery.ack()

    def __len__(self) -> int:
        with self.lock:
            return len(self.events)

    def bodies(self) -> list[bytes]:
        with self.lock:
            return [e.body for e, _ in self.events]


def _event(body: bytes = b'{"n":1}', **headers: str) -> WireEvent:
    base = {"specversion": "1.0", "id": secrets.token_hex(8), "source": "landflow://host/conf", "type": "dev.landflow.plugin.v1.health.request",
            "time": "2026-01-01T00:00:00.000Z", "datacontenttype": "application/json", "content-type": "application/json"}
    base.update(headers)
    return WireEvent(base, body)


class DriverConformance:
    """Mix into a ``unittest.TestCase`` with a ``target``."""

    target: ConformanceTarget
    _drivers: list[BrokerDriver]

    def setUp(self) -> None:  # noqa: N802
        self.run_id = secrets.token_hex(4)
        self._drivers = []
        self.caps: Capabilities = self.target.driver().capabilities

    def tearDown(self) -> None:  # noqa: N802
        for driver in reversed(self._drivers):
            try:
                driver.close()
            except Exception:  # noqa: BLE001
                pass

    def driver(self) -> BrokerDriver:
        driver = self.target.driver()
        driver.connect(self.target.config)
        self._drivers.append(driver)
        self.caps = driver.capabilities
        return driver

    def channel(self, role: str = "request", durable: bool = True, delivery: str = "shared", ttl_ms: int | None = None) -> ChannelSpec:
        return ChannelSpec(f"lfconf.{self.run_id}.{role}.{secrets.token_hex(3)}", role, delivery, durable, ttl_ms)

    def wait(self, predicate: Callable[[], bool], what: str = "delivery", factor: float = 1.0) -> None:
        wait_for(predicate, self.target.delivery_timeout_s * factor, what)

    def test_declares_its_kind_and_complete_capabilities(self):
        driver = self.target.driver()
        self.assertTrue(driver.kind)
        caps = driver.capabilities
        self.assertIn(caps.replies, ("native", "reply-channel"))
        self.assertIn(caps.undeliverable, ("reported", "inferred", "unknown"))
        self.assertIn(caps.persistence, ("memory", "disk"))
        self.assertGreater(caps.max_message_bytes, 0)
        self.assertIn(caps.latency, ("low", "medium", "high"))

    def test_refuses_to_publish_before_connecting(self):
        driver = self.target.driver()
        with self.assertRaises(NotConnectedError):
            driver.publish("lfconf.nowhere", _event())

    def test_connects_declares_idempotently_and_closes_twice(self):
        driver = self.driver()
        spec = self.channel()
        driver.declare([spec])
        driver.declare([spec, self.channel("control", False, "broadcast", 60_000)])
        driver.close()
        driver.close()

    def test_delivers_a_published_event_with_its_body_intact(self):
        driver = self.driver()
        spec = self.channel()
        driver.declare([spec])
        got = _Collector()
        sub = driver.consume(spec.name, ConsumeOptions(prefetch=4, group=spec.name), got.on_event)
        body = bytes(range(256)) * 4
        self.assertEqual(driver.publish(spec.name, _event(body, subject="x.y", lfdeadline="1793102430000")), "accepted")
        self.wait(lambda: len(got) == 1)
        event, delivery = got.events[0]
        self.assertEqual(event.body, body)
        self.assertEqual(delivery.attempt, 1)
        if self.caps.headers:
            self.assertEqual(event.headers["subject"], "x.y")
            self.assertEqual(event.headers["lfdeadline"], "1793102430000")
            self.assertEqual(event.headers["content-type"].split(";")[0], "application/json")
        else:
            self.assertEqual(event.headers.get("content-type", "application/json").split(";")[0], "application/json")
        sub.close()

    def test_shares_one_channel_between_two_consumers_in_a_group(self):
        if not self.caps.work_sharing or not self.target.two_consumers:
            self.skipTest("no work sharing")
        driver = self.driver()
        spec = self.channel()
        driver.declare([spec])
        a, b = _Collector(), _Collector()
        subs = [driver.consume(spec.name, ConsumeOptions(prefetch=2, group=spec.name), a.on_event), driver.consume(spec.name, ConsumeOptions(prefetch=2, group=spec.name), b.on_event)]
        ids = [f"id-{i}" for i in range(12)]
        for event_id in ids:
            driver.publish(spec.name, _event(id=event_id), PublishOptions(ordering_key=event_id))
        self.wait(lambda: len(a) + len(b) == 12, "12 deliveries", 2)
        time.sleep(0.3)
        self.assertEqual(len(a) + len(b), 12, "each event delivered once")
        seen = sorted(e.headers["id"] for e, _ in a.events + b.events) if self.caps.headers else []
        if self.caps.headers:
            self.assertEqual(seen, sorted(ids))
        for sub in subs:
            sub.close()

    def test_delivers_every_event_to_every_consumer_without_a_group(self):
        driver = self.driver()
        spec = self.channel("control", False, "broadcast", 60_000)
        driver.declare([spec])
        a, b = _Collector(), _Collector()
        subs = [driver.consume(spec.name, ConsumeOptions(prefetch=8, ack_mode="auto"), a.on_event), driver.consume(spec.name, ConsumeOptions(prefetch=8, ack_mode="auto"), b.on_event)]
        time.sleep(0.2)
        for i in range(3):
            driver.publish(spec.name, _event(b'{"i":%d}' % i), PublishOptions(ttl_ms=60_000))
        self.wait(lambda: len(a) == 3 and len(b) == 3, "3 deliveries to each", 2)
        for sub in subs:
            sub.close()

    def test_nack_with_requeue_redelivers_with_the_next_attempt(self):
        if not self.caps.nack:
            self.skipTest("no nack")
        driver = self.driver()
        spec = self.channel()
        driver.declare([spec])
        attempts: list[int] = []

        def handler(_event: WireEvent, delivery: Delivery) -> None:
            attempts.append(delivery.attempt)
            if len(attempts) == 1:
                delivery.nack(requeue=True)
            else:
                delivery.ack()

        got = _Collector(handler=handler)
        sub = driver.consume(spec.name, ConsumeOptions(prefetch=2, group=spec.name), got.on_event)
        driver.publish(spec.name, _event())
        self.wait(lambda: len(attempts) >= 2, "a redelivery", 3)
        if self.caps.attempts:
            self.assertEqual(attempts[:2], [1, 2])
        sub.close()

    def test_nack_without_requeue_drops(self):
        driver = self.driver()
        spec = self.channel()
        driver.declare([spec])
        got = _Collector(handler=lambda _e, d: d.nack(requeue=False))
        sub = driver.consume(spec.name, ConsumeOptions(prefetch=2, group=spec.name), got.on_event)
        driver.publish(spec.name, _event())
        self.wait(lambda: len(got) == 1)
        time.sleep(min(1.0, self.target.delivery_timeout_s / 4))
        self.assertEqual(len(got), 1)
        sub.close()

    def test_hands_the_unacknowledged_deliveries_of_a_closed_consumer_to_another_one(self):
        if not self.caps.nack or not self.target.two_consumers:
            self.skipTest("no redelivery")
        driver = self.driver()
        spec = self.channel()
        driver.declare([spec])
        held = _Collector(mode="hold")
        first = driver.consume(spec.name, ConsumeOptions(prefetch=4, group=spec.name), held.on_event)
        driver.publish(spec.name, _event(b'{"held":true}'))
        self.wait(lambda: len(held) == 1)
        survivor = _Collector()
        second = driver.consume(spec.name, ConsumeOptions(prefetch=4, group=spec.name), survivor.on_event)
        first.close()
        self.wait(lambda: len(survivor) == 1, "the survivor's delivery", 4)
        self.assertEqual(survivor.bodies(), [b'{"held":true}'])
        if self.caps.attempts:
            self.assertGreaterEqual(survivor.events[0][1].attempt, 2)
        second.close()

    def test_reports_an_event_nobody_can_take(self):
        driver = self.driver()
        spec = self.channel()
        driver.declare([spec])
        outcome = driver.publish(spec.name, _event())
        if self.caps.undeliverable == "reported":
            self.assertEqual(outcome, "unroutable")
        else:
            self.assertEqual(outcome, "accepted")

    def test_holds_events_published_before_a_consumer_arrives(self):
        if not self.caps.buffering or self.caps.undeliverable == "reported":
            self.skipTest("no buffering")
        driver = self.driver()
        spec = self.channel()
        driver.declare([spec])
        driver.publish(spec.name, _event(b'{"early":1}'))
        got = _Collector()
        sub = driver.consume(spec.name, ConsumeOptions(prefetch=2, group=spec.name), got.on_event)
        self.wait(lambda: len(got) == 1, "the buffered event", 2)
        self.assertEqual(got.bodies(), [b'{"early":1}'])
        sub.close()

    def test_drops_an_event_whose_ttl_passed_before_delivery(self):
        if not self.caps.ttl or not self.caps.buffering or self.caps.undeliverable == "reported":
            self.skipTest("no TTL on buffered events")
        driver = self.driver()
        spec = self.channel(ttl_ms=100)
        driver.declare([spec])
        driver.publish(spec.name, _event(b'{"stale":1}'), PublishOptions(ttl_ms=100))
        time.sleep(0.4)
        driver.publish(spec.name, _event(b'{"fresh":1}'), PublishOptions(ttl_ms=60_000))
        got = _Collector()
        sub = driver.consume(spec.name, ConsumeOptions(prefetch=2, group=spec.name), got.on_event)
        self.wait(lambda: len(got) >= 1)
        time.sleep(0.3)
        self.assertEqual(got.bodies(), [b'{"fresh":1}'])
        sub.close()

    def test_holds_further_deliveries_while_prefetch_is_exhausted(self):
        if self.target.batch_acks:
            self.skipTest("the client acknowledges per batch: a held delivery blocks the next batch, not the next record")
        driver = self.driver()
        spec = self.channel()
        driver.declare([spec])
        held = _Collector(mode="hold")
        sub = driver.consume(spec.name, ConsumeOptions(prefetch=2, group=spec.name), held.on_event)
        for i in range(5):
            driver.publish(spec.name, _event(b'{"i":%d}' % i))
        self.wait(lambda: len(held) == 2)
        time.sleep(min(1.0, self.target.delivery_timeout_s / 4))
        self.assertEqual(len(held), 2)
        held.events[0][1].ack()
        self.wait(lambda: len(held) == 3, "the third delivery")
        for _event_, delivery in list(held.events):
            delivery.ack()
        self.wait(lambda: len(held) == 5, "every delivery", 2)
        sub.close()

    def test_keeps_events_with_one_ordering_key_in_order(self):
        if not self.caps.ordering_keys:
            self.skipTest("no ordering keys")
        driver = self.driver()
        spec = self.channel()
        driver.declare([spec])
        got = _Collector()
        sub = driver.consume(spec.name, ConsumeOptions(prefetch=1, group=spec.name), got.on_event)
        for i in range(8):
            driver.publish(spec.name, _event(b'{"i":%d}' % i), PublishOptions(ordering_key="k"))
        self.wait(lambda: len(got) == 8, "8 deliveries", 2)
        self.assertEqual(got.bodies(), [b'{"i":%d}' % i for i in range(8)])
        sub.close()

    def test_answers_a_native_request_and_reports_timeout_and_unroutable(self):
        if self.caps.replies != "native":
            self.skipTest("no native replies")
        driver = self.driver()
        spec = self.channel()
        driver.declare([spec])
        if self.caps.undeliverable == "reported":
            self.assertEqual(driver.request(spec.name, _event(), 1000).outcome, "unroutable")

        def handler(event: WireEvent, delivery: Delivery) -> None:
            if event.body == b'{"slow":1}':
                delivery.ack()
                return
            delivery.reply(WireEvent({**event.headers, "type": "dev.landflow.plugin.v1.health.response"}, b'{"reply":1}'))
            delivery.ack()

        sub = driver.consume(spec.name, ConsumeOptions(prefetch=2, group=spec.name), _Collector(handler=handler).on_event)
        outcome = driver.request(spec.name, _event(), int(self.target.delivery_timeout_s * 1000))
        self.assertEqual(outcome.outcome, "replied")
        self.assertEqual(outcome.event.body, b'{"reply":1}')
        self.assertEqual(driver.request(spec.name, _event(b'{"slow":1}'), 300).outcome, "timeout")
        sub.close()

    def test_reports_consumers_in_stats(self):
        driver = self.driver()
        spec = self.channel()
        driver.declare([spec])
        stats = driver.stats(spec.name)
        if self.caps.undeliverable == "inferred":
            self.assertEqual(stats.consumers, 0)
        got = _Collector()
        sub = driver.consume(spec.name, ConsumeOptions(prefetch=2, group=spec.name), got.on_event)
        if self.caps.undeliverable == "inferred":
            self.wait(lambda: (driver.stats(spec.name).consumers or 0) >= 1, "a consumer in stats", 3)
        sub.close()

    def test_carries_an_event_of_half_max_message_bytes(self):
        driver = self.driver()
        spec = self.channel()
        driver.declare([spec])
        got = _Collector()
        sub = driver.consume(spec.name, ConsumeOptions(prefetch=2, group=spec.name), got.on_event)
        body = b"x" * (self.caps.max_message_bytes // 2)
        driver.publish(spec.name, _event(body))
        self.wait(lambda: len(got) == 1, "a big delivery", 2)
        self.assertEqual(len(got.bodies()[0]), len(body))
        sub.close()


# --- the core over the driver ---------------------------------------------------------------------------------------------


class _Fixture:
    """A plugin (server) and a host (client) over fresh drivers, with a scripted dispatcher."""

    def __init__(self, case: "CoreConformance", plugin_id: str = "conf-plugin", **server_options: Any) -> None:
        self.case = case
        self.plugin_id = plugin_id
        self.ring = Keyring(SECRET)
        self.calls: list[tuple[str, Any, DispatchContext]] = []
        self.running = threading.Event()
        self.release = threading.Event()
        self.replicas: list[MessagingServer] = []
        self.manifest = {"protocol": "landflow.plugin/v1", "plugin": {"id": plugin_id, "name": "Conf", "version": "1.0.0"},
                         "nodes": [{"name": "echo", "displayName": "Echo", "description": "", "version": 1, "properties": [], "idempotent": True},
                                   {"name": "once", "displayName": "Once", "description": "", "version": 1, "properties": []}], "maxConcurrency": 2}
        self.server = self.replica(**server_options)
        self.client = MessagingClient(driver=case.target.driver(), config=case.config, keyring=self.ring, stats_interval_ms=0, registry_secret=False, claims=server_options.get("claims"))
        self.client.start()

    def dispatch(self, method: str, body: Any, context: DispatchContext) -> Any:
        self.calls.append((method, body, context))
        if method == "Health":
            return {"status": "ok"}
        if method == "GetManifest":
            return self.manifest
        if method == "Execute":
            params = (body or {}).get("parameters") or {}
            if params.get("fail"):
                raise DispatchError("boom", str(params["fail"]))
            if params.get("raise"):
                raise ValueError("plain failure")
            if params.get("block"):
                self.running.set()
                while not context.cancel.wait(0.02):
                    if self.release.is_set():
                        break
                if context.cancel.is_set():
                    raise RuntimeError("cancelled: " + str(context.cancel.reason))
            return {"outputs": [[{"json": {"echo": body.get("inputs"), "credential": ((body.get("credentials") or {}).get("api") or {}).get("token"), "attempt": context.attempt}}]]}
        raise DispatchError("no such method", "not_found")

    def replica(self, instance_id: str | None = None, **options: Any) -> MessagingServer:
        server = MessagingServer(
            driver=self.case.target.driver(), config=self.case.config, keyring=self.ring, plugin_id=self.plugin_id, version="1.0.0", manifest=self.manifest,
            dispatch=self.dispatch, announce_interval_ms=500, drain_timeout_ms=5000, instance_id=instance_id, **{"registry_secret": False, **options},
        )
        server.start()
        self.replicas.append(server)
        return server

    def execute(self, node: str = "echo", **parameters: Any) -> dict:
        return {"protocol": "landflow.plugin/v1", "executionId": "ex1", "mode": "manual", "node": {"id": "n1", "name": node, "type": f"{self.plugin_id}.{node}", "typeVersion": 1},
                "parameters": parameters, "inputs": [[{"json": {"hello": "world"}}]], "credentials": {"api": {"token": "top-secret"}}}

    def close(self) -> None:
        self.release.set()
        self.client.close()
        for server in self.replicas:
            try:
                server.stop()
            except Exception:  # noqa: BLE001
                pass


class CoreConformance:
    """Mix into a ``unittest.TestCase`` with a ``target``; uses the target's config with a random channel prefix."""

    target: ConformanceTarget

    def setUp(self) -> None:  # noqa: N802
        self.config = replace(self.target.config, prefix=f"lfcore{secrets.token_hex(3)}") if hasattr(self.target.config, "prefix") else self.target.config
        self.caps = self.target.driver().capabilities
        self.timeout_ms = int(self.target.delivery_timeout_s * 1000)
        self.fixture: _Fixture | None = None

    def tearDown(self) -> None:  # noqa: N802
        if self.fixture is not None:
            self.fixture.close()

    def fx(self, **options: Any) -> _Fixture:
        self.fixture = _Fixture(self, **options)
        return self.fixture

    def wait(self, predicate: Callable[[], bool], what: str = "condition", factor: float = 1.0) -> None:
        wait_for(predicate, self.target.delivery_timeout_s * factor, what)

    def test_calls_a_plugin_and_gets_its_reply_with_the_credentials_intact(self):
        fx = self.fx()
        reply = fx.client.invoke(fx.plugin_id, "Execute", fx.execute(), timeout_ms=self.timeout_ms)
        self.assertEqual(reply.body["outputs"][0][0]["json"]["credential"], "top-secret")
        self.assertEqual(reply.instance_id, fx.server.instance_id)
        self.assertEqual(fx.client.call(fx.plugin_id, "Health", {}, timeout_ms=self.timeout_ms), {"status": "ok"})

    def test_fails_with_timeout_at_the_deadline_and_cancels_the_dispatcher(self):
        fx = self.fx()
        with self.assertRaises(TimeoutError_):
            fx.client.call(fx.plugin_id, "Execute", fx.execute(block=True), timeout_ms=600)
        # Either the call ran and its token tripped at the deadline, or a slow broker delivered it after the deadline and the
        # server dropped it as expired without running it.
        self.wait(lambda: fx.calls or fx.server.counters["expired"] >= 1, "the request to reach the plugin", 2)
        self.wait(lambda: fx.server.in_flight_count == 0, "the dispatcher to be cancelled", 2)
        if fx.calls:
            self.assertTrue(fx.calls[-1][2].cancel.is_set())

    def test_sends_a_cancel_when_the_caller_cancels(self):
        fx = self.fx()
        token = CancelToken()
        box: dict = {}

        def run() -> None:
            try:
                fx.client.call(fx.plugin_id, "Execute", fx.execute(block=True), timeout_ms=self.timeout_ms * 2, cancel=token)
            except Exception as exc:  # noqa: BLE001
                box["error"] = exc

        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        self.assertTrue(fx.running.wait(self.target.delivery_timeout_s * 2), "the call never started")
        token.cancel("user stopped")
        thread.join(self.target.delivery_timeout_s * 2)
        self.assertEqual(type(box.get("error")).__name__, "CancelledError")
        self.wait(lambda: fx.server.in_flight_count == 0, "the plugin to cancel the call", 2)
        self.assertEqual(fx.calls[-1][2].cancel.reason, "cancelled by the host")

    def test_rejects_a_call_cancelled_before_publishing_as_undeliverable(self):
        fx = self.fx()
        token = CancelToken()
        token.cancel()
        with self.assertRaises(UndeliverableError) as caught:
            fx.client.call(fx.plugin_id, "Health", {}, cancel=token)
        self.assertEqual(caught.exception.reason, "aborted")

    def test_uses_at_most_once_by_default_and_at_least_once_only_for_repeatable_work(self):
        fx = self.fx()
        fx.client.call(fx.plugin_id, "Execute", fx.execute("once"), timeout_ms=self.timeout_ms)
        self.assertEqual(fx.calls[-1][2].delivery, "at-most-once")
        fx.client.call(fx.plugin_id, "Execute", fx.execute("once"), timeout_ms=self.timeout_ms, delivery="at-least-once")
        self.assertEqual(fx.calls[-1][2].delivery, "at-most-once")
        fx.client.call(fx.plugin_id, "Execute", fx.execute("echo"), timeout_ms=self.timeout_ms, delivery="at-least-once")
        self.assertEqual(fx.calls[-1][2].delivery, "at-least-once")
        fx.client.call(fx.plugin_id, "Health", {}, timeout_ms=self.timeout_ms)
        self.assertEqual(fx.calls[-1][2].delivery, "at-least-once")

    def test_a_replica_that_dies_mid_call_at_least_once_moves_to_the_survivor(self):
        if not self.caps.nack or not self.target.two_consumers:
            self.skipTest("no redelivery")
        fx = self.fx()
        box: dict = {}

        def run() -> None:
            try:
                box["reply"] = fx.client.invoke(fx.plugin_id, "Execute", fx.execute("echo", block=True), timeout_ms=self.timeout_ms * 4, delivery="at-least-once")
            except Exception as exc:  # noqa: BLE001
                box["error"] = exc

        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        self.assertTrue(fx.running.wait(self.target.delivery_timeout_s * 2))
        fx.running.clear()
        fx.replica(instance_id="survivor")
        # The first replica dies while the call runs: its connection goes away without a withdraw or a reply.
        fx.server.state = "stopped"
        fx.server.driver.close()
        fx.release.set()
        thread.join(self.target.delivery_timeout_s * 6)
        self.assertIn("reply", box, box.get("error"))
        self.assertEqual(box["reply"].instance_id, "survivor")
        if self.caps.attempts:
            self.assertGreaterEqual(box["reply"].body["outputs"][0][0]["json"]["attempt"], 2)

    def test_discovers_plugins_on_the_registry_channel_and_forgets_them_on_withdraw(self):
        fx = self.fx()
        self.wait(lambda: fx.client.plugin(fx.plugin_id) is not None, "the announce", 2)
        plugin = fx.client.plugin(fx.plugin_id)
        self.assertEqual(plugin.manifest_hash, fx.server.manifest_hash)
        self.assertEqual(plugin.endpoint, fx.client.endpoint_of(fx.plugin_id))
        self.assertEqual([i.instance_id for i in plugin.instances], [fx.server.instance_id])
        fx.server.stop()
        self.wait(lambda: fx.client.plugin(fx.plugin_id).instances == [], "the withdraw", 2)

    def test_ignores_announces_without_a_valid_registry_proof(self):
        fx = self.fx()
        strict = MessagingClient(driver=self.target.driver(), config=self.config, keyring=fx.ring, stats_interval_ms=0, registry_secret="registry-s3cret")
        strict.start()
        try:
            proven = fx.replica(instance_id="proven", registry_secret="registry-s3cret")
            self.wait(lambda: strict.plugin(fx.plugin_id) is not None and any(i.instance_id == "proven" for i in strict.plugin(fx.plugin_id).instances), "the proven instance", 2)
            time.sleep(0.6)
            self.assertEqual([i.instance_id for i in strict.plugin(fx.plugin_id).instances], ["proven"])
            proven.stop()
        finally:
            strict.close()

    def test_answers_manifest_mismatch_after_one_requeue(self):
        fx = self.fx()
        with self.assertRaises(ManifestMismatchError) as caught:
            fx.client.call(fx.plugin_id, "Health", {}, timeout_ms=self.timeout_ms * 2, manifest_hash="0123456789abcdef")
        self.assertEqual(caught.exception.actual, fx.server.manifest_hash)
        self.assertEqual(fx.server.counters["dispatched"], 0)
        if self.caps.nack:
            self.assertEqual(fx.server.counters["requeued"], 1)

    def test_drops_tampered_unsigned_and_foreign_key_requests(self):
        fx = self.fx()
        foreign = MessagingClient(driver=self.target.driver(), config=self.config, keyring=Keyring("another"), stats_interval_ms=0, registry_secret=False, discovery=False)
        foreign.start()
        try:
            with self.assertRaises(TimeoutError_):
                foreign.call(fx.plugin_id, "Health", {}, timeout_ms=800)
        finally:
            foreign.close()
        self.wait(lambda: fx.server.counters["dropped"] >= 1, "the drop")
        self.assertEqual(fx.server.counters["dispatched"], 0)

    def test_refuses_a_call_bigger_than_the_broker_limit_before_publishing(self):
        fx = self.fx()
        with self.assertRaises(UndeliverableError) as caught:
            fx.client.call(fx.plugin_id, "Execute", fx.execute(blob="x" * (self.caps.max_message_bytes + 1024)), timeout_ms=self.timeout_ms)
        self.assertEqual(caught.exception.reason, "too_large")

    def _blob(self, extra: int = 4096) -> str:
        return "x" * (self.caps.max_message_bytes + extra)

    def test_carries_an_oversized_call_and_reply_by_reference_through_a_claim_store(self):
        if self.caps.max_message_bytes > 12 * 1024 * 1024:
            self.skipTest("limit over 12 MiB")
        claims = MemoryClaimStore()
        during: list[int] = []
        fx = self.fx(claims=claims)
        original = fx.dispatch

        def watching(method: str, body: Any, context: DispatchContext) -> Any:
            during.append(len(claims.keys()))
            return original(method, body, context)

        fx.server.dispatch = watching
        # `echo` is idempotent, so an at-least-once request is held until after the reply: its body must still be in the store while the node runs.
        reply = fx.client.invoke(fx.plugin_id, "Execute", fx.execute(blob=self._blob()), timeout_ms=self.timeout_ms * 4, delivery="at-least-once")
        self.assertEqual(reply.body["outputs"][0][0]["json"]["credential"], "top-secret")
        self.assertEqual(claims.counters["puts"], 1)  # the reply is small: only the request went by reference
        self.assertEqual(during, [1])
        self.wait(lambda: not claims.keys(), "claims deleted")
        # And a reply too big for the broker goes by reference too.
        big = fx.client.invoke(fx.plugin_id, "Execute", {**fx.execute(), "inputs": [[{"json": {"blob": self._blob()}}]]}, timeout_ms=self.timeout_ms * 4)
        self.assertEqual(len(big.body["outputs"][0][0]["json"]["echo"][0][0]["json"]["blob"]), self.caps.max_message_bytes + 4096)
        self.wait(lambda: not claims.keys(), "claims deleted")
        self.assertEqual(claims.counters["puts"], 3)

    def test_without_a_claim_store_an_oversized_reply_answers_too_large_and_a_store_outage_is_undelivered(self):
        if self.caps.max_message_bytes > 12 * 1024 * 1024:
            self.skipTest("limit over 12 MiB")
        fx = self.fx()
        fx.server.dispatch = lambda method, body, context: {"outputs": [[{"json": {"blob": self._blob()}}]]}
        with self.assertRaises(RemoteError) as caught:
            fx.client.call(fx.plugin_id, "Execute", fx.execute(), timeout_ms=self.timeout_ms)
        self.assertEqual(caught.exception.remote_code, "too_large")
        claims = MemoryClaimStore()
        fx.client.claims = claims
        fx.client.codec.claims = claims
        claims.fail_next = "put"
        with self.assertRaises(UndeliverableError) as undelivered:
            fx.client.call(fx.plugin_id, "Execute", fx.execute(blob=self._blob()), timeout_ms=self.timeout_ms)
        self.assertEqual(undelivered.exception.reason, "claim_failed")

    def test_fails_a_call_whose_request_claim_is_gone_as_not_delivered(self):
        if self.caps.max_message_bytes > 12 * 1024 * 1024:
            self.skipTest("limit over 12 MiB")

        class Vanishing(MemoryClaimStore):
            def put(self, key: str, body: bytes) -> None:
                super().put(key, body)
                self.objects.pop(key, None)  # expired between the sender's put and the receiver's get

        fx = self.fx(claims=Vanishing())
        with self.assertRaises(ClaimUnavailableError) as caught:
            fx.client.call(fx.plugin_id, "Execute", fx.execute(blob=self._blob()), timeout_ms=self.timeout_ms)
        self.assertEqual(caught.exception.knowledge, "not-delivered")
        self.assertEqual([c for c in fx.calls if c[0] == "Execute"], [])

    def test_fails_a_call_to_a_plugin_nobody_consumes(self):
        fx = self.fx()
        if self.caps.undeliverable == "reported":
            with self.assertRaises(UndeliverableError) as caught:
                fx.client.call("ghost-plugin", "Health", {}, timeout_ms=self.timeout_ms)
            self.assertEqual(caught.exception.reason, "unroutable")
        else:
            with self.assertRaises(TimeoutError_):
                fx.client.call("ghost-plugin", "Health", {}, timeout_ms=500)

    def test_runs_at_most_max_concurrency_calls_at_once_per_instance(self):
        fx = self.fx()  # maxConcurrency 2 from the manifest
        results: list = []
        peak = {"n": 0}
        original = fx.dispatch

        def counting(method: str, body: Any, context: DispatchContext) -> Any:
            peak["n"] = max(peak["n"], fx.server.in_flight_count)
            return original(method, body, context)

        fx.server.dispatch = counting

        def call() -> None:
            try:
                results.append(fx.client.call(fx.plugin_id, "Execute", fx.execute(block=True), timeout_ms=self.timeout_ms * 4))
            except Exception as exc:  # noqa: BLE001
                results.append(exc)

        threads = [threading.Thread(target=call, daemon=True) for _ in range(4)]
        for thread in threads:
            thread.start()
        self.wait(lambda: fx.server.in_flight_count == 2, "two calls in flight", 2)
        time.sleep(0.3)
        self.assertEqual(fx.server.in_flight_count, 2)
        fx.release.set()
        for thread in threads:
            thread.join(self.target.delivery_timeout_s * 4)
        self.assertEqual(len([r for r in results if isinstance(r, dict)]), 4, results)
        self.assertLessEqual(peak["n"], 2)

    def test_drains_stop_waits_for_the_call_in_flight(self):
        fx = self.fx()
        box: dict = {}

        def run() -> None:
            try:
                box["reply"] = fx.client.call(fx.plugin_id, "Execute", fx.execute(block=True), timeout_ms=self.timeout_ms * 2)
            except Exception as exc:  # noqa: BLE001
                box["error"] = exc

        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        self.assertTrue(fx.running.wait(self.target.delivery_timeout_s * 2))
        stopper = threading.Thread(target=fx.server.stop, daemon=True)
        stopper.start()
        time.sleep(0.3)
        self.assertTrue(stopper.is_alive(), "stop() must wait for the call")
        fx.release.set()
        thread.join(self.target.delivery_timeout_s * 2)
        stopper.join(self.target.delivery_timeout_s * 2)
        self.assertIn("reply", box, box.get("error"))

    def test_reaches_one_instance_through_its_instance_channel(self):
        fx = self.fx()
        second = fx.replica(instance_id="second")
        for _ in range(3):
            self.assertEqual(fx.client.invoke(fx.plugin_id, "Health", {}, timeout_ms=self.timeout_ms, instance_id="second").instance_id, "second")
        second.stop()

    def test_fails_pending_calls_with_connection_lost_when_the_client_closes(self):
        fx = self.fx()
        box: dict = {}

        def run() -> None:
            try:
                fx.client.call(fx.plugin_id, "Execute", fx.execute(block=True), timeout_ms=self.timeout_ms * 2)
            except Exception as exc:  # noqa: BLE001
                box["error"] = exc

        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        self.assertTrue(fx.running.wait(self.target.delivery_timeout_s * 2))
        fx.client.close()
        thread.join(self.target.delivery_timeout_s)
        self.assertIsInstance(box.get("error"), ConnectionLostError)
        fx.release.set()

    def test_propagates_trace_context_attempt_and_the_subject(self):
        fx = self.fx()
        traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
        reply = fx.client.invoke(fx.plugin_id, "Execute", fx.execute(), timeout_ms=self.timeout_ms, traceparent=traceparent, tracestate="a=b", attempt=3)
        context = fx.calls[-1][2]
        self.assertEqual((context.traceparent, context.tracestate), (traceparent, "a=b"))
        self.assertEqual(reply.attributes.traceparent, traceparent)
        self.assertEqual(reply.attributes.subject, f"{fx.plugin_id}.echo")
        self.assertEqual(context.source, f"landflow://host/{fx.client.host_instance_id}")

    def test_maps_dispatch_error_codes_and_plain_errors_onto_lferror(self):
        fx = self.fx()
        for code in ("not_found", "bad_request", "unavailable"):
            with self.assertRaises(RemoteError) as caught:
                fx.client.call(fx.plugin_id, "Execute", fx.execute(fail=code), timeout_ms=self.timeout_ms)
            self.assertEqual(caught.exception.remote_code, code)
            self.assertEqual(str(caught.exception), "boom")
        with self.assertRaises(RemoteError) as caught:
            fx.client.call(fx.plugin_id, "Execute", fx.execute(**{"raise": True}), timeout_ms=self.timeout_ms)
        self.assertEqual(caught.exception.remote_code, "internal")
        with self.assertRaises(RemoteError) as caught:
            fx.client.call(fx.plugin_id, "TestCredentials", {}, timeout_ms=self.timeout_ms)
        self.assertEqual(caught.exception.remote_code, "not_found")


def conformance_case(target: ConformanceTarget, name: str = "Conformance") -> type[unittest.TestCase]:
    """A ``TestCase`` class running both suites against ``target`` (for ``load_tests`` hooks)."""
    return type(name, (DriverConformance, CoreConformance, unittest.TestCase), {"target": target})


__all__ = ["ConformanceTarget", "CoreConformance", "DriverConformance", "conformance_case", "wait_for", "now_ms"]
