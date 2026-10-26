/**
 * The driver conformance suite against the Pub/Sub emulator. Gated on `LANDFLOW_TEST_PUBSUB=127.0.0.1:58085` (the
 * `landflow-infra` emulator, project `landflow-dev`); skipped with a message when unset or unreachable. The real service is
 * never used (no `allowCloud`, no credentials). The emulator never expires anything, so every topic and subscription the
 * run creates carries a prefix of its own (`lftest-<random>-`) and is deleted at the end.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, describe } from 'vitest';
import { runConformance } from '../../conformance';
import pubsubModule, { PubSubDriver, type PubSubConfig } from './index';

delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
const host = process.env.LANDFLOW_TEST_PUBSUB;
const project = process.env.LANDFLOW_TEST_PUBSUB_PROJECT ?? 'landflow-dev';
const topicPrefix = `lftest-${randomBytes(3).toString('hex')}-`;

async function reachable(config: PubSubConfig): Promise<string | undefined> {
  const driver = pubsubModule.create();
  try {
    await driver.connect(config);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  } finally {
    await driver.close().catch(() => {});
  }
}

async function deleteResources(config: PubSubConfig): Promise<number> {
  const { PubSub } = await import('@google-cloud/pubsub');
  const client = new PubSub({ projectId: config.projectId, apiEndpoint: config.emulatorHost });
  try {
    let deleted = 0;
    const [subscriptions] = await client.getSubscriptions();
    for (const sub of subscriptions) {
      if (sub.name.includes(`/subscriptions/${topicPrefix}`)) {
        await sub.delete().catch(() => {});
        deleted++;
      }
    }
    const [topics] = await client.getTopics();
    for (const topic of topics) {
      if (topic.name.includes(`/topics/${topicPrefix}`)) {
        await topic.delete().catch(() => {});
        deleted++;
      }
    }
    return deleted;
  } finally {
    await client.close();
  }
}

if (!host) describe.skip('pubsub driver (set LANDFLOW_TEST_PUBSUB=127.0.0.1:58085 to run against the emulator)', () => {});
else {
  // The shortest ack deadline Pub/Sub allows, so a crash case redelivers within the suite's timeouts; the client extends deadlines of running calls.
  const config = pubsubModule.configFrom('pubsub-test', `pubsub://${host}/${project}`, { topicPrefix, ackDeadlineSeconds: 10 });
  const problem = await reachable(config);
  if (problem) describe.skip(`pubsub driver (the emulator at ${host} is not reachable: ${problem})`, () => {});
  else {
    afterAll(async () => {
      await deleteResources(config);
    });
    runConformance({ name: 'pubsub', driver: () => new PubSubDriver(), config, deliveryTimeoutMs: 6_000 });
  }
}
