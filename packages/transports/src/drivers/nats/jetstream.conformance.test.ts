/**
 * The driver conformance suite against a real NATS server with JetStream. Gated on `LANDFLOW_TEST_NATS=nats://127.0.0.1:54222`
 * (the `nats` profile of deploy/compose.infra.yml, started with `--jetstream`); skipped with a message when unset or
 * unreachable. Every stream (and its consumers) the run creates carries a stream prefix of its own and is deleted at the end.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, describe } from 'vitest';
import { runConformance } from '../../conformance';
import jetstreamModule, { NatsDriver, type JetStreamConfig } from './jetstream';

const url = process.env.LANDFLOW_TEST_NATS;
const streamPrefix = `lftest-${randomBytes(3).toString('hex')}-`;

async function reachable(config: JetStreamConfig): Promise<string | undefined> {
  const driver = jetstreamModule.create();
  try {
    await driver.connect({ ...config, connectTimeoutMs: 3_000 });
    return undefined;
  } catch (error) {
    return (error as Error).message;
  } finally {
    await driver.close().catch(() => {});
  }
}

async function deleteStreams(config: JetStreamConfig): Promise<number> {
  const driver = jetstreamModule.create() as NatsDriver<JetStreamConfig>;
  await driver.connect(config);
  try {
    const { jetstreamManager } = await import('@nats-io/jetstream');
    const jsm = await jetstreamManager(driver.connection!);
    let deleted = 0;
    for await (const name of jsm.streams.names()) {
      if (!name.startsWith(streamPrefix)) continue;
      await jsm.streams.delete(name);
      deleted++;
    }
    return deleted;
  } finally {
    await driver.close();
  }
}

if (!url) describe.skip('jetstream driver (set LANDFLOW_TEST_NATS=nats://127.0.0.1:54222 to run)', () => {});
else {
  const config = jetstreamModule.configFrom('jetstream-test', url, { streamPrefix, ackWaitMs: 10_000 });
  const problem = await reachable(config);
  if (problem) describe.skip(`jetstream driver (NATS with JetStream at ${url} is not reachable: ${problem})`, () => {});
  else {
    afterAll(async () => {
      await deleteStreams(config);
    });
    runConformance({ name: 'jetstream', driver: () => jetstreamModule.create(), config, deliveryTimeoutMs: 3_000 });
  }
}
