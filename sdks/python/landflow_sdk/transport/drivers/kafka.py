"""The Kafka driver (kind ``kafka``; Apache Kafka, Redpanda) on ``confluent-kafka`` (librdkafka), docs/protocol.md §14.9.

Mapping, the same wire as ``@landflow/transports/kafka`` and ``sdks/go/transport/kafka``: a **topic** per channel;
CloudEvents Kafka binding in binary mode (``ce_`` headers, ``content-type`` bare); record key = the ordering key.
Shared channels (request, instance) are consumed in one of two modes (``KafkaConfig.mode``, ``LANDFLOW_KAFKA_MODE``):

- ``group`` (default, as the TypeScript driver; any Kafka, Redpanda, and **mixed TS and Python replicas of one plugin**): a
  consumer group with manual commits; ``ack()`` commits ``offset + 1``, ``nack(requeue=True)`` and a graceful close
  re-publish the record with a driver-private ``lf-attempt`` header (dropped by ``unprefix_headers``) and commit the
  original; a record re-read after a hard crash is attempt 1. The group protocol is KIP-848 ``consumer`` by default,
  ``classic`` for older brokers and Redpanda.
- ``share`` (as the Go driver's default; Kafka 4.2+ with share groups on): a **share group** named after the channel
  through the client's ``ShareConsumer`` (confluent-kafka 2.16+): per-record acknowledgement (``ACCEPT`` / ``RELEASE``),
  ``delivery_count`` as the attempt, the group's ``share.auto.offset.reset=earliest`` set through the admin API so events
  published before the first replica wait for it. A record a dead replica held is released by the broker after its lock
  (30 s by default) and redelivered. The client polls **batches** and, in explicit mode, must acknowledge every record of
  a batch before polling again: a long at-least-once call holds the batch, and a call longer than the lock is redelivered.
  Mixed Go and Python replicas need the same mode on both (``LANDFLOW_KAFKA_MODE=group`` on the Go side, or ``share`` here).

Broadcast channels (reply, registry, control) are read with a standalone assignment positioned at the end of every
partition, so nothing older is replayed. ``declare()`` creates topics idempotently (request/instance: ``partitions``,
default 6; the rest: 1 partition and a short retention), ``stats()`` reads the group's members and lag, ``close()``
deletes the reply and instance topics this driver declared. Threads: one poll thread per subscription hands records to
a ``HandlerPool`` of ``prefetch`` workers; acknowledgements are queued back to the poll thread (the consumer handle is
used from one thread only); the producer is thread-safe and every ``publish()`` waits for its delivery report.
"""

from __future__ import annotations

import logging
import queue
import re
import secrets
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable

from ..driver import (
    BrokerConfig,
    BrokerDriver,
    Capabilities,
    ChannelSpec,
    ChannelStats,
    ConsumeHandler,
    ConsumeOptions,
    Delivery,
    HandlerPool,
    NotConnectedError,
    PublishOptions,
    SimpleDriverModule,
    Subscription,
    WireEvent,
    prefix_headers,
    unprefix_headers,
)
from . import _import_client

log = logging.getLogger("landflow_sdk.transport.kafka")

KAFKA_HEADER_PREFIX = "ce_"
ATTEMPT_HEADER = "lf-attempt"
DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024
_TOPIC_SIZE_SLACK = 4096
_DEFAULT_PARTITIONS = 6
_DEFAULT_RETENTION_MS = 24 * 60 * 60_000
_EPHEMERAL_RETENTION_MS = 60 * 60_000
_ADMIN_TIMEOUT_S = 15.0

KAFKA_CAPABILITIES = Capabilities(
    replies="reply-channel", work_sharing=True, buffering=True, ttl=False, undeliverable="inferred", persistence="disk",
    max_message_bytes=DEFAULT_MAX_MESSAGE_BYTES, latency="high", headers=True, ordering_keys=True, nack=True, attempts=True,
)


