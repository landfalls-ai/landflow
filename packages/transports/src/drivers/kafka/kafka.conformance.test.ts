/**
 * The driver conformance suite against the local Kafka container (`deploy/compose.infra.yml`, profile `kafka`). Gated on
 * `LANDFLOW_TEST_KAFKA=127.0.0.1:59092`; skipped with a message when unset or unreachable. Every run uses the suite's
 * random channel prefixes; the topics it created are deleted at the end.
 */
import { createConnection } from 'node:net';
import { afterAll, describe } from 'vitest';
import { runConformance } from '../../conformance';
import { KafkaDriver, type KafkaConfig } from './index';

const bootstrap = process.env.LANDFLOW_TEST_KAFKA;

async function reachable(address: string): Promise<boolean> {
  const [host, port] = address.split(':');
  return new Promise((resolve) => {
    const socket = createConnection({ host, port: Number(port) || 9092 }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.setTimeout(1500, () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => resolve(false));
  });
}

if (!bootstrap) {
  describe.skip('kafka driver (set LANDFLOW_TEST_KAFKA=127.0.0.1:59092 to run against the local container)', () => {});
} else if (!(await reachable(bootstrap.split(',')[0]))) {
  describe.skip(`kafka driver (LANDFLOW_TEST_KAFKA=${bootstrap} is not reachable; start it with docker compose -f deploy/compose.infra.yml --profile kafka up -d)`, () => {});
} else {
  const config: KafkaConfig = { connectionId: 'kafka-test', brokers: bootstrap.split(','), partitions: 4 };
  runConformance({ name: 'kafka', driver: () => new KafkaDriver(), config, deliveryTimeoutMs: 15_000 });

  // Delete the topics the runs created (the suite's prefixes are `lfconf.<run>.` and `lfcore<hex>.v1.`).
  afterAll(async () => {
    const { KafkaJS } = (await import('@confluentinc/kafka-javascript')) as unknown as { KafkaJS: any };
    const admin = new KafkaJS.Kafka({ kafkaJS: { brokers: config.brokers, logLevel: 0 } }).admin();
    await admin.connect();
    try {
      const topics = (await admin.listTopics({ timeout: 10_000 })).filter((t: string) => /^lfconf\.[0-9a-f]{8}\.|^lfcore[0-9a-f]{6}\.v1\./.test(t));
      if (topics.length > 0) await admin.deleteTopics({ topics, timeout: 15_000 }).catch(() => undefined);
    } finally {
      await admin.disconnect();
    }
  }, 30_000);
}
