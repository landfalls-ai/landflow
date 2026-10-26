"""Live driver conformance for the tier 1 brokers in ``landflow-infra``, gated on ``LANDFLOW_TEST_<KIND>``:

    LANDFLOW_TEST_KAFKA=127.0.0.1:59092 LANDFLOW_TEST_AMQP=amqp://landflow:landflow-dev-only@127.0.0.1:55672/ \\
    LANDFLOW_TEST_NATS=nats://127.0.0.1:54222 LANDFLOW_TEST_VALKEY=redis://127.0.0.1:56379 \\
    plugins/py-insights/.venv/bin/python -m unittest discover -s sdks/python/tests -p 'test_transport_live.py'

Each suite skips with a message when its variable is unset, the client library is missing or the broker is not
reachable. Every run uses random channel prefixes; Kafka topics, JetStream streams and Valkey keys the run created are
deleted at the end (Valkey is shared with the app: a unique key prefix, never FLUSHDB).
"""

from __future__ import annotations

import os
import secrets
import socket
import sys
import unittest
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from landflow_sdk.transport import driver_available, load_driver  # noqa: E402
from landflow_sdk.transport.conformance import ConformanceTarget, CoreConformance, DriverConformance  # noqa: E402

KAFKA = os.environ.get("LANDFLOW_TEST_KAFKA")
RABBITMQ = os.environ.get("LANDFLOW_TEST_AMQP") or os.environ.get("LANDFLOW_TEST_RABBITMQ")  # the TS and Go suites use _AMQP
NATS = os.environ.get("LANDFLOW_TEST_NATS")
VALKEY = os.environ.get("LANDFLOW_TEST_VALKEY")
RUN = secrets.token_hex(3)


def reachable(host: str, port: int) -> bool:
    try:
        with socket.create_connection((host, port), timeout=1.5):
            return True
    except OSError:
        return False


def reason_to_skip(kind: str, url: str | None, host: str | None, port: int | None) -> str | None:
    if not url:
        return f"set LANDFLOW_TEST_{kind.upper()} to run against the local container"
    missing = driver_available(kind)
    if missing:
        return missing
    if host and port and not reachable(host, port):
        return f"{url} is not reachable (docker compose -f deploy/compose.infra.yml --profile {kind} up -d)"
    return None


def host_port(url: str | None, default_port: int) -> tuple[str | None, int | None]:
    if not url:
        return None, None
    if "://" not in url:
        url = "tcp://" + url.split(",")[0]
    parts = urlsplit(url)
    return parts.hostname, parts.port or default_port


# --- Kafka ----------------------------------------------------------------------------------------------------------------

_kafka_skip = reason_to_skip("kafka", KAFKA, *host_port(KAFKA, 9092))


def kafka_target(mode: str) -> ConformanceTarget | None:
    if _kafka_skip:
        return None
    module = load_driver("kafka")
    config = module.config_from("kafka-test", KAFKA, {"partitions": 4, "mode": mode})
    return ConformanceTarget(f"kafka-{mode}", module.create, config, delivery_timeout_s=20, batch_acks=mode == "share")


def delete_kafka_topics() -> None:
    from confluent_kafka.admin import AdminClient

    admin = AdminClient({"bootstrap.servers": KAFKA})
    topics = [t for t in admin.list_topics(timeout=10).topics if t.startswith("lfconf.") or t.startswith("lfcore")]
    if topics:
        for future in admin.delete_topics(topics, operation_timeout=15).values():
            try:
                future.result(15)
            except Exception:  # noqa: BLE001
                pass


@unittest.skipIf(_kafka_skip, _kafka_skip)
class KafkaGroupDriverConformance(DriverConformance, unittest.TestCase):
    target = kafka_target("group")

    @classmethod
    def tearDownClass(cls) -> None:
        delete_kafka_topics()


@unittest.skipIf(_kafka_skip, _kafka_skip)
class KafkaGroupCoreConformance(CoreConformance, unittest.TestCase):
    target = kafka_target("group")

    @classmethod
    def tearDownClass(cls) -> None:
        delete_kafka_topics()


@unittest.skipIf(_kafka_skip, _kafka_skip)
class KafkaShareDriverConformance(DriverConformance, unittest.TestCase):
    target = kafka_target("share")

    @classmethod
    def tearDownClass(cls) -> None:
        delete_kafka_topics()


