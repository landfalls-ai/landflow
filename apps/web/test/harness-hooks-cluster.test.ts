/**
 * Two processes apply events to one harness session at once (C04 NFR "queue mode"; opt-in: LANDFLOW_INTEGRATION=queue): each holds
 * a copy of the database, so the order rule is a conditional UPDATE on Postgres (`WHERE last_order IS NOT DISTINCT FROM <read>`):
 * neither process applies a stale event or loses the other's counts, and a late event never moves a sticky Error.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database } from '@/lib/server/db/database';

const BASE_URL = process.env.LANDFLOW_TEST_DATABASE_URL ?? 'postgres://landflow:landflow-dev-only@127.0.0.1:55432/landflow_test';
const SCHEMA = 'landflow_harness_test';
const URL = `${BASE_URL}${BASE_URL.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${SCHEMA}`)}`;
const enabled = Boolean(process.env.LANDFLOW_INTEGRATION?.split(',').some((flag) => flag === 'queue' || flag === 'postgres'));

vi.setConfig({ testTimeout: 30_000 });

describe.skipIf(!enabled)('harness session writes across two processes', async () => {
  const pg = (await import('pg')).default;
  const { openPostgres } = await import('@/lib/server/db/postgres');
  const { applyEvent } = await import('@/lib/server/harness/store');
  const admin = new pg.Pool({ connectionString: URL, max: 2 });
  const tmp = () => mkdtempSync(join(tmpdir(), 'landflow-pgq-harness-'));
  const opened: Database[] = [];
  let main: Database;
  let worker: Database;
  const key = (n: number) => ({ kind: 'seq' as const, value: String(n).padStart(20, '0') });
  const event = (session: string, n: number, name: string, verdict: 'idle' | 'thinking' | 'error', extra: { prompt?: boolean } = {}) => ({
    ownerId: 'usr_a', harness: 'claude-code', sessionKey: session, name, orderKey: key(n), receivedAt: new Date(Date.UTC(2026, 10, 21, 10, 0, n)).toISOString(), verdict, view: { event: name }, prompt: Boolean(extra.prompt), tool: false,
  });

  beforeAll(async () => {
    if (!/_test$/.test(new globalThis.URL(BASE_URL).pathname)) throw new Error(`Refusing to use ${BASE_URL}: its database name must end in _test`);
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    main = await openPostgres(URL, tmp(), { instanceId: 'harness-main' });
    opened.push(main);
    worker = await openPostgres(URL, tmp(), { instanceId: 'harness-worker' });
    opened.push(worker);
  });
  afterAll(async () => {
    for (const db of opened) await db.close().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
  });

  it('a late SessionStart on one main does not clear an Error the other applied', async () => {
    await applyEvent(event('s1', 1, 'UserPromptSubmit', 'thinking', { prompt: true }), main);
    await applyEvent(event('s1', 3, 'StopFailure', 'error'), worker);
    const late = await applyEvent(event('s1', 2, 'SessionStart', 'idle'), main);
    expect(late.applied).toBe(false);
    const stored = await admin.query('SELECT status, last_order FROM harness_sessions WHERE session_key = $1', ['s1']);
    expect(stored.rows[0]).toEqual({ status: 'error', last_order: key(3).value });
  });

  it('simultaneous events from two processes lose no count and apply the newest status', async () => {
    await applyEvent(event('s2', 1, 'SessionStart', 'idle'), main);
    await Promise.all([applyEvent(event('s2', 2, 'UserPromptSubmit', 'thinking', { prompt: true }), main), applyEvent(event('s2', 3, 'UserPromptSubmit', 'thinking', { prompt: true }), worker)]);
    await main.flush();
    await worker.flush();
    const stored = await admin.query('SELECT status, data FROM harness_sessions WHERE session_key = $1', ['s2']);
    expect(stored.rows[0].status).toBe('thinking');
    // Each event is newer than what the other had read or it retried: both counted unless one arrived after the other (then it is late).
    const counted = JSON.parse(stored.rows[0].data).prompts as number;
    const events = await admin.query('SELECT COUNT(*)::int AS n FROM harness_events WHERE session_id = (SELECT id FROM harness_sessions WHERE session_key = $1)', ['s2']);
    expect(events.rows[0].n).toBe(3);
    expect(counted).toBeGreaterThanOrEqual(1);
    expect(counted).toBeLessThanOrEqual(2);
  });
});
