/**
 * The hot mirror of Postgres mode (lib/server/db/hot-mirror.ts, reads.ts), offline: a Database with a fake sink and a fake
 * `direct()` client. Eviction leaves data only for hot runs and sends nothing to the sink, a cold run's data comes from
 * `direct()`, deletes on the partly mirrored tables are always replayed, a row with a pending write is not evicted, and a
 * scan waits for the write queue before it asks Postgres.
 */
import { describe, expect, it, vi } from 'vitest';
import { Database, openSqliteConnection, type DirectClient, type WriteOp, type WriteSink } from '@/lib/server/db/database';
import { PostgresSink } from '@/lib/server/db/postgres';
import type { TableName } from '@/lib/server/db/schema';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';

const holder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('@/lib/server/db', () => ({ database: () => holder.db }));

const { evictCold, hotCondition, keepHot, mirrorSelect } = await import('@/lib/server/db/hot-mirror');
const { postgresPlaceholders, promoteExecution, readExecutionData, readExecutionEvents, readRows } = await import('@/lib/server/db/reads');
const journalStore = await import('@/lib/server/journal/store');

interface Fake {
  db: Database;
  /** Writes the sink received. */
  ops: WriteOp[];
  /** Queries `direct()` ran, with their parameters. */
  queries: Array<{ text: string; values: unknown[] }>;
  /** What Postgres answers, by the start of the statement. */
  answers: Array<{ match: RegExp; rows: unknown[] }>;
  pending: Set<string>;
  barrierOk: boolean;
}

