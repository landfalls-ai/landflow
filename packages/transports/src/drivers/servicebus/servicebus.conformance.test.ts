/**
 * The driver conformance suite against the local Service Bus emulator (`deploy/compose.infra.yml`, profile `servicebus`).
 * Gated on `LANDFLOW_TEST_SERVICEBUS=<connection string or sb://127.0.0.1:55675>`; skipped with a message when unset or
 * unreachable.
 *
 * The emulator cannot create entities at runtime, so the suite's random channel names are mapped onto the fixed entities
 * of `deploy/infra/servicebus/Config.json`: the driver suite's `lfconf.<run>.<name>` request channels onto the queues
 * `lfconf.<name>`, the core suite's `lfcore<hex>.v1.plugin.<id>` channels onto the queue `lfcore.v1.plugin`, and the
 * instance, reply and broadcast channels onto the default `landflow.v1.instance`, `landflow.v1.reply` and
 * `landflow.v1.broadcast` entities. The mapped queues are drained before the run so a previous run's leftovers (TTL 5 min)
 * cannot leak in. Limits are set explicitly: the emulator's link allows 256 KiB per message.
 */
import { createConnection } from 'node:net';
import { beforeAll, describe } from 'vitest';
import { runConformance } from '../../conformance';
import { ServiceBusDriver, servicebusConfigFrom, type ServiceBusConfig } from './index';

const target = process.env.LANDFLOW_TEST_SERVICEBUS;

/** The driver suite's request channels (`lfconf.<run>.<name>`), each with a queue of its own in Config.json. */
export const CONFORMANCE_QUEUES = ['declare', 'roundtrip', 'headers', 'share', 'nack', 'death', 'nobody', 'buffer', 'ttl', 'prefetch', 'order', 'stats', 'big'].map((name) => `lfconf.${name}`);
export const CORE_QUEUE = 'lfcore.v1.plugin';

/** Maps the suite's random channel names onto the pre-declared queues. */
export function conformanceQueueFor(channel: string): string {
  const driverCase = /^lfconf\.[0-9a-f]{8}\.([a-z]+)$/.exec(channel);
  if (driverCase) return `lfconf.${driverCase[1]}`;
  if (/^lfcore[0-9a-f]{6}\.v1\.plugin\./.test(channel)) return CORE_QUEUE;
  return channel;
}

async function reachable(connectionString: string): Promise<boolean> {
  const match = /Endpoint=sb:\/\/([^:;/]+)(?::(\d+))?/i.exec(connectionString);
  if (!match) return false;
  return new Promise((resolve) => {
    const socket = createConnection({ host: match[1], port: Number(match[2]) || 5672 }, () => {
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

if (!target) {
  describe.skip('servicebus driver (set LANDFLOW_TEST_SERVICEBUS=sb://127.0.0.1:55675 to run against the local emulator)', () => {});
} else {
  const base = servicebusConfigFrom('servicebus-test', target);
  if (!(await reachable(base.connectionString))) {
    describe.skip(`servicebus driver (LANDFLOW_TEST_SERVICEBUS=${target} is not reachable; start it with docker compose -f deploy/compose.infra.yml --profile servicebus up -d)`, () => {});
  } else {
    const config: ServiceBusConfig = { ...base, queueFor: conformanceQueueFor, entities: { instanceQueue: 'landflow.v1.instance', replyQueue: 'landflow.v1.reply', broadcastTopic: 'landflow.v1.broadcast' }, maxMessageBytes: 240 * 1024 };

    beforeAll(async () => {
      const { ServiceBusClient } = await import('@azure/service-bus');
      const client = new ServiceBusClient(config.connectionString);
      try {
        for (const queue of [...CONFORMANCE_QUEUES, CORE_QUEUE]) {
          const receiver = client.createReceiver(queue, { receiveMode: 'receiveAndDelete' });
          try {
            for (;;) {
              const batch = await receiver.receiveMessages(100, { maxWaitTimeInMs: 200 });
              if (batch.length === 0) break;
            }
          } finally {
            await receiver.close();
          }
        }
      } finally {
        await client.close();
      }
    }, 120_000);

    runConformance({ name: 'servicebus', driver: () => new ServiceBusDriver(), config, deliveryTimeoutMs: 10_000 });
  }
}
