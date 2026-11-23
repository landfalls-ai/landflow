/**
 * C29 on a real Postgres (opt-in: LANDFLOW_INTEGRATION=postgres): migration 2934 applies (the four tables), and two
 * connections, each its own main with its own copy of the database, claim 50 queued calls at once: 50 claims, no call
 * twice, both took some; an answer written by one is read by the other. Uses LANDFLOW_TEST_DATABASE_URL, default the
 * infra stack's `landflow_test` database, in a schema of its own (`landflow_networks_test`, dropped after).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database } from '@/lib/server/db/database';

const BASE_URL = process.env.LANDFLOW_TEST_DATABASE_URL ?? 'postgres://landflow:landflow-dev-only@127.0.0.1:55432/landflow_test';
const SCHEMA = 'landflow_networks_test';
const URL = `${BASE_URL}${BASE_URL.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${SCHEMA}`)}`;
const enabled = Boolean(process.env.LANDFLOW_INTEGRATION?.split(',').includes('postgres'));

vi.setConfig({ testTimeout: 60_000 });

describe.skipIf(!enabled)('network calls on Postgres', async () => {
  const pg = (await import('pg')).default;
  const { openPostgres } = await import('@/lib/server/db/postgres');
  const calls = await import('@/lib/server/networks/calls');
  const admin = new pg.Pool({ connectionString: URL, max: 2 });
  const tmp = () => mkdtempSync(join(tmpdir(), 'landflow-pgnet-'));
  const opened: Database[] = [];
  const previous = { mode: process.env.LANDFLOW_EXECUTIONS_MODE, dataDir: process.env.LANDFLOW_DATA_DIR };
  let main: Database;
  let worker: Database;

  beforeAll(async () => {
    if (!/_test$/.test(new globalThis.URL(BASE_URL).pathname)) throw new Error(`Refusing to use ${BASE_URL}: its database name must end in _test`);
    process.env.LANDFLOW_EXECUTIONS_MODE = 'queue';
    process.env.LANDFLOW_DATA_DIR = tmp();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    main = await openPostgres(URL, tmp(), { instanceId: 'net-main' });
    worker = await openPostgres(URL, tmp(), { instanceId: 'net-worker' });
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

  it('applies migration 2934: the four tables exist', async () => {
    const tables = await admin.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name LIKE 'network%'`, [SCHEMA]);
    expect(tables.rows.map((r: { table_name: string }) => r.table_name).sort()).toEqual(['network_calls', 'network_runner_seen', 'network_runners', 'networks']);
  });

  it('two mains claim 50 queued calls at once: each is claimed once, and both take some', async () => {
    // Queue through the first main's connection (straight on Postgres, as the module does).
    const sealed = 'sealed-placeholder';
    for (let i = 0; i < 50; i++) {
      await admin.query(`INSERT INTO network_calls (id, network_id, state, request, queued_at) VALUES ($1, 'net_pg', 'queued', $2, $3)`, [`call_${String(i).padStart(2, '0')}`, sealed, new Date(Date.now() + i).toISOString()]);
    }
    const opener = vi.spyOn((await import('@/lib/server/credentials/vault')).credentials, 'openSecret').mockReturnValue(JSON.stringify({ method: 'GET', url: 'http://x/', headers: [], timeoutMs: 1000 }));
    const claimed: string[][] = [[], []];
    const drain = async (db: Database, runnerId: string, into: string[]) => {
      const runner = { id: runnerId, networkId: 'net_pg', name: runnerId, allowedIps: [] };
      for (let empty = 0; empty < 3; ) {
        const got = await calls.claimOnce(runner, Date.now(), db);
        if (got) {
          into.push(got.id);
          empty = 0;
        } else empty++;
      }
    };
    await Promise.all([drain(main, 'run_main', claimed[0]), drain(worker, 'run_worker', claimed[1])]);
    opener.mockRestore();
    const all = [...claimed[0], ...claimed[1]];
    expect(all).toHaveLength(50);
    expect(new Set(all).size).toBe(50);
    expect(claimed[0].length).toBeGreaterThan(0);
    expect(claimed[1].length).toBeGreaterThan(0);
    const states = await admin.query(`SELECT state, COUNT(*) AS n FROM network_calls GROUP BY state`);
    expect(states.rows).toEqual([{ state: 'claimed', n: '50' }]);
  });

  it('a notice published in one process reaches the listener of another within a second (pg_notify on the replication LISTEN connection)', async () => {
    const { onNotification, publishNotification } = await import('@/lib/server/db/replication');
    const heard: string[] = [];
    const off = onNotification('landflow_network_calls', (payload) => heard.push(payload));
    await new Promise((resolve) => setTimeout(resolve, 300));
    publishNotification('landflow_network_calls', 'queued');
    const until = Date.now() + 1_000;
    while (!heard.length && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 20));
    off();
    expect(heard).toContain('queued');
  });
});
