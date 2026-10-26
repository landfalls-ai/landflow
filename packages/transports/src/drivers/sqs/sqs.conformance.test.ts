/**
 * The driver conformance suite against SQS on LocalStack. Gated on `LANDFLOW_TEST_SQS=http://127.0.0.1:54566` (the
 * `landflow-infra` LocalStack with the `sqs` service); skipped with a message when unset or unreachable. Only the explicit
 * endpoint and the dummy credentials `test`/`test` are ever used, and the shared AWS files are turned off for the process.
 * Every queue the run creates carries a queue prefix of its own (`lftest-<random>-`) and is deleted at the end.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, describe } from 'vitest';
import { runConformance } from '../../conformance';
import sqsModule, { SqsDriver, type SqsConfig } from './index';

process.env.AWS_SHARED_CREDENTIALS_FILE = '/dev/null';
process.env.AWS_CONFIG_FILE = '/dev/null';
const url = process.env.LANDFLOW_TEST_SQS;
const queuePrefix = `lftest-${randomBytes(3).toString('hex')}-`;

async function reachable(config: SqsConfig): Promise<string | undefined> {
  const driver = sqsModule.create();
  try {
    await driver.connect(config);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  } finally {
    await driver.close().catch(() => {});
  }
}

async function deleteQueues(config: SqsConfig): Promise<number> {
  const { SQSClient, ListQueuesCommand, DeleteQueueCommand } = await import('@aws-sdk/client-sqs');
  const client = new SQSClient({ region: config.region, endpoint: config.endpoint, credentials: { accessKeyId: config.accessKeyId!, secretAccessKey: config.secretAccessKey! } });
  try {
    let deleted = 0;
    let token: string | undefined;
    do {
      const listed = await client.send(new ListQueuesCommand({ QueueNamePrefix: queuePrefix, MaxResults: 1000, NextToken: token }));
      for (const queueUrl of listed.QueueUrls ?? []) {
        const path = new URL(queueUrl).pathname;
        await client.send(new DeleteQueueCommand({ QueueUrl: `${config.endpoint}${path}` })).catch(() => {});
        deleted++;
      }
      token = listed.NextToken;
    } while (token);
    return deleted;
  } finally {
    client.destroy();
  }
}

if (!url) describe.skip('sqs driver (set LANDFLOW_TEST_SQS=http://127.0.0.1:54566 to run against LocalStack)', () => {});
else {
  // Short visibility and polls so the crash and requeue cases finish within the suite's timeouts; keep-alives still protect running calls.
  const config = sqsModule.configFrom('sqs-test', url, { username: 'test', password: 'test', queuePrefix, visibilityTimeoutSeconds: 3, waitTimeSeconds: 2, fanoutRefreshMs: 250 });
  const problem = await reachable(config);
  if (problem) describe.skip(`sqs driver (SQS at ${url} is not reachable: ${problem})`, () => {});
  else {
    afterAll(async () => {
      await deleteQueues(config);
    });
    runConformance({ name: 'sqs', driver: () => new SqsDriver(), config, deliveryTimeoutMs: 6_000 });
  }
}
