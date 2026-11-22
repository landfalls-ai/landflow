/**
 * C22: the S3 connector against LocalStack's S3 (deploy/compose.infra.yml, profile `aws`: `COMPOSE_BAKE=false docker compose -p
 * landflow-infra -f deploy/compose.infra.yml --profile aws up -d localstack`, http://127.0.0.1:54566). Runs only with
 * LANDFLOW_INTEGRATION=aws, with AWS_SHARED_CREDENTIALS_FILE=/dev/null AWS_CONFIG_FILE=/dev/null. Local only: the endpoint is pinned to
 * a loopback URL (checked first), the keys are dummies, `~/.aws` is never read, and the bucket the test makes is emptied and deleted at the end.
 * The same assertions as the S3 fake's: only the keys under the prefix, the ETag as the version, a changed and a removed object.
 */
import { mkdtempSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { CreateBucketCommand, DeleteBucketCommand, DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const ENABLED = (process.env.LANDFLOW_INTEGRATION ?? '').split(',').map((s) => s.trim()).includes('aws');
const ENDPOINT = (process.env.LANDFLOW_LOCALSTACK_URL ?? 'http://127.0.0.1:54566').replace(/\/+$/, '');
const KEYS = { accessKeyId: 'test', secretAccessKey: 'test' }; // LocalStack takes any keys; these are not real credentials
const BUCKET = `landflow-ks-${Date.now().toString(36)}`;
vi.setConfig({ testTimeout: 30_000 });

describe.skipIf(!ENABLED)('the S3 connector (LocalStack)', () => {
  const signal = new AbortController().signal;
  let admin: S3Client;
  let connector: typeof import('@/lib/server/knowledge-sources/connectors/s3');
  const put = (Key: string, Body: string) => admin.send(new PutObjectCommand({ Bucket: BUCKET, Key, Body }));
  const data = { endpoint: ENDPOINT, region: 'us-east-1', ...KEYS, forcePathStyle: true };

  beforeAll(async () => {
    const host = new URL(ENDPOINT).hostname;
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) throw new Error(`The LocalStack endpoint must be loopback, not ${host}`);
    if (process.env.AWS_SHARED_CREDENTIALS_FILE !== devNull || process.env.AWS_CONFIG_FILE !== devNull) throw new Error('Run with AWS_SHARED_CREDENTIALS_FILE=/dev/null AWS_CONFIG_FILE=/dev/null');
    Object.assign(process.env, { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-ks-ls-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });
    connector = await import('@/lib/server/knowledge-sources/connectors/s3');
    admin = new S3Client({ region: 'us-east-1', endpoint: ENDPOINT, forcePathStyle: true, credentials: KEYS });
    await admin.send(new CreateBucketCommand({ Bucket: BUCKET }));
    await put('guides/install.md', '# Install\n\nRun the installer.\n');
    await put('guides/upgrade.md', '# Upgrade\n\nBack up first.\n');
    await put('other/secret.md', '# Other\n\nNot under the prefix.\n');
  });
  afterAll(async () => {
    if (!admin) return;
    for (const Key of ['guides/install.md', 'guides/upgrade.md', 'other/secret.md', 'guides/new.md']) await admin.send(new DeleteObjectCommand({ Bucket: BUCKET, Key })).catch(() => undefined);
    await admin.send(new DeleteBucketCommand({ Bucket: BUCKET })).catch(() => undefined);
    admin.destroy();
  });

  it('lists only the keys under the prefix with their ETags, reads one, and sees a change and a removal', async () => {
    const source = connector.s3Connector({ bucket: BUCKET, prefix: 'guides/' }, data);
    const first = await source.list(signal, new Map());
    expect(first.complete).toBe(true);
    expect(first.items.map((i) => i.key)).toEqual(['guides/install.md', 'guides/upgrade.md']);
    expect(first.items[0].version).toMatch(/^[0-9a-f]{32}$/);
    expect(new TextDecoder().decode((await source.fetch(first.items[0], signal)).bytes)).toContain('Run the installer.');

    await put('guides/install.md', '# Install\n\nRun the installer twice.\n');
    await put('guides/new.md', '# New\n\nA new page.\n');
    await admin.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: 'guides/upgrade.md' }));
    const second = await source.list(signal, new Map());
    expect(second.items.map((i) => i.key)).toEqual(['guides/install.md', 'guides/new.md']);
    expect(second.items[0].version).not.toBe(first.items[0].version);
  });

  it('a missing bucket is a failure named by S3', async () => {
    await expect(connector.s3Connector({ bucket: `${BUCKET}-missing`, prefix: '' }, data).list(signal, new Map())).rejects.toThrow(/NoSuchBucket/);
  });
});