@dataclass
class KafkaConfig(BrokerConfig):
    #: Bootstrap servers, ``host:port`` each.
    brokers: list[str] = field(default_factory=list)
    client_id: str = "landflow"
    ssl: bool = False
    sasl_mechanism: str | None = None
    username: str | None = None
    password: str | None = None
    #: ``group`` (consumer group, the default: the TypeScript driver's mode, so TS and Python replicas mix) or ``share`` (share group; Kafka 4.2+).
    mode: str = "group"
    #: Consumer group protocol in ``group`` mode: ``consumer`` (KIP-848) or ``classic``.
    group_protocol: str = "consumer"
    partitions: int = _DEFAULT_PARTITIONS
    replication_factor: int = -1
    max_message_bytes: int = DEFAULT_MAX_MESSAGE_BYTES
    retention_ms: int = _DEFAULT_RETENTION_MS
    publish_timeout_ms: int = 30_000
    connect_timeout_ms: int = 10_000
    #: Extra librdkafka properties applied to every client.
    rdkafka: dict[str, Any] = field(default_factory=dict)


def record_headers(raw: list[tuple[str, bytes | None]] | None) -> dict[str, str]:
    """Header tuples as the client hands them -> one string per name (the last value wins)."""
    out: dict[str, str] = {}
    for name, value in raw or []:
        if value is None:
            continue
        out[name] = value.decode("utf-8", "replace") if isinstance(value, (bytes, bytearray)) else str(value)
    return out


class _KafkaDelivery(Delivery):
    def __init__(self, attempt: int, ack: Callable[[], None], nack: Callable[[bool], None]) -> None:
        self.attempt = attempt
        self._ack = ack
        self._nack = nack
        self._settled = False
        self._lock = threading.Lock()

    def _settle(self) -> bool:
        with self._lock:
            if self._settled:
                return False
            self._settled = True
            return True

    def ack(self) -> None:
        if self._settle():
            self._ack()

    def nack(self, *, requeue: bool = False) -> None:
        if self._settle():
            self._nack(requeue)


class _KafkaSubscription(Subscription):
    def __init__(self, channel: str, close: Callable[[], None]) -> None:
        self.channel = channel
        self._close = close

    def close(self) -> None:
        self._close()


