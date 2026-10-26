/**
 * The driver conformance suite against the local ActiveMQ Artemis container (`deploy/compose.infra.yml`, profile
 * `artemis`). Gated on `LANDFLOW_TEST_AMQP1=amqp://<user>:<password>@127.0.0.1:55674` (dev credentials in
 * `deploy/.env.example`); skipped with a message when unset or unreachable. The limit is set explicitly (Artemis has no
 * fixed message limit). The queues and addresses the runs auto-created are deleted at the end through the broker's
 * management address over AMQP (`QueueNames` / `AddressNames`, then `destroyQueue` / `deleteAddress`).
 */
import { randomBytes } from 'node:crypto';
import { createConnection } from 'node:net';
import { afterAll, describe } from 'vitest';
import { runConformance } from '../../conformance';
import { Amqp1Driver, MANAGEMENT_ADDRESS, type Amqp1Config } from './index';

const url = process.env.LANDFLOW_TEST_AMQP1;

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

/** Delete everything matching `pattern` through `activemq.management` on a plain rhea connection. */
async function cleanup(target: URL, pattern: RegExp): Promise<void> {
  const rhea = (await import('rhea')).default;
  const container = rhea.create_container({ id: `lfconf-cleanup-${randomBytes(3).toString('hex')}` });
  const connection = container.connect({ host: target.hostname, port: Number(target.port) || 5672, username: decodeURIComponent(target.username), password: decodeURIComponent(target.password), reconnect: false });
  connection.on('error', () => undefined);
  await new Promise<void>((resolve, reject) => {
    connection.once('connection_open', () => resolve());
    connection.once('disconnected', () => reject(new Error('disconnected')));
  });
  const reply = connection.open_receiver({ source: { dynamic: true } as never, credit_window: 100 });
  await new Promise<void>((resolve) => reply.once('receiver_open', () => resolve()));
  const sender = connection.open_sender({ target: { address: MANAGEMENT_ADDRESS } });
  await new Promise<void>((resolve) => sender.once('sender_open', () => resolve()));
  const waiters = new Map<string, (body: unknown) => void>();
  reply.on('message', (context) => waiters.get(String(context.message!.correlation_id))?.(context.message!.body));
  const call = (properties: Record<string, string>, body: unknown[] = []) =>
    new Promise<unknown>((resolve) => {
      const id = randomBytes(6).toString('hex');
      const timer = setTimeout(() => resolve(undefined), 5_000);
      waiters.set(id, (value) => {
        clearTimeout(timer);
        waiters.delete(id);
        resolve(value);
      });
      sender.send({ reply_to: reply.source.address, correlation_id: id, application_properties: { _AMQ_ResourceName: 'broker', ...properties }, body: JSON.stringify(body) });
    });
  const names = async (attribute: string): Promise<string[]> => {
    const raw = await call({ _AMQ_Attribute: attribute });
    const parsed = typeof raw === 'string' ? (JSON.parse(raw) as unknown[]) : [];
    return (Array.isArray(parsed[0]) ? (parsed[0] as string[]) : []).filter((name) => pattern.test(name));
  };
  for (const queue of await names('QueueNames')) await call({ _AMQ_OperationName: 'destroyQueue' }, [queue, true, true]);
  for (const address of await names('AddressNames')) await call({ _AMQ_OperationName: 'deleteAddress' }, [address, true]);
  connection.close();
}

if (!url) {
  describe.skip('amqp1 driver (set LANDFLOW_TEST_AMQP1=amqp://user:password@127.0.0.1:55674 to run against the local container)', () => {});
} else if (!(await reachable(new URL(url)))) {
  describe.skip(`amqp1 driver (${new URL(url).host} is not reachable; start it with docker compose -f deploy/compose.infra.yml --profile artemis up -d)`, () => {});
} else {
  const config: Amqp1Config = { connectionId: 'amqp1-test', url, maxMessageBytes: 1024 * 1024 };
  runConformance({ name: 'amqp1', driver: () => new Amqp1Driver(), config, deliveryTimeoutMs: 4_000 });

  // The suite's prefixes are `lfconf.<run>.` and `lfcore<hex>.v1.`.
  afterAll(async () => {
    await cleanup(new URL(url), /^lfconf\.[0-9a-f]{8}\.|^lfcore[0-9a-f]{6}\.v1\./).catch(() => undefined);
  }, 60_000);
}
