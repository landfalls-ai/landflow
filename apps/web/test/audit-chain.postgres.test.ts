/**
 * The audit hash chain and the shared SAML state in queue mode on a real Postgres (opt-in: LANDFLOW_INTEGRATION=queue).
 * Two processes (a main and a worker, each with its in-memory copy) store events unchained at once and seal them in
 * Postgres under the chain's transaction-level advisory lock, both sealing concurrently: one sequence, no gaps, every
 * copy told; verification straight from Postgres catches rows edited or deleted behind the processes' backs; pruning
 * in Postgres keeps the chain verifiable. SAML: a request id written by one main is readable at once by the other, and
 * of two mains taking it (or recording the same replay id) exactly one wins. Uses LANDFLOW_TEST_DATABASE_URL, default
 * the infra stack's `landflow_test` database, in a schema of its own (`landflow_audit_chain_test`, dropped after).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuditEvent } from '@/lib/shared/audit';
import type { Database } from '@/lib/server/db/database';

const BASE_URL = process.env.LANDFLOW_TEST_DATABASE_URL ?? 'postgres://landflow:landflow-dev-only@127.0.0.1:55432/landflow_test';
const SCHEMA = 'landflow_audit_chain_test';
const URL = `${BASE_URL}${BASE_URL.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${SCHEMA}`)}`;
const enabled = Boolean(process.env.LANDFLOW_INTEGRATION?.split(',').includes('queue'));

vi.setConfig({ testTimeout: 60_000 });

describe.skipIf(!enabled)('audit chain and SAML state in queue mode on Postgres', async () => {
  const pg = (await import('pg')).default;
  const { openPostgres } = await import('@/lib/server/db/postgres');
  const { insertEvent, pruneEventsAsync } = await import('@/lib/server/audit/store');
  const chain = await import('@/lib/server/audit/chain');
  const state = await import('@/lib/server/auth/saml-state');
  const admin = new pg.Pool({ connectionString: URL, max: 2 });
  const tmp = () => mkdtempSync(join(tmpdir(), 'landflow-pgchain-'));
  const opened: Database[] = [];
  const until = (check: () => void) => vi.waitFor(check, { timeout: 15_000, interval: 50 });
  const previous = { mode: process.env.LANDFLOW_EXECUTIONS_MODE, dataDir: process.env.LANDFLOW_DATA_DIR };
  let main: Database;
  let worker: Database;
  let n = 0;

  const event = (who: string): AuditEvent => ({
    id: `aud_${who}_${String(++n).padStart(4, '0')}`,
    at: new Date().toISOString(),
    action: 'settings.update',
    category: 'settings',
    outcome: 'success',
    actor: { type: 'system' },
    target: { type: 'settings', id: who },
    projectId: who === 'main' ? 'prj_main' : undefined,
    summary: `${who} ${n}`,
  });
  const chained = (db: Database) => Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM audit_events WHERE chain_seq IS NOT NULL')?.n ?? 0);

  beforeAll(async () => {
    if (!/_test$/.test(new globalThis.URL(BASE_URL).pathname)) throw new Error(`Refusing to use ${BASE_URL}: its database name must end in _test`);
    process.env.LANDFLOW_EXECUTIONS_MODE = 'queue';
    // Nothing here may reach the default data directory.
    process.env.LANDFLOW_DATA_DIR = tmp();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    main = await openPostgres(URL, tmp(), { instanceId: 'chain-main' });
    worker = await openPostgres(URL, tmp(), { instanceId: 'chain-worker' });
    opened.push(main, worker);
  });

  afterAll(async () => {
    await chain.stopChainSealer();
    for (const db of opened) await db.close().catch(() => {});
    for (const [key, value] of [['LANDFLOW_EXECUTIONS_MODE', previous.mode], ['LANDFLOW_DATA_DIR', previous.dataDir]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
  });

  it('stores events unchained in queue mode, and two processes sealing at once make one sequence', async () => {
    expect(chain.chainsAtInsert(main)).toBe(false);
    for (let round = 0; round < 5; round++) {
      for (let i = 0; i < 20; i++) {
        insertEvent(event('main'), main);
        insertEvent(event('worker'), worker);
      }
      // Both seal while the other writes and seals.
      await Promise.all([chain.sealPending(main), chain.sealPending(worker), chain.sealPending(main)]);
    }
    await Promise.all([chain.sealPending(main), chain.sealPending(worker)]);
    const rows = (await admin.query<{ chain_seq: string }>('SELECT chain_seq FROM audit_events ORDER BY chain_seq')).rows.map((r) => Number(r.chain_seq));
    expect(rows).toHaveLength(200);
    expect(rows).toEqual(rows.map((_s, i) => i + 1));
    const report = await chain.verifyChain(main);
    expect(report).toMatchObject({ ok: true, checked: 200, firstSeq: 1, lastSeq: 200, pending: 0, problems: [] });
    // Every copy hears of the links.
    await until(() => expect([chained(main), chained(worker)]).toEqual([200, 200]));
    expect(worker.get<{ hash: string }>('SELECT hash FROM audit_events WHERE chain_seq = 200')?.hash).toBe(report.head?.hash);
  });

  it('a pending event shows as pending, not as a problem', async () => {
    insertEvent(event('main'), main);
    await main.flush();
    expect(await chain.verifyChain(worker)).toMatchObject({ ok: true, pending: 1 });
    await chain.sealPending(worker);
    expect(await chain.verifyChain(worker)).toMatchObject({ ok: true, pending: 0, checked: 201 });
  });

  it('catches rows edited or deleted in Postgres behind the processes’ backs', async () => {
    const original = (await admin.query<{ summary: string }>('SELECT summary FROM audit_events WHERE chain_seq = 7')).rows[0].summary;
    await admin.query('UPDATE audit_events SET summary = $1 WHERE chain_seq = 7', ['edited in psql']);
    expect((await chain.verifyChain(main)).brokenAt).toMatchObject({ seq: 7, reason: 'The event was changed after it was recorded' });
    await admin.query('UPDATE audit_events SET summary = $1 WHERE chain_seq = 7', [original]);
    expect((await chain.verifyChain(main)).ok).toBe(true);

    const saved = (await admin.query('SELECT * FROM audit_events WHERE chain_seq = 50')).rows[0] as Record<string, unknown>;
    await admin.query('DELETE FROM audit_events WHERE chain_seq = 50');
    expect((await chain.verifyChain(worker)).brokenAt).toMatchObject({ seq: 50, reason: 'Event #50 is missing: it was deleted' });
    const columns = Object.keys(saved);
    await admin.query(`INSERT INTO audit_events (${columns.join(', ')}) VALUES (${columns.map((_c, i) => `$${i + 1}`).join(', ')})`, columns.map((c) => saved[c]));
    expect((await chain.verifyChain(worker)).ok).toBe(true);
  });

  it('prunes in Postgres under the lock and keeps verifying from the anchor', async () => {
    const later = Date.now() + 2 * 86_400_000;
    const removed = await pruneEventsAsync(1, later, main);
    expect(removed).toBe(201);
    const report = await chain.verifyChain(main);
    expect(report).toMatchObject({ ok: true, checked: 0, anchor: { seq: 201 } });
    await until(() => expect(Number(worker.get<{ n: number }>('SELECT COUNT(*) AS n FROM audit_events')?.n)).toBe(0));
    insertEvent(event('worker'), worker);
    insertEvent(event('main'), main);
    await Promise.all([chain.sealPending(worker), chain.sealPending(main)]);
    expect(await chain.verifyChain(worker)).toMatchObject({ ok: true, checked: 2, firstSeq: 202, lastSeq: 203 });
  });

  it('SAML: a request id one main wrote is read at once by the other, and only one of them takes it', async () => {
    await state.putState('request', '_req_shared', '2026-10-26T00:00:00Z', 60_000, undefined, Date.now(), main);
    // Not in the worker's copy yet, perhaps: read from Postgres on a miss.
    expect(await state.readState('request', '_req_shared', Date.now(), worker)).toBe('2026-10-26T00:00:00Z');
    for (let i = 0; i < 10; i++) {
      await state.putState('request', `_req_race_${i}`, 'x', 60_000, undefined, Date.now(), i % 2 ? main : worker);
      const taken = await Promise.all([state.takeState('request', `_req_race_${i}`, Date.now(), main), state.takeState('request', `_req_race_${i}`, Date.now(), worker)]);
      expect(taken.filter((value) => value === 'x')).toHaveLength(1);
    }
    // Expired rows are never handed out.
    await state.putState('relay', 'old', '{}', 1, undefined, Date.now() - 10_000, main);
    expect(await state.takeState('relay', 'old', Date.now(), worker)).toBeUndefined();
    // A session's logout details: one main writes, the other drops the user's.
    await state.putState('session', 'tok_hash', '{"nameID":"alice"}', 60_000, 'usr_alice', Date.now(), main);
    await until(() => expect(worker.get('SELECT id FROM saml_state WHERE id = ?', 'tok_hash')).toBeDefined());
    await state.dropUserStates('session', 'usr_alice', worker);
    // Gone from Postgres at once, and from every copy as the notice arrives.
    expect(await state.takeState('session', 'tok_hash', Date.now(), main)).toBeUndefined();
    await until(() => expect([main, worker].map((db) => db.get('SELECT id FROM saml_state WHERE id = ?', 'tok_hash'))).toEqual([undefined, undefined]));
  });

  it('SAML: of two mains recording the same replay id, one wins', async () => {
    const replayed = () => new Error('replayed');
    const until5 = Date.now() + 5 * 60_000;
    const results = await Promise.allSettled([state.recordReplayIds(['response:_r1', 'assertion:_a1'], until5, replayed, Date.now(), main), state.recordReplayIds(['response:_r1', 'assertion:_a1'], until5, replayed, Date.now(), worker)]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    // An expired id is taken over.
    await admin.query(`UPDATE saml_replay SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = 'response:_r1'`);
    await expect(state.recordReplayIds(['response:_r1'], until5, replayed, Date.now(), worker)).resolves.toBeUndefined();
  });
});
