/**
 * The driver conformance suite against a real Valkey. Gated on `LANDFLOW_TEST_VALKEY=redis://127.0.0.1:56379` (the
 * `landflow-infra` Valkey, which the app and queue mode share); skipped with a message when unset or unreachable. Every key
 * the run creates carries a key prefix of its own (`landflow-test-<random>:`) and is deleted at the end; never FLUSHDB.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, describe } from 'vitest';
import { runConformance } from '../../conformance';
import valkeyModule, { type ValkeyConfig } from './index';

const url = process.env.LANDFLOW_TEST_VALKEY;
const keyPrefix = `landflow-test-${randomBytes(3).toString('hex')}:`;

async function reachable(config: ValkeyConfig): Promise<string | undefined> {
  const driver = valkeyModule.create();
  try {
    await driver.connect(config);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  } finally {
    await driver.close().catch(() => {});
  }
}

async function deleteKeys(config: ValkeyConfig): Promise<number> {
  const { Redis } = await import('iovalkey');
  const parsed = new URL(config.url);
  const client = new Redis({ host: parsed.hostname, port: parsed.port ? Number(parsed.port) : 6379, username: config.username, password: config.password, db: config.db, lazyConnect: true });
  await client.connect();
  try {
    let cursor = '0';
    let deleted = 0;
    do {
      const [next, keys] = await client.scan(cursor, 'MATCH', `${keyPrefix}*`, 'COUNT', 200);
      cursor = next;
      if (keys.length > 0) deleted += await client.del(...keys);
    } while (cursor !== '0');
    return deleted;
  } finally {
    await client.quit();
  }
}

if (!url) describe.skip('valkey driver (set LANDFLOW_TEST_VALKEY=redis://127.0.0.1:56379 to run)', () => {});
else {
  // A short claim-idle time so the crash cases reclaim within the suite's timeouts; keep-alives still protect running calls.
  const config = valkeyModule.configFrom('valkey-test', url, { keyPrefix, claimIdleMs: 1_500, blockMs: 250 });
  const problem = await reachable(config);
  if (problem) describe.skip(`valkey driver (Valkey at ${url} is not reachable: ${problem})`, () => {});
  else {
    afterAll(async () => {
      await deleteKeys(config);
    });
    runConformance({ name: 'valkey', driver: () => valkeyModule.create(), config, deliveryTimeoutMs: 3_000 });
  }
}