class KafkaDriver(BrokerDriver):
    kind = "kafka"

    def __init__(self) -> None:
        self.capabilities = KAFKA_CAPABILITIES.copy()
        self._config: KafkaConfig | None = None
        self._ck: Any = None
        self._producer: Any = None
        self._admin: Any = None
        self._state = "new"
        self._declared: dict[str, ChannelSpec] = {}
        self._subscriptions: set[_KafkaSubscription] = set()
        self._lock = threading.Lock()

    # --- lifecycle --------------------------------------------------------------------------------------------------------

    def _common(self) -> dict[str, Any]:
        config = self._config
        assert config is not None
        props: dict[str, Any] = {"bootstrap.servers": ",".join(config.brokers), "client.id": config.client_id, "broker.address.family": "v4", "log_level": 0}
        if config.ssl:
            props["security.protocol"] = "SASL_SSL" if config.username else "SSL"
        if config.username:
            props.setdefault("security.protocol", "SASL_PLAINTEXT")
            props["sasl.mechanism"] = (config.sasl_mechanism or "plain").upper().replace("SCRAM-SHA-", "SCRAM-SHA-")
            props["sasl.username"] = config.username
            props["sasl.password"] = config.password or ""
        props.update(config.rdkafka)
        return props

    def connect(self, config: KafkaConfig) -> None:
        if self._state != "new":
            raise RuntimeError(f"kafka driver already {self._state}")
        if not config.brokers:
            raise RuntimeError("kafka: no brokers configured")
        if config.mode not in ("share", "group"):
            raise RuntimeError(f'kafka: mode must be "share" or "group", got {config.mode!r}')
        ck = _import_client("kafka")
        from confluent_kafka.admin import AdminClient

        self._config = config
        self._ck = ck
        self.capabilities.max_message_bytes = config.max_message_bytes
        if config.mode == "share":
            # Share groups are not listed by the consumer-group admin calls, so stats() cannot infer consumers: say so.
            self.capabilities.undeliverable = "unknown"
        admin = AdminClient(self._common())
        producer = ck.Producer({**self._common(), "acks": "all", "enable.idempotence": True, "message.max.bytes": config.max_message_bytes + _TOPIC_SIZE_SLACK,
                                "message.timeout.ms": config.publish_timeout_ms, "linger.ms": 0})
        try:
            admin.list_topics(timeout=config.connect_timeout_ms / 1000)
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(f"kafka: cannot connect to {','.join(config.brokers)}: {exc}") from exc
        self._admin = admin
        self._producer = producer
        self._state = "connected"

    def close(self) -> None:
        if self._state != "connected":
            self._state = "closed"
            return
        # Subscriptions first, while the producer still works: a closing consumer re-publishes what it held for a survivor.
        for subscription in list(self._subscriptions):
            try:
                subscription.close()
            except Exception:  # noqa: BLE001
                pass
        self._state = "closed"
        ephemeral = [spec.name for spec in self._declared.values() if spec.role in ("reply", "instance")]
        if ephemeral:
            try:
                for future in self._admin.delete_topics(ephemeral, operation_timeout=_ADMIN_TIMEOUT_S).values():
                    future.result(_ADMIN_TIMEOUT_S)
            except Exception:  # noqa: BLE001
                pass
        self._declared.clear()
        try:
            self._producer.flush(5)
        except Exception:  # noqa: BLE001
            pass
        self._producer = None
        self._admin = None

    def _ensure(self) -> KafkaConfig:
        if self._state != "connected" or self._config is None:
            raise NotConnectedError(f"kafka driver is {'not connected' if self._state == 'new' else self._state}")
        return self._config

    # --- declare ------------------------------------------------------------------------------------------------------------

    def declare(self, channels: list[ChannelSpec]) -> None:
        config = self._ensure()
        from confluent_kafka.admin import NewTopic

        fresh = []
        seen: set[str] = set()
        for spec in channels:
            if spec.name in self._declared or spec.name in seen:
                continue
            seen.add(spec.name)
            fresh.append(spec)
        if not fresh:
            return
        max_bytes = str(config.max_message_bytes + _TOPIC_SIZE_SLACK)
        topics = []
        for spec in fresh:
            shared = spec.delivery == "shared"
            retention = spec.ttl_ms if spec.ttl_ms is not None else (config.retention_ms if spec.durable else _EPHEMERAL_RETENTION_MS)
            topic_config = {"retention.ms": str(retention), "max.message.bytes": max_bytes}
            if not spec.durable:
                topic_config["segment.ms"] = str(max(60_000, min(retention, _EPHEMERAL_RETENTION_MS)))
            topics.append(NewTopic(spec.name, num_partitions=config.partitions if shared else 1, replication_factor=config.replication_factor, config=topic_config))
        for attempt in range(1, 4):
            try:
                for name, future in self._admin.create_topics(topics, operation_timeout=_ADMIN_TIMEOUT_S).items():
                    try:
                        future.result(_ADMIN_TIMEOUT_S)
                    except Exception as exc:  # noqa: BLE001
                        if "already exists" not in str(exc).lower() and "TOPIC_ALREADY_EXISTS" not in str(exc):
                            raise RuntimeError(f"kafka: cannot create topic {name}: {exc}") from exc
                break
            except RuntimeError:
                raise
            except Exception as exc:  # noqa: BLE001
                if attempt == 3 or not re.search(r"Timed out|transport failure|Broker handle destroyed", str(exc)):
                    raise RuntimeError(f"kafka: cannot create topics: {exc}") from exc
                time.sleep(0.1 * attempt)
        for spec in fresh:
            self._declared[spec.name] = spec

    # --- publish ------------------------------------------------------------------------------------------------------------

    def _produce(self, topic: str, key: bytes | str | None, body: bytes, headers: dict[str, str]) -> None:
        config = self._ensure()
        box: dict[str, Any] = {}
        done = threading.Event()

        def on_delivery(error: Any, _msg: Any) -> None:
            box["error"] = error
            done.set()

        producer = self._producer
        producer.produce(topic, value=body, key=key, headers=list(headers.items()), on_delivery=on_delivery)
        until = time.monotonic() + config.publish_timeout_ms / 1000 + 1
        while not done.is_set() and time.monotonic() < until:
            producer.poll(0.05)
        if not done.is_set():
            raise RuntimeError(f"kafka: no delivery report for {topic} within {config.publish_timeout_ms} ms")
        if box.get("error") is not None:
            raise RuntimeError(f"kafka: publish to {topic} failed: {box['error']}")

    def publish(self, channel: str, event: WireEvent, options: PublishOptions | None = None) -> str:
        key = options.ordering_key if options and options.ordering_key else None
        self._produce(channel, key, event.body, prefix_headers(event.headers, KAFKA_HEADER_PREFIX))
        return "accepted"

    # --- consume ------------------------------------------------------------------------------------------------------------

    def consume(self, channel: str, options: ConsumeOptions, on_event: ConsumeHandler) -> Subscription:
        config = self._ensure()
        if not options.group:
            return self._consume_broadcast(channel, options, on_event)
        if config.mode == "share":
            return self._consume_share(channel, options, on_event)
        return self._consume_group(channel, options, on_event)

    def _consumer_props(self, group_id: str) -> dict[str, Any]:
        return {**self._common(), "group.id": group_id, "enable.auto.commit": False, "auto.offset.reset": "earliest", "max.poll.interval.ms": 600_000}

    def _consume_broadcast(self, channel: str, options: ConsumeOptions, on_event: ConsumeHandler) -> Subscription:
        """Every event from now on: a standalone assignment at the end of every partition (no group join, no rebalance)."""
        ck = self._ck
        consumer = ck.Consumer({**self._consumer_props(f"lf-bc-{secrets.token_hex(6)}"), "auto.offset.reset": "latest"})
        try:
            # A topic declared a moment ago may not be in every broker's metadata yet: ask again for a few seconds.
            until = time.monotonic() + _ADMIN_TIMEOUT_S
            while True:
                metadata = consumer.list_topics(channel, timeout=_ADMIN_TIMEOUT_S)
                topic = metadata.topics.get(channel)
                if topic is not None and topic.error is None and topic.partitions:
                    break
                if time.monotonic() >= until:
                    raise RuntimeError(f"topic {channel} is unknown: {topic.error if topic else 'no metadata'}")
                time.sleep(0.2)
            consumer.assign([ck.TopicPartition(channel, p, ck.OFFSET_END) for p in topic.partitions])
        except Exception as exc:  # noqa: BLE001
            consumer.close()
            raise RuntimeError(f"kafka: cannot consume {channel}: {exc}") from exc
        closed = threading.Event()
        pool = HandlerPool(max(1, options.prefetch), f"kafka-{channel}")

        def loop() -> None:
            try:
                while not closed.is_set():
                    msg = consumer.poll(0.2)
                    if msg is None or msg.error() is not None:
                        continue
                    raw = record_headers(msg.headers())
                    event = WireEvent(unprefix_headers(raw, KAFKA_HEADER_PREFIX), msg.value() or b"")
                    delivery = _KafkaDelivery(1, lambda: None, lambda _r: None)
                    if pool.acquire():
                        pool.submit(lambda e=event, d=delivery: on_event(e, d))
            finally:
                try:
                    consumer.close()
                except Exception:  # noqa: BLE001
                    pass

        thread = threading.Thread(target=loop, name=f"kafka-broadcast-{channel}", daemon=True)
        thread.start()

        def close() -> None:
            if closed.is_set():
                return
            closed.set()
            self._subscriptions.discard(subscription)
            pool.close()
            thread.join(5)

        subscription = _KafkaSubscription(channel, close)
        self._subscriptions.add(subscription)
        return subscription

    def _consume_group(self, channel: str, options: ConsumeOptions, on_event: ConsumeHandler) -> Subscription:
        """A consumer group with manual commits; a requeue re-publishes the record with ``lf-attempt``."""
        ck = self._ck
        config = self._ensure()
        group_id = options.group or channel
        manual = options.ack_mode == "manual"
        props = self._consumer_props(group_id)
        props["group.protocol"] = config.group_protocol
        if config.group_protocol == "classic":
            props.update({"session.timeout.ms": 10_000, "heartbeat.interval.ms": 3_000})
        consumer = ck.Consumer(props)
        closed = threading.Event()
        pool = HandlerPool(max(1, options.prefetch), f"kafka-{channel}", release_on_return=not manual)
        commands: queue.Queue[Callable[[], None]] = queue.Queue()
        held: dict[int, Any] = {}  # id(record) -> record
        committed: dict[tuple[str, int], int] = {}
        lock = threading.Lock()

        def commit(topic: str, partition: int, offset: int) -> None:
            key = (topic, partition)
            if committed.get(key, -1) >= offset + 1:
                return
            committed[key] = offset + 1
            try:
                consumer.commit(offsets=[ck.TopicPartition(topic, partition, offset + 1)], asynchronous=False)
            except Exception:  # noqa: BLE001
                committed.pop(key, None)

        def republish(record: Any, attempt: int) -> None:
            headers = record_headers(record.headers())
            headers[ATTEMPT_HEADER] = str(attempt + 1)
            self._produce(record.topic(), record.key(), record.value() or b"", headers)

        def on_revoke(_consumer: Any, partitions: list[Any]) -> None:
            # Commit what this consumer still holds on a partition that leaves it, so the new owner does not re-run it.
            revoked = {(p.topic, p.partition) for p in partitions}
            with lock:
                records = [r for r in held.values() if (r.topic(), r.partition()) in revoked]
            for record in records:
                commit(record.topic(), record.partition(), record.offset())

        def run(fn: Callable[[], None]) -> None:
            """Run ``fn`` on the poll thread and wait for it (the consumer handle stays single-threaded)."""
            if threading.current_thread() is thread:
                fn()
                return
            done = threading.Event()
            box: dict[str, BaseException] = {}

            def wrapped() -> None:
                try:
                    fn()
                except BaseException as exc:  # noqa: BLE001
                    box["error"] = exc
                finally:
                    done.set()

            if closed.is_set():
                return
            commands.put(wrapped)
            done.wait(_ADMIN_TIMEOUT_S)
            if "error" in box:
                raise box["error"]

        def deliver(record: Any) -> None:
            raw = record_headers(record.headers())
            attempt = int(raw.get(ATTEMPT_HEADER) or 1) if (raw.get(ATTEMPT_HEADER) or "1").isdigit() else 1
            event = WireEvent(unprefix_headers(raw, KAFKA_HEADER_PREFIX), record.value() or b"")
            topic, partition, offset = record.topic(), record.partition(), record.offset()
            if manual:
                with lock:
                    held[id(record)] = record

            def settle() -> bool:
                """``False`` once the subscription closed: the record was handed back already, a late ack/nack must not touch it."""
                with lock:
                    orphaned = closed.is_set()
                    held.pop(id(record), None)
                if manual:
                    pool.release()
                return not orphaned

            def ack() -> None:
                if settle():
                    run(lambda: commit(topic, partition, offset))

            def nack(requeue: bool) -> None:
                if not settle():
                    return
                if requeue:
                    try:
                        republish(record, attempt)
                    except Exception:  # noqa: BLE001
                        return  # left uncommitted: a survivor re-reads it
                run(lambda: commit(topic, partition, offset))

            delivery = _KafkaDelivery(attempt, ack, nack)
            if not manual:
                run(lambda: commit(topic, partition, offset))

            def handle() -> None:
                try:
                    on_event(event, delivery)
                except Exception:  # noqa: BLE001
                    delivery.nack(requeue=False)

            pool.submit(handle)

        def loop() -> None:
            try:
                while not closed.is_set():
                    while True:
                        try:
                            commands.get_nowait()()
                        except queue.Empty:
                            break
                    if not pool.acquire(timeout=0.2):
                        continue
                    msg = consumer.poll(0.2)
                    if msg is None or msg.error() is not None:
                        pool.release()
                        continue
                    deliver(msg)
                # Hand the unacknowledged deliveries back: commit the originals, leave the group, re-publish them for a survivor.
                with lock:
                    orphans = list(held.values())
                    held.clear()
                for record in orphans:
                    commit(record.topic(), record.partition(), record.offset())
                try:
                    consumer.close()
                except Exception:  # noqa: BLE001
                    pass
                for record in orphans:
                    try:
                        raw = record_headers(record.headers())
                        republish(record, int(raw.get(ATTEMPT_HEADER) or 1))
                    except Exception:  # noqa: BLE001
                        pass
            except Exception as exc:  # noqa: BLE001
                log.warning("kafka consumer loop for %s ended: %s", channel, exc)

        try:
            consumer.subscribe([channel], on_revoke=on_revoke, on_lost=on_revoke)
        except Exception as exc:  # noqa: BLE001
            consumer.close()
            raise RuntimeError(f"kafka: cannot consume {channel} (group {group_id}): {exc}") from exc
        thread = threading.Thread(target=loop, name=f"kafka-group-{channel}", daemon=True)
        thread.start()
        # Wait for an assignment (a consumer may legitimately own none).
        until = time.monotonic() + 10
        while time.monotonic() < until:
            try:
                if run_assignment(consumer, run):
                    break
            except Exception:  # noqa: BLE001
                break
            time.sleep(0.05)

        def close() -> None:
            if closed.is_set():
                return
            closed.set()
            self._subscriptions.discard(subscription)
            pool.close()
            thread.join(_ADMIN_TIMEOUT_S)

        subscription = _KafkaSubscription(channel, close)
        self._subscriptions.add(subscription)
        return subscription

    def _share_group_config(self, group_id: str) -> None:
        """``share.auto.offset.reset=earliest`` is a *group* config in Kafka (not a client property as in franz-go): set it through
        the admin API before the first member joins, so events published before the first replica wait for it."""
        try:
            from confluent_kafka.admin import AlterConfigOpType, ConfigEntry, ConfigResource, ResourceType

            resource = ConfigResource(ResourceType.GROUP, group_id, incremental_configs=[ConfigEntry("share.auto.offset.reset", "earliest", incremental_operation=AlterConfigOpType.SET)])
            for future in self._admin.incremental_alter_configs([resource]).values():
                future.result(_ADMIN_TIMEOUT_S)
        except Exception as exc:  # noqa: BLE001 - an older broker: the group starts at the latest offset
            log.warning("kafka: cannot set share.auto.offset.reset=earliest on group %s (%s); events published before the first replica may be skipped", group_id, exc)

    def _consume_share(self, channel: str, options: ConsumeOptions, on_event: ConsumeHandler) -> Subscription:
        """A share group (KIP-932): per-record ACCEPT / RELEASE through the client's ``ShareConsumer``."""
        ck = self._ck
        group_id = options.group or channel
        manual = options.ack_mode == "manual"
        props = {**self._common(), "group.id": group_id, "share.acknowledgement.mode": "explicit", "max.poll.interval.ms": 600_000}
        self._share_group_config(group_id)
        try:
            consumer = ck.ShareConsumer(props)
            consumer.subscribe([channel])
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(f"kafka: cannot open a share consumer for {channel} (group {group_id}); use mode=group on brokers without share groups: {exc}") from exc
        closed = threading.Event()
        pool = HandlerPool(max(1, options.prefetch), f"kafka-{channel}", release_on_return=not manual)
        commands: queue.Queue[Callable[[], None]] = queue.Queue()
        held: dict[int, Any] = {}
        lock = threading.Lock()
        accept, release = ck.AcknowledgeType.ACCEPT, ck.AcknowledgeType.RELEASE

        def deliver(record: Any) -> None:
            raw = record_headers(record.headers())
            count = record.delivery_count()
            attempt = int(count) if isinstance(count, int) and count > 0 else 1
            event = WireEvent(unprefix_headers(raw, KAFKA_HEADER_PREFIX), record.value() or b"")
            if manual:
                with lock:
                    held[id(record)] = record

            def acknowledge(kind: Any) -> None:
                with lock:
                    orphaned = closed.is_set()
                    held.pop(id(record), None)
                if manual:
                    pool.release()
                if not orphaned:
                    commands.put(lambda: consumer.acknowledge(record, kind))

            delivery = _KafkaDelivery(attempt, lambda: acknowledge(accept), lambda requeue: acknowledge(release if requeue else accept))
            if not manual:
                acknowledge(accept)

            def handle() -> None:
                try:
                    on_event(event, delivery)
                except Exception:  # noqa: BLE001
                    delivery.nack(requeue=False)

            pool.submit(handle)

        def drain_commands() -> None:
            """Apply queued acknowledgements and send them now (the client would otherwise send them on the next poll only)."""
            applied = 0
            while True:
                try:
                    commands.get_nowait()()
                    applied += 1
                except queue.Empty:
                    break
                except Exception as exc:  # noqa: BLE001
                    log.debug("share acknowledge failed: %s", exc)
            if applied:
                try:
                    consumer.commit_async()
                except Exception as exc:  # noqa: BLE001
                    log.debug("share commit failed: %s", exc)

        def loop() -> None:
            # poll() returns a batch, and in explicit mode every record of the batch must be acknowledged before the next
            # poll: a held delivery (an at-least-once call still running) therefore holds the whole consumer, which is the
            # share group's own prefetch; the pool bounds the handlers to `prefetch` as everywhere else.
            try:
                while not closed.is_set():
                    drain_commands()
                    if not pool.acquire(timeout=0.2):
                        continue
                    pool.release()
                    try:
                        batch = consumer.poll(0.2)
                    except Exception as exc:  # noqa: BLE001
                        log.debug("kafka share poll on %s: %s", channel, exc)
                        closed.wait(0.2)
                        continue
                    records = [m for m in (batch or []) if m is not None and m.error() is None]
                    for record in records:
                        if not pool.acquire():
                            with lock:
                                held[id(record)] = record  # released as an orphan below
                            continue
                        deliver(record)
                    while not closed.is_set():
                        drain_commands()
                        with lock:
                            pending = any(id(r) in held for r in records)
                        if not pending:
                            break
                        closed.wait(0.02)
                drain_commands()
                with lock:
                    orphans = list(held.values())
                    held.clear()
                for record in orphans:
                    try:
                        consumer.acknowledge(record, release)
                    except Exception:  # noqa: BLE001
                        pass
                try:
                    consumer.commit_sync()
                except Exception:  # noqa: BLE001
                    pass
                try:
                    consumer.close()
                except Exception:  # noqa: BLE001
                    pass
            except Exception as exc:  # noqa: BLE001
                log.warning("kafka share consumer loop for %s ended: %s", channel, exc)

        thread = threading.Thread(target=loop, name=f"kafka-share-{channel}", daemon=True)
        thread.start()
        time.sleep(0.2)

        def close() -> None:
            if closed.is_set():
                return
            closed.set()
            self._subscriptions.discard(subscription)
            pool.close()
            thread.join(_ADMIN_TIMEOUT_S)

        subscription = _KafkaSubscription(channel, close)
        self._subscriptions.add(subscription)
        return subscription

    # --- stats -------------------------------------------------------------------------------------------------------------

    def stats(self, channel: str) -> ChannelStats:
        config = self._ensure()
        ck = self._ck
        out = ChannelStats()
        try:
            if config.mode == "share":
                groups = self._admin.list_groups(timeout=_ADMIN_TIMEOUT_S) if hasattr(self._admin, "list_groups") else []
                members = 0
                for group in groups:
                    if getattr(group, "id", None) == channel:
                        members = len(getattr(group, "members", []) or [])
                out.consumers = members
            else:
                description = self._admin.describe_consumer_groups([channel]).get(channel)
                group = description.result(_ADMIN_TIMEOUT_S) if description else None
                state = str(getattr(group, "state", "")).lower()
                out.consumers = len(group.members) if group is not None and "dead" not in state else 0
        except Exception:  # noqa: BLE001
            out.consumers = 0
        try:
            from confluent_kafka.admin import ConsumerGroupTopicPartitions, OffsetSpec

            metadata = self._admin.list_topics(channel, timeout=_ADMIN_TIMEOUT_S).topics.get(channel)
            if metadata is None or metadata.error is not None:
                return out
            partitions = [ck.TopicPartition(channel, p) for p in metadata.partitions]
            ends = {tp.partition: f.result(_ADMIN_TIMEOUT_S).offset for tp, f in self._admin.list_offsets({tp: OffsetSpec.latest() for tp in partitions}).items()}
            starts = {tp.partition: f.result(_ADMIN_TIMEOUT_S).offset for tp, f in self._admin.list_offsets({tp: OffsetSpec.earliest() for tp in partitions}).items()}
            committed: dict[int, int] = {}
            if config.mode == "group":
                result = self._admin.list_consumer_group_offsets([ConsumerGroupTopicPartitions(channel, partitions)])
                for future in result.values():
                    for tp in future.result(_ADMIN_TIMEOUT_S).topic_partitions:
                        if tp.offset >= 0:
                            committed[tp.partition] = tp.offset
            lag = sum(max(0, ends[p] - committed.get(p, starts.get(p, 0))) for p in ends)
            out.lag = lag
            out.depth = lag
        except Exception:  # noqa: BLE001
            pass
        return out


