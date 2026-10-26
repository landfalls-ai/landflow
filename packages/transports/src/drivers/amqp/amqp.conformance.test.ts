/**
 * The driver conformance suite against the local RabbitMQ container (`deploy/compose.infra.yml`, profile `rabbitmq`).
 * Gated on `LANDFLOW_TEST_AMQP=amqp://<user>:<password>@127.0.0.1:55672` (dev credentials in `deploy/.env.example`);
 * skipped with a message when unset or unreachable. The queues and exchanges the runs created are deleted at the end
 * through the management API (`LANDFLOW_TEST_AMQP_MANAGEMENT`, default http://127.0.0.1:55673, same credentials).
 */
import { createConnection } from 'node:net';
import { afterAll, describe } from 'vitest';
import { runConformance } from '../../conformance';
import { AmqpDriver, type AmqpConfig } from './index';

const url = process.env.LANDFLOW_TEST_AMQP;
const management = process.env.LANDFLOW_TEST_AMQP_MANAGEMENT ?? 'http://127.0.0.1:55673';

async function reachable(target: URL): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: target.hostname, port: Number(target.port) || 5672 }, () => {
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

if (!url) {
  describe.skip('amqp driver (set LANDFLOW_TEST_AMQP=amqp://user:password@127.0.0.1:55672 to run against the local container)', () => {});
} else if (!(await reachable(new URL(url)))) {
  describe.skip(`amqp driver (${new URL(url).host} is not reachable; start it with docker compose -f deploy/compose.infra.yml --profile rabbitmq up -d)`, () => {});
} else {
  const config: AmqpConfig = { connectionId: 'amqp-test', url };
  runConformance({ name: 'amqp', driver: () => new AmqpDriver(), config, deliveryTimeoutMs: 4_000 });

  // Delete the queues and exchanges the runs created (the suite's prefixes are `lfconf.<run>.` and `lfcore<hex>.v1.`).
  afterAll(async () => {
    const target = new URL(url);
    const auth = 'Basic ' + Buffer.from(`${decodeURIComponent(target.username)}:${decodeURIComponent(target.password)}`).toString('base64');
    const vhost = encodeURIComponent(decodeURIComponent(target.pathname.slice(1)) || '/');
    const pattern = /^lfconf\.[0-9a-f]{8}\.|^lfcore[0-9a-f]{6}\.v1\./;
    for (const kind of ['queues', 'exchanges']) {
      const response = await fetch(`${management}/api/${kind}/${vhost}`, { headers: { authorization: auth } }).catch(() => undefined);
      if (!response?.ok) return;
      const items = (await response.json()) as { name: string }[];
      for (const { name } of items) if (pattern.test(name)) await fetch(`${management}/api/${kind}/${vhost}/${encodeURIComponent(name)}`, { method: 'DELETE', headers: { authorization: auth } }).catch(() => undefined);
    }
  }, 60_000);
}
