/**
 * Two processes supersede one brain fact at once (C01/C02; opt-in: LANDFLOW_INTEGRATION=queue): each process holds a copy of the
 * database, so the supersede is a conditional write on Postgres and exactly one wins; the loser's copy then reads the winner's
 * version 2 (the key notice sent from the same transaction). Same database and schema pattern as approval-inbox-cluster-ap1.test.ts.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database } from '@/lib/server/db/database';

const BASE_URL = process.env.LANDFLOW_TEST_DATABASE_URL ?? 'postgres://landflow:landflow-dev-only@127.0.0.1:55432/landflow_test';
const SCHEMA = 'landflow_brain_fact_test';
const URL = `${BASE_URL}${BASE_URL.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${SCHEMA}`)}`;
const enabled = Boolean(process.env.LANDFLOW_INTEGRATION?.split(',').includes('queue'));

vi.setConfig({ testTimeout: 30_000 });

describe.skipIf(!enabled)('brain fact supersede across two processes', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'landflow-pgq-fact-'));
  Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_BRAIN_EMBEDDINGS: 'off', LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });
  const pg = (await import('pg')).default;
  const { openPostgres } = await import('@/lib/server/db/postgres');
  const facts = await import('@/lib/server/brain/facts');
  const { supersedeFact } = await import('@/lib/server/brain/fact-lifecycle');
  const admin = new pg.Pool({ connectionString: URL, max: 2 });
  const tmp = () => mkdtempSync(join(tmpdir(), 'landflow-pgq-fact-db-'));
  const opened: Database[] = [];
  const until = (check: () => void) => vi.waitFor(check, { timeout: 10_000, interval: 25 });
  const versionIn = (db: Database, id: string) => facts.getFact(id, db)?.version;
  let main: Database;
  let worker: Database;

  beforeAll(async () => {
    if (!/_test$/.test(new globalThis.URL(BASE_URL).pathname)) throw new Error(`Refusing to use ${BASE_URL}: its database name must end in _test`);
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    main = await openPostgres(URL, tmp(), { instanceId: 'fact-main' });
    opened.push(main);
    worker = await openPostgres(URL, tmp(), { instanceId: 'fact-worker' });
    opened.push(worker);
  });
  afterAll(async () => {
    for (const db of opened) await db.close().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
  });

  it('exactly one of two simultaneous supersedes wins, and the loser’s copy then reads version 2', async () => {
    for (let i = 0; i < 3; i++) {
      const id = `workflow:wf${i}:health`;
      facts.upsertFact({ subjectType: 'workflow', subjectId: `wf${i}`, kind: 'health', statement: 'fails 2 percent', confidence: 0.6, evidence: [] }, main);
      await main.flush();
      await until(() => expect(versionIn(worker, id)).toBe(1));
      const results = await Promise.allSettled([
        supersedeFact(id, { statement: 'fails 9 percent', expectedVersion: 1 }, {}, main),
        supersedeFact(id, { statement: 'fails 5 percent', expectedVersion: 1 }, {}, worker),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ name: 'StaleChainError', status: 409 });
      const winner = (results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ statement: string }>).value.statement;
      await until(() => expect([versionIn(main, id), versionIn(worker, id)]).toEqual([2, 2]));
      expect([facts.getFact(id, main)?.statement, facts.getFact(id, worker)?.statement]).toEqual([winner, winner]);
      const stored = await admin.query('SELECT version, is_latest FROM brain_facts WHERE root_id = $1 ORDER BY version', [id]);
      expect(stored.rows.map((r) => [Number(r.version), Number(r.is_latest)])).toEqual([[1, 0], [2, 1]]);
    }
  });
});
