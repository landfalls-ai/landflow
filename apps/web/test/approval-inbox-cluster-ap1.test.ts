/**
 * Two processes claim one approval request at once (wave ap1, AP01; opt-in: LANDFLOW_INTEGRATION=queue): in queue mode each
 * process holds a copy of the database, so the claim is a conditional UPDATE on Postgres (`WHERE status = 'waiting'`) and exactly one
 * wins; both copies end on the winner's word. Same database and schema pattern as cluster-postgres.test.ts (a schema of its own).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database } from '@/lib/server/db/database';

const BASE_URL = process.env.LANDFLOW_TEST_DATABASE_URL ?? 'postgres://landflow:landflow-dev-only@127.0.0.1:55432/landflow_test';
const SCHEMA = 'landflow_approval_inbox_test';
const URL = `${BASE_URL}${BASE_URL.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${SCHEMA}`)}`;
const enabled = Boolean(process.env.LANDFLOW_INTEGRATION?.split(',').includes('queue'));

vi.setConfig({ testTimeout: 30_000 });

describe.skipIf(!enabled)('approval inbox claims across two processes', async () => {
  const pg = (await import('pg')).default;
  const { openPostgres } = await import('@/lib/server/db/postgres');
  const { claim, recordNudge } = await import('@/lib/server/approval-inbox/store');
  const admin = new pg.Pool({ connectionString: URL, max: 2 });
  const tmp = () => mkdtempSync(join(tmpdir(), 'landflow-pgq-inbox-'));
  const opened: Database[] = [];
  const until = (check: () => void) => vi.waitFor(check, { timeout: 10_000, interval: 25 });
  const statusIn = (db: Database, id: string) => db.get<{ status: string }>('SELECT status FROM approval_inbox WHERE id = ?', id)?.status;
  let main: Database;
  let worker: Database;

  const row = (id: string) => ({ id, execution_id: `exec-${id}`, call_id: 'c1', workflow_id: 'wf', workflow_name: 'Flow', workflow_version: 1, node_id: 'n', node_name: 'Ask', agent_id: 'a', agent_name: 'Mailer', agent_version: '1', session_id: 's', project_id: null, tool: 'Send Email', params: '{}', destination: null, trigger_word: 'webhook', status: 'waiting', requested_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3_600_000).toISOString(), nudged: null, decided_by: null, decided_by_name: null, decided_via: null, decided_at: null });

  beforeAll(async () => {
    if (!/_test$/.test(new globalThis.URL(BASE_URL).pathname)) throw new Error(`Refusing to use ${BASE_URL}: its database name must end in _test`);
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    main = await openPostgres(URL, tmp(), { instanceId: 'inbox-main' });
    opened.push(main);
    worker = await openPostgres(URL, tmp(), { instanceId: 'inbox-worker' });
    opened.push(worker);
  });
  afterAll(async () => {
    for (const db of opened) await db.close().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
  });

  it('exactly one of two simultaneous claims wins, and both copies end settled the same way', async () => {
    for (let i = 0; i < 5; i++) {
      const id = `req-${i}`;
      main.upsert('approval_inbox', row(id));
      await main.flush();
      await until(() => expect(statusIn(worker, id)).toBe('waiting'));
      const [a, b] = await Promise.all([claim(id, 'approved', { by: 'ada@x.test', via: 'inbox' }, main), claim(id, 'denied', { by: 'bob@x.test', via: 'run-trace' }, worker)]);
      expect([a.won, b.won].filter(Boolean)).toHaveLength(1);
      const winner = a.won ? a : b;
      expect(a.row?.status).toBe(b.row?.status);
      await until(() => expect([statusIn(main, id), statusIn(worker, id)]).toEqual([winner.row!.status, winner.row!.status]));
      const stored = await admin.query('SELECT status, decided_by FROM approval_inbox WHERE id = $1', [id]);
      expect(stored.rows[0]).toEqual({ status: winner.row!.status, decided_by: winner.row!.decided_by });
    }
  });

  it('a nudge recorded from a stale copy never undoes a claim made elsewhere', async () => {
    const id = 'req-nudge';
    main.upsert('approval_inbox', row(id));
    await main.flush();
    await until(() => expect(statusIn(worker, id)).toBe('waiting'));
    // The worker still holds `waiting` when main claims; the worker then records its nudge.
    const won = await claim(id, 'approved', { by: 'ada@x.test', via: 'inbox' }, main);
    expect(won.won).toBe(true);
    await recordNudge(id, { email: 2, channels: 0 }, worker);
    await main.flush();
    await worker.flush();
    await until(() => expect([statusIn(main, id), statusIn(worker, id)]).toEqual(['approved', 'approved']));
    const stored = await admin.query('SELECT status, decided_by, nudged FROM approval_inbox WHERE id = $1', [id]);
    expect(stored.rows[0].status).toBe('approved');
    expect(stored.rows[0].decided_by).toBe('ada@x.test');
    expect(JSON.parse(stored.rows[0].nudged).email).toBe(2);
  });

  it('a claim that commits right after a nudge UPDATE is not undone by the nudge', async () => {
    const id = 'req-interleave';
    main.upsert('approval_inbox', row(id));
    await main.flush();
    await until(() => expect(statusIn(worker, id)).toBe('waiting'));
    // Main's claim commits in Postgres right after the worker's nudge UPDATE returns, before the worker's copy hears of it.
    const direct = worker.direct.bind(worker) as Database['direct'];
    let injected = false;
    worker.direct = (async (fn: Parameters<Database['direct']>[0]) => {
      const result = await direct(fn);
      if (!injected && (result as { rows?: { nudged?: string }[] } | undefined)?.rows?.[0]?.nudged) {
        injected = true;
        await claim(id, 'approved', { by: 'ada@x.test', via: 'inbox' }, main);
      }
      return result;
    }) as Database['direct'];
    try {
      await recordNudge(id, { email: 1, channels: 0 }, worker);
    } finally {
      worker.direct = direct;
    }
    expect(injected).toBe(true);
    await main.flush();
    await worker.flush();
    await until(() => expect([statusIn(main, id), statusIn(worker, id)]).toEqual(['approved', 'approved']));
    const stored = await admin.query('SELECT status, decided_by FROM approval_inbox WHERE id = $1', [id]);
    expect(stored.rows[0]).toEqual({ status: 'approved', decided_by: 'ada@x.test' });
    expect(main.get<{ decided_by: string }>('SELECT decided_by FROM approval_inbox WHERE id = ?', id)?.decided_by).toBe('ada@x.test');
  });
});
