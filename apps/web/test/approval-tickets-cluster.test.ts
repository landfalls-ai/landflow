/**
 * Two processes take the same ticket step at once (C12 / P12b; opt-in: LANDFLOW_INTEGRATION=queue): in queue mode each process
 * holds a copy of the database, so a ticket's moves are conditional UPDATEs on Postgres and exactly one caller wins an opening
 * attempt or a close; both copies end on the winner's row. Same database and schema pattern as approval-inbox-cluster-ap1.test.ts.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database } from '@/lib/server/db/database';

const BASE_URL = process.env.LANDFLOW_TEST_DATABASE_URL ?? 'postgres://landflow:landflow-dev-only@127.0.0.1:55432/landflow_test';
const SCHEMA = 'landflow_approval_tickets_test';
const URL = `${BASE_URL}${BASE_URL.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${SCHEMA}`)}`;
const enabled = Boolean(process.env.LANDFLOW_INTEGRATION?.split(',').includes('queue'));

vi.setConfig({ testTimeout: 30_000 });

describe.skipIf(!enabled)('approval tickets across two processes', async () => {
  const pg = (await import('pg')).default;
  const { openPostgres } = await import('@/lib/server/db/postgres');
  const { moveTicket } = await import('@/lib/server/approval-inbox/tickets');
  const admin = new pg.Pool({ connectionString: URL, max: 2 });
  const opened: Database[] = [];
  const until = (check: () => void) => vi.waitFor(check, { timeout: 10_000, interval: 25 });
  const stateIn = (db: Database, id: string) => db.get<{ state: string }>('SELECT state FROM approval_tickets WHERE request_id = ? AND channel_id = ?', id, 'ch')?.state;
  let main: Database;
  let worker: Database;
  const row = (id: string) => ({ request_id: id, channel_id: 'ch', rule_id: 'r', system: 'servicenow', state: 'opening', external_id: null, external_key: null, external_url: null, attempts: 0, next_at: null, last_error: null, opened_at: null, closed_at: null, created_at: new Date().toISOString() });

  beforeAll(async () => {
    if (!/_test$/.test(new globalThis.URL(BASE_URL).pathname)) throw new Error(`Refusing to use ${BASE_URL}: its database name must end in _test`);
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    main = await openPostgres(URL, mkdtempSync(join(tmpdir(), 'landflow-pgq-tix-')), { instanceId: 'tix-main' });
    opened.push(main);
    worker = await openPostgres(URL, mkdtempSync(join(tmpdir(), 'landflow-pgq-tix-')), { instanceId: 'tix-worker' });
    opened.push(worker);
  });
  afterAll(async () => {
    for (const db of opened) await db.close().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
  });

  it('exactly one of two simultaneous attempts wins, and both copies end on its row', async () => {
    for (let i = 0; i < 5; i++) {
      const id = `req-${i}`;
      main.insertNew('approval_tickets', row(id));
      await main.flush();
      await until(() => expect(stateIn(worker, id)).toBe('opening'));
      const [a, b] = await Promise.all([
        moveTicket(id, 'ch', { state: 'opening', attempts: 0 }, { state: 'open', external_id: 'CHG-A' }, main),
        moveTicket(id, 'ch', { state: 'opening', attempts: 0 }, { state: 'open', external_id: 'CHG-B' }, worker),
      ]);
      expect([a, b].filter(Boolean)).toHaveLength(1);
      const winner = (a ?? b)!;
      await until(() => expect([stateIn(main, id), stateIn(worker, id)]).toEqual(['open', 'open']));
      const stored = await admin.query('SELECT state, external_id FROM approval_tickets WHERE request_id = $1', [id]);
      expect(stored.rows[0]).toEqual({ state: 'open', external_id: winner.external_id });
    }
  });
});