def run_assignment(consumer: Any, run: Callable[[Callable[[], None]], None]) -> bool:
    box: dict[str, Any] = {}

    def fetch() -> None:
        box["assignment"] = consumer.assignment()

    run(fetch)
    return bool(box.get("assignment"))


_SASL = ("plain", "scram-sha-256", "scram-sha-512")


def kafka_config_from(connection_id: str, url: str, options: dict[str, Any] | None = None) -> KafkaConfig:
    """Broker list from ``kafka://h1:9092,h2:9092``, ``kafkas://…`` / ``kafka+ssl://…`` (TLS) or a bare ``h1:9092,h2`` list;
    a username turns on SASL with ``saslMechanism`` (default ``plain``)."""
    options = dict(options or {})
    trimmed = (url or "").strip()
    if not trimmed:
        raise ValueError("Kafka needs a broker list, e.g. kafka://127.0.0.1:9092")
    match = re.match(r"^(?:(kafka|kafkas|kafka\+ssl|kafka\+tls)://)?([^/?#]+)(?:/.*)?$", trimmed, re.I)
    if not match or (re.match(r"^[a-z][a-z0-9+.-]*://", trimmed, re.I) and not match.group(1)):
        raise ValueError(f'"{url}" is not a Kafka URL; use kafka://host:port[,host:port…]')
    scheme = (match.group(1) or "").lower()
    ssl = bool(options.get("tls")) or (scheme not in ("", "kafka"))
    brokers = []
    for part in [p.strip() for p in match.group(2).split(",") if p.strip()]:
        host_port = re.match(r"^(\[[^\]]+\]|[^:@]+)(?::(\d{1,5}))?$", part)
        if not host_port:
            raise ValueError(f'"{part}" is not a host:port (credentials belong in the username and password fields)')
        port = int(host_port.group(2)) if host_port.group(2) else 9092
        if not 1 <= port <= 65535:
            raise ValueError(f'"{part}" has an invalid port')
        brokers.append(f"{host_port.group(1)}:{port}")
    if not brokers:
        raise ValueError("Kafka needs at least one broker")
    mechanism = str(options.get("saslMechanism") or "plain").lower()
    if options.get("username") and mechanism not in _SASL:
        raise ValueError(f'SASL mechanism "{mechanism}" is not one of {", ".join(_SASL)}')
    config = KafkaConfig(connection_id=connection_id, prefix=options.get("prefix") or None, brokers=brokers, ssl=ssl)
    if options.get("username"):
        config.username, config.password, config.sasl_mechanism = str(options["username"]), str(options.get("password") or ""), mechanism
    mode = str(options.get("mode") or "group").lower()
    if mode not in ("share", "group"):
        raise ValueError(f'Kafka mode "{mode}" must be "share" or "group"')
    config.mode = mode
    if options.get("groupProtocol") in ("consumer", "classic"):
        config.group_protocol = str(options["groupProtocol"])
    for key, attr in (("partitions", "partitions"), ("maxMessageBytes", "max_message_bytes"), ("retentionMs", "retention_ms")):
        if options.get(key) not in (None, ""):
            setattr(config, attr, int(options[key]))
    return config


def kafka(brokers: str | list[str], *, connection_id: str = "env-kafka", **options: Any) -> "BrokerTarget":
    """SDK helper: ``serve(plugin, brokers=[kafka("127.0.0.1:59092")])`` or ``kafka(["h1:9092", "h2:9092"], mode="group")``."""
    from ..binding import BrokerTarget

    url = brokers if isinstance(brokers, str) else ",".join(brokers)
    return BrokerTarget("kafka", kafka_config_from(connection_id, url, options), KafkaDriver)


MODULE = SimpleDriverModule(kind="kafka", label="Kafka", capabilities=KAFKA_CAPABILITIES, create=KafkaDriver, config_from=kafka_config_from,
                            example_url="kafka://broker-1:9092,broker-2:9092", extras=("kafka",))