function open(): Fake {
  const fake = { ops: [], queries: [], answers: [], pending: new Set<string>(), barrierOk: true } as unknown as Fake;
  const client: DirectClient = {
    async query(text, values = []) {
      fake.queries.push({ text, values });
      const answer = fake.answers.find((a) => a.match.test(text));
      return { rows: (answer?.rows ?? []) as never[], rowCount: answer?.rows.length ?? 0 };
    },
  };
  const sink: WriteSink = {
    partial: new Set<TableName>(['executions', 'execution_events']),
    enqueue: (ops) => void fake.ops.push(...ops),
    flush: async () => {},
    close: async () => {},
    direct: (fn) => fn(client),
    pendingExecutions: () => fake.pending,
    barrier: async () => fake.barrierOk,
  };
  fake.db = new Database(openSqliteConnection(':memory:'), 'postgres', ':memory:', sink);
  holder.db = fake.db;
  return fake;
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function run(db: Database, id: string, status: string, finishedMinutesAgo?: number, extra: Record<string, string> = {}) {
  db.upsert('executions', {
    id,
    workflow_id: 'wf',
    status,
    mode: 'manual',
    started_at: minutesAgo((finishedMinutesAgo ?? 0) + 1),
    finished_at: finishedMinutesAgo === undefined ? null : minutesAgo(finishedMinutesAgo),
    duration_ms: 5,
    summary: '{}',
    data: JSON.stringify({ executionId: id, status }),
    ...extra,
  });
  for (let seq = 1; seq <= 2; seq++) db.upsert('execution_events', { execution_id: id, seq, at: minutesAgo(1), type: 'check', span_id: 's', data: JSON.stringify({ seq }) });
}

const dataOf = (db: Database, id: string) => db.get<{ data: string }>('SELECT data FROM executions WHERE id = ?', id)?.data;
const eventsOf = (db: Database, id: string) => db.get<{ n: number }>('SELECT COUNT(*) AS n FROM execution_events WHERE execution_id = ?', id)?.n;

describe('eviction', () => {
  it('leaves data and events only for hot runs and sends nothing to the sink', () => {
    const f = open();
    run(f.db, 'running', 'running');
    run(f.db, 'waiting', 'waiting', 600);
    run(f.db, 'fresh', 'success', 3);
    run(f.db, 'old', 'success', 120);
    run(f.db, 'old_error', 'error', 90);
    f.ops.length = 0;

    expect(evictCold(f.db)).toBe(2);

    for (const id of ['running', 'waiting', 'fresh']) {
      expect(dataOf(f.db, id)).not.toBe('');
      expect(eventsOf(f.db, id)).toBe(2);
    }
    for (const id of ['old', 'old_error']) {
      expect(dataOf(f.db, id)).toBe('');
      expect(eventsOf(f.db, id)).toBe(0);
      // The row itself (summary, status, times) stays for lists and filters.
      expect(f.db.get<{ status: string }>('SELECT status FROM executions WHERE id = ?', id)).toBeDefined();
    }
    expect(f.ops).toEqual([]);
  });

  it('keeps a run with a retry waiting, the child of a waiting run and a promoted run', () => {
    const f = open();
    run(f.db, 'retrying', 'error', 200);
    f.db.upsert('retries', { execution_id: 'retrying', workflow_id: 'wf', attempt: 1, due_at: minutesAgo(-5), created_at: minutesAgo(1) });
    run(f.db, 'parent', 'waiting', 300);
    run(f.db, 'child', 'success', 250, { parent_id: 'parent' });
    run(f.db, 'promoted', 'success', 250);
    keepHot(f.db, 'promoted');
    run(f.db, 'plain', 'success', 250);
    expect(evictCold(f.db)).toBe(1);
    expect(dataOf(f.db, 'plain')).toBe('');
    for (const id of ['retrying', 'child', 'promoted', 'parent']) expect(dataOf(f.db, id)).not.toBe('');
  });

  it('does not evict a run with a write not yet in Postgres', () => {
    const f = open();
    run(f.db, 'old', 'success', 120);
    run(f.db, 'older', 'success', 130);
    f.pending.add('old');
    expect(evictCold(f.db)).toBe(1);
    expect(dataOf(f.db, 'old')).not.toBe('');
    expect(dataOf(f.db, 'older')).toBe('');
    f.pending.clear();
    expect(evictCold(f.db)).toBe(1);
    expect(dataOf(f.db, 'old')).toBe('');
  });

  it('loads only hot runs at boot: the select blanks the data of cold ones and the events query joins on them', () => {
    const cutoff = minutesAgo(15);
    const executions = mirrorSelect('executions', cutoff);
    expect(executions.text).toContain("CASE WHEN");
    expect(executions.text).toContain(hotCondition('e', '$1'));
    expect(executions.values).toEqual([cutoff]);
    expect(mirrorSelect('execution_events', cutoff).text).toContain('JOIN executions e');
    expect(mirrorSelect('workflows', cutoff)).toEqual({ text: 'SELECT * FROM workflows', values: [] });
  });
});

describe('partly mirrored tables', () => {
  it('replays a delete and a retention sweep on them even when the copy had nothing to delete', () => {
    const f = open();
    run(f.db, 'old', 'success', 120);
    evictCold(f.db);
    f.ops.length = 0;
    expect(f.db.delete('execution_events', { execution_id: 'old' })).toBe(0);
    expect(f.db.deleteBefore('execution_events', 'at', minutesAgo(0))).toBe(0);
    expect(f.ops).toEqual([
      { op: 'delete', table: 'execution_events', where: { execution_id: 'old' } },
      { op: 'deleteBefore', table: 'execution_events', column: 'at', value: expect.any(String) },
    ]);
    // Other tables keep the old rule: nothing deleted, nothing replayed.
    f.ops.length = 0;
    expect(f.db.delete('meta', { key: 'absent' })).toBe(0);
    expect(f.ops).toEqual([]);
  });
});

describe('reads', () => {
  it('serves a hot run from the copy and a cold run from Postgres', async () => {
    const f = open();
    run(f.db, 'fresh', 'success', 1);
    run(f.db, 'old', 'success', 120);
    evictCold(f.db);
    f.answers.push({ match: /FROM executions WHERE id/, rows: [{ data: '{"executionId":"old"}' }] });
    f.answers.push({ match: /FROM execution_events WHERE execution_id/, rows: [{ data: '{"seq":1}' }, { data: '{"seq":2}' }] });

    expect(await readExecutionData('fresh')).toBe('{"executionId":"fresh","status":"success"}');
    expect(await readExecutionEvents('fresh', 0, 10)).toHaveLength(2);
    expect(f.queries).toEqual([]);

    expect(await readExecutionData('old')).toBe('{"executionId":"old"}');
    expect(await readExecutionEvents('old', 0, 10)).toEqual(['{"seq":1}', '{"seq":2}']);
    expect(f.queries.map((q) => q.values)).toEqual([['old'], ['old', 0, 10]]);
    expect(await readExecutionData('missing')).toBeUndefined();
  });

  it('runs a scan on Postgres after the barrier, and on the copy when the barrier times out', async () => {
    const f = open();
    run(f.db, 'fresh', 'success', 1);
    f.answers.push({ match: /FROM executions/, rows: [{ summary: 'from postgres' }] });
    const sql = "SELECT summary FROM executions WHERE data LIKE ? ESCAPE '\\' AND status <> '?' LIMIT ?";
    expect(await readRows(sql, '%x%', 5)).toEqual([{ summary: 'from postgres' }]);
    expect(f.queries[0]).toEqual({ text: "SELECT summary FROM executions WHERE data LIKE $1 ESCAPE '\\' AND status <> '?' LIMIT $2", values: ['%x%', 5] });

    f.barrierOk = false;
    f.queries.length = 0;
    expect(await readRows('SELECT summary FROM executions WHERE id = ?', 'fresh')).toEqual([{ summary: '{}' }]);
    expect(f.queries).toEqual([]);
  });

  it('numbers placeholders outside string literals', () => {
    expect(postgresPlaceholders("a = ? AND b = 'it''s ?' AND c IN (?, ?)")).toBe("a = $1 AND b = 'it''s ?' AND c IN ($2, $3)");
  });
});

describe('promotion', () => {
  it('loads a cold run back so its journal can be appended, and refuses an append before that', async () => {
    const f = open();
    run(f.db, 'old', 'success', 120);
    evictCold(f.db);
    expect(journalStore.lastSeq('old')).toBe(1);
    expect(() => journalStore.append('old', [{ seq: 1, executionId: 'old', at: minutesAgo(0), type: 'check', spanId: 's' } as never])).toThrow(/promoteExecution/);

    f.answers.push({ match: /FROM executions WHERE id/, rows: [{ data: '{"executionId":"old"}' }] });
    f.answers.push({ match: /FROM execution_events WHERE execution_id/, rows: [1, 2].map((seq) => ({ execution_id: 'old', seq, at: minutesAgo(1), type: 'check', span_id: 's', parent_span_id: null, trace_id: null, data: `{"seq":${seq}}` })) });
    f.ops.length = 0;
    await promoteExecution('old');
    expect(dataOf(f.db, 'old')).toBe('{"executionId":"old"}');
    expect(journalStore.lastSeq('old')).toBe(2);
    // Held for the hot window: the next sweep leaves it.
    expect(evictCold(f.db)).toBe(0);
    expect(eventsOf(f.db, 'old')).toBe(2);
    // Nothing of this went to the sink (Postgres has it all).
    expect(f.ops).toEqual([]);
  });
});

describe('the write queue barrier and pending executions', () => {
  it('resolves once the batches queued so far are applied, false on timeout, and tracks executions in flight to Postgres', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const client = { query: async (text: string) => (text.startsWith('INSERT INTO executions') ? void (await gate) : { rows: [], rowCount: 0 }), release() {} };
    const pool = { connect: async () => client, query: client.query, end: async () => {} } as unknown as Pool;
    const sink = new PostgresSink(pool, { release() {} } as unknown as PoolClient, join(mkdtempSync(join(tmpdir(), 'landflow-barrier-')), 'q.jsonl'), 0, undefined, { spoolFsync: 'off', backoffMs: 1 });
    const db = new Database(openSqliteConnection(':memory:'), 'postgres', ':memory:', sink);
    expect(await db.barrier(50)).toBe(true);
    run(db, 'busy', 'success', 120);
    expect(sink.pendingExecutions().has('busy')).toBe(true);
    expect(db.evictLocal(['busy'])).toEqual([]);
    expect(await db.barrier(30)).toBe(false);
    const applied = db.barrier(5_000);
    release();
    expect(await applied).toBe(true);
    expect(sink.pendingExecutions().has('busy')).toBe(false);
    expect(db.evictLocal(['busy'])).toEqual(['busy']);
    await sink.close().catch(() => {});
  });
});
