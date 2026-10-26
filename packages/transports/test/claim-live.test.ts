/**
 * The claim check end to end over a real broker with a real S3-compatible store (MinIO). Skips without both:
 *
 *   LANDFLOW_TEST_NATS=nats://127.0.0.1:54222 LANDFLOW_TEST_CLAIM_S3=http://127.0.0.1:59000 LANDFLOW_CLAIM_ACCESS_KEY_ID=landflow \
 *   LANDFLOW_CLAIM_SECRET_ACCESS_KEY=landflow-dev-only AWS_SHARED_CREDENTIALS_FILE=/dev/null AWS_CONFIG_FILE=/dev/null npx vitest run test/claim-live.test.ts
 */
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecuteRequest } from '@landflow/protocol';
import { S3ClaimStore, Keyring, MessagingClient, MessagingServer, silentLogger, UndeliverableError } from '../src';
import natsModule from '../src/drivers/nats';

const nats = process.env.LANDFLOW_TEST_NATS;
const s3 = process.env.LANDFLOW_TEST_CLAIM_S3;

describe.skipIf(!nats || !s3)('claim check over NATS with MinIO', () => {
  const cleanups: (() => Promise<unknown>)[] = [];
  afterEach(async () => void (await Promise.allSettled(cleanups.splice(0).reverse().map((fn) => fn()))));

  it('carries a 3 MiB call and reply through the bucket and leaves it empty', async () => {
    const prefix = `lfclaim${randomBytes(3).toString('hex')}`;
    const store = new S3ClaimStore({ bucket: process.env.LANDFLOW_TEST_CLAIM_BUCKET ?? 'landflow', prefix: `claims-live-${prefix}/`, endpoint: s3, accessKeyId: process.env.LANDFLOW_CLAIM_ACCESS_KEY_ID, secretAccessKey: process.env.LANDFLOW_CLAIM_SECRET_ACCESS_KEY });
    cleanups.push(() => store.close());
    const keyring = new Keyring('claim-live-secret');
    const config = natsModule.configFrom('claim-live', nats!, { prefix });
    const id = `live-${randomBytes(3).toString('hex')}`;
    const manifest = { protocol: 'landflow.plugin/v1', plugin: { id, name: 'Live', version: '1.0.0', language: 'typescript' }, nodes: [], maxConcurrency: 2 } as never;
    const server = await MessagingServer.start({
      driver: natsModule.create(), config, keyring, pluginId: id, version: '1.0.0', manifest, registrySecret: null, announceIntervalMs: 200, log: silentLogger, claims: store,
      dispatch: async (_m, body) => ({ outputs: (body as unknown as ExecuteRequest).inputs }) as never,
    });
    cleanups.push(() => server.stop());
    const client = await MessagingClient.start({ driver: natsModule.create(), config, keyring, registrySecret: null, log: silentLogger, statsIntervalMs: 0, claims: store });
    cleanups.push(() => client.close());
    await expect.poll(() => client.plugin(id)?.instances.length ?? 0, { timeout: 5000 }).toBe(1);
    const blob = 'x'.repeat(3 * 1024 * 1024);
    const request = { protocol: 'landflow.plugin/v1', executionId: 'e', mode: 'manual', node: { id: 'n', name: 'echo', type: `${id}.echo`, typeVersion: 1 }, parameters: {}, itemParameters: [{}], inputs: [[{ json: { blob } }]], credentials: {} } as unknown as ExecuteRequest;
    const reply = await client.call(id, 'Execute', request, { timeoutMs: 20_000 });
    expect((reply.outputs[0][0].json as { blob: string }).blob.length).toBe(blob.length);
    await expect.poll(async () => (await store.list('claims/')).length, { timeout: 5000 }).toBe(0);
    // Without the store the same call is provably undelivered.
    const plain = await MessagingClient.start({ driver: natsModule.create(), config, keyring, registrySecret: null, log: silentLogger, statsIntervalMs: 0 });
    cleanups.push(() => plain.close());
    await expect(plain.call(id, 'Execute', request, { timeoutMs: 5000 })).rejects.toMatchObject({ reason: 'too_large' });
    expect(UndeliverableError).toBeDefined();
  }, 60_000);
});