@unittest.skipIf(_kafka_skip, _kafka_skip)
class KafkaShareCoreConformance(CoreConformance, unittest.TestCase):
    target = kafka_target("share")

    @classmethod
    def tearDownClass(cls) -> None:
        delete_kafka_topics()


# --- RabbitMQ -------------------------------------------------------------------------------------------------------------

_amqp_skip = reason_to_skip("amqp", RABBITMQ, *host_port(RABBITMQ, 5672))


def amqp_target() -> ConformanceTarget | None:
    if _amqp_skip:
        return None
    module = load_driver("amqp")
    return ConformanceTarget("amqp", module.create, module.config_from("amqp-test", RABBITMQ, {"queueExpiresMs": 600_000}), delivery_timeout_s=10)


@unittest.skipIf(_amqp_skip, _amqp_skip)
class AmqpDriverConformance(DriverConformance, unittest.TestCase):
    target = amqp_target()


@unittest.skipIf(_amqp_skip, _amqp_skip)
class AmqpCoreConformance(CoreConformance, unittest.TestCase):
    target = amqp_target()


# --- NATS core + JetStream ------------------------------------------------------------------------------------------------

_nats_skip = reason_to_skip("nats", NATS, *host_port(NATS, 4222))


def nats_target(kind: str) -> ConformanceTarget | None:
    if _nats_skip:
        return None
    module = load_driver(kind)
    options = {"streamPrefix": f"lftest-{RUN}-", "ackWaitMs": 2_000} if kind == "jetstream" else {}
    return ConformanceTarget(kind, module.create, module.config_from(f"{kind}-test", NATS, options), delivery_timeout_s=10)


def delete_jetstream_streams() -> None:
    import asyncio

    import nats

    async def run() -> None:
        nc = await nats.connect(NATS)
        js = nc.jetstream()
        try:
            for info in await js.streams_info():
                if info.config.name.startswith(f"lftest-{RUN}-"):
                    await js.delete_stream(info.config.name)
        finally:
            await nc.close()

    asyncio.run(run())


@unittest.skipIf(_nats_skip, _nats_skip)
class NatsDriverConformance(DriverConformance, unittest.TestCase):
    target = nats_target("nats")


@unittest.skipIf(_nats_skip, _nats_skip)
class NatsCoreConformance(CoreConformance, unittest.TestCase):
    target = nats_target("nats")


@unittest.skipIf(_nats_skip, _nats_skip)
class JetStreamDriverConformance(DriverConformance, unittest.TestCase):
    target = nats_target("jetstream")

    @classmethod
    def tearDownClass(cls) -> None:
        delete_jetstream_streams()


@unittest.skipIf(_nats_skip, _nats_skip)
class JetStreamCoreConformance(CoreConformance, unittest.TestCase):
    target = nats_target("jetstream")

    @classmethod
    def tearDownClass(cls) -> None:
        delete_jetstream_streams()


# --- Valkey ---------------------------------------------------------------------------------------------------------------

_valkey_skip = reason_to_skip("valkey", VALKEY, *host_port(VALKEY, 6379))
VALKEY_KEY_PREFIX = f"landflow-test-{RUN}:"


def valkey_target() -> ConformanceTarget | None:
    if _valkey_skip:
        return None
    module = load_driver("valkey")
    # A short claim-idle time so the crash cases reclaim within the suite's timeouts; keep-alives still protect running calls.
    return ConformanceTarget("valkey", module.create, module.config_from("valkey-test", VALKEY, {"keyPrefix": VALKEY_KEY_PREFIX, "claimIdleMs": 1500, "blockMs": 250}), delivery_timeout_s=6)


def delete_valkey_keys() -> None:
    import valkey

    client = valkey.Valkey.from_url(VALKEY)
    try:
        cursor = 0
        while True:
            cursor, keys = client.scan(cursor, match=f"{VALKEY_KEY_PREFIX}*", count=200)
            if keys:
                client.delete(*keys)
            if cursor == 0:
                break
    finally:
        client.close()


@unittest.skipIf(_valkey_skip, _valkey_skip)
class ValkeyDriverConformance(DriverConformance, unittest.TestCase):
    target = valkey_target()

    @classmethod
    def tearDownClass(cls) -> None:
        delete_valkey_keys()


@unittest.skipIf(_valkey_skip, _valkey_skip)
class ValkeyCoreConformance(CoreConformance, unittest.TestCase):
    target = valkey_target()

    @classmethod
    def tearDownClass(cls) -> None:
        delete_valkey_keys()


if __name__ == "__main__":
    unittest.main()
