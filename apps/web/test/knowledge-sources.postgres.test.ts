/**
 * C22 (FR-8): one sync per knowledge source across two processes on a real Postgres (opt-in: LANDFLOW_INTEGRATION=queue). A main
 * and a worker (each with its in-memory copy) claim one source at once: exactly one wins; the lease holds until it runs out; a renewal
 * and a release by a run that no longer holds the claim change nothing; a lease that ran out is freed once, whoever asks. Uses
 * LANDFLOW_TEST_DATABASE_URL, default the infra stack's `landflow_test` database, in a schema of its own
 * (`landflow_knowledge_sources_test`, dropped after).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database } from '@/lib/server/db/database';

const BASE_URL = process.env.LANDFLOW_TEST_DATABASE_URL ?? 'postgres://landflow:landflow-dev-only@127.0.0.1:55432/landflow_test';
const SCHEMA = 'landflow_knowledge_sources_test';
const URL = `${BASE_URL}${BASE_URL.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${SCHEMA}`)}`;
const enabled = Boolean(process.env.LANDFLOW_INTEGRATION?.split(',').includes('queue'));

vi.setConfig({ testTimeout: 60_000 });

describe.skipIf(!enabled)('knowledge source claims across two processes on Postgres', async () => {
  const pg = (await import('pg')).default;
  const { openPostgres } = await import('@/lib/server/db/postgres');
  const claim = await import('@/lib/server/knowledge-sources/claim');
  const admin = new pg.Pool({ connectionString: URL, max: 2 });
  const tmp = () => mkdtempSync(join(tmpdir(), 'landflow-pgks-'));
  const opened: Database[] = [];
  const previous = { mode: process.env.LANDFLOW_EXECUTIONS_MODE, dataDir: process.env.LANDFLOW_DATA_DIR };
  let main: Database;
  let worker: Database;
  const T0 = Date.UTC(2030, 0, 1, 9, 0, 0);
  const holder = async (id: string) => (await admin.query<{ run_id: string | null }>('SELECT run_id FROM knowledge_source_state WHERE source_id = $1', [id])).rows[0]?.run_id ?? null;

  beforeAll(async () => {
    if (!/_test$/.test(new globalThis.URL(BASE_URL).pathname)) throw new Error(`Refusing to use ${BASE_URL}: its database name must end in _test`);
    process.env.LANDFLOW_EXECUTIONS_MODE = 'queue';
    process.env.LANDFLOW_DATA_DIR = tmp();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    main = await openPostgres(URL, tmp(), { instanceId: 'ks-main' });
    worker = await openPostgres(URL, tmp(), { instanceId: 'ks-worker' });
    opened.push(main, worker);
  });

  afterAll(async () => {
    for (const db of opened) await db.close().catch(() => {});
    for (const [key, value] of [['LANDFLOW_EXECUTIONS_MODE', previous.mode], ['LANDFLOW_DATA_DIR', previous.dataDir]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
  });

  it('lets exactly one of thirty simultaneous claims win, whichever process makes it', async () => {
    const claims = Array.from({ length: 30 }, (_, i) => claim.claimSource('src_race', `run-${i}`, T0, i % 2 ? main : worker));
    const results = await Promise.all(claims);
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = `run-${results.indexOf(true)}`;
    expect(await holder('src_race')).toBe(winner);
    // each process's copy agrees with Postgres once replication has caught up, or reads it back
    expect(claim.stateOf('src_race', main)?.run_id ?? winner).toBe(winner);
  });

  it('holds the lease until it runs out, then the other process may take it', async () => {
    expect(await claim.claimSource('src_lease', 'run-a', T0, main)).toBe(true);
    expect(await claim.claimSource('src_lease', 'run-b', T0 + 1000, worker)).toBe(false);
    await claim.renewLease('src_lease', 'run-a', T0 + claim.LEASE_MS - 1000, main);
    expect(await claim.claimSource('src_lease', 'run-b', T0 + claim.LEASE_MS + 1000, worker)).toBe(false); // renewed: still held
    expect(await claim.claimSource('src_lease', 'run-b', T0 + claim.LEASE_MS * 3, worker)).toBe(true);
    expect(await holder('src_lease')).toBe('run-b');
  });

  it('a release or a renewal by a run that lost the claim changes nothing; the holder releases and sets the next time', async () => {
    await claim.claimSource('src_release', 'run-a', T0, main);
    await claim.releaseSource('src_release', 'run-other', null, undefined, worker);
    await claim.renewLease('src_release', 'run-other', T0 + 5000, worker);
    expect(await holder('src_release')).toBe('run-a');
    await claim.releaseSource('src_release', 'run-a', new Date(T0 + 3600_000).toISOString(), undefined, main);
    expect(await holder('src_release')).toBeNull();
    const next = (await admin.query<{ next_at: string }>('SELECT next_at FROM knowledge_source_state WHERE source_id = $1', ['src_release'])).rows[0].next_at;
    expect(next).toBe(new Date(T0 + 3600_000).toISOString());
    expect(await claim.claimSource('src_release', 'run-b', T0 + 10, worker)).toBe(true);
  });

  it('frees an expired lease once when two processes look at the same time', async () => {
    await claim.claimSource('src_dead', 'run-dead', T0, main);
    const later = T0 + claim.LEASE_MS + 5000;
    const [a, b] = await Promise.all([claim.freeExpired(later, main), claim.freeExpired(later, worker)]);
    const freed = [...a, ...b].filter((f) => f.sourceId === 'src_dead');
    expect(freed).toEqual([{ sourceId: 'src_dead', runId: 'run-dead' }]);
    expect(await holder('src_dead')).toBeNull();
  });
});
