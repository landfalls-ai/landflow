/**
 * The Postgres write queue against a fake pool (offline): a batch Postgres keeps rejecting blocks the sink instead of
 * being dropped, writes are refused while it is blocked, connection errors never block, the spool is durable and
 * emptied on drain, LANDFLOW_PG_SKIP_BATCH sets a batch aside, and the health report.
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { Database, openSqliteConnection, StoreUnavailableError } from '@/lib/server/db/database';
import { PostgresSink, replaySpool } from '@/lib/server/db/postgres';

interface Fake {
  pool: Pool;
  statements: string[];
  /** Applied `meta` upserts by key, in order. */
  applied: string[];
  /** Throw this for a statement mentioning `match` (while `active`). */
  fail: { match?: string; error?: unknown; active: boolean };
}

function fakePool(): Fake {
  const fake: Fake = { pool: undefined as unknown as Pool, statements: [], applied: [], fail: { active: false } };
  const client = {
    async query(text: string, values: unknown[] = []) {
      fake.statements.push(text);
      if (fake.fail.active && (!fake.fail.match || values.includes(fake.fail.match))) throw fake.fail.error;
      if (text.startsWith('INSERT INTO meta') && !String(values[0]).startsWith('postgres.')) fake.applied.push(String(values[0]));
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  fake.pool = { connect: async () => client, query: client.query, end: async () => {} } as unknown as Pool;
  return fake;
}

const dir = () => mkdtempSync(join(tmpdir(), 'landflow-sink-'));
const open = (fake: Fake, spool = join(dir(), 'q.jsonl'), options = {}) => {
  const sink = new PostgresSink(fake.pool, { release() {} } as unknown as PoolClient, spool, 0, undefined, { blockedRetrySeconds: 0, backoffMs: 1, spoolFsync: 'always', ...options });
  return { sink, db: new Database(openSqliteConnection(':memory:'), 'postgres', ':memory:', sink), spool };
};
const put = (db: Database, key: string) => db.upsert('meta', { key, value: '1' });
const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(check()).toBe(true);
};

afterEach(() => {
  delete process.env.LANDFLOW_PG_SKIP_BATCH;
});

describe('Postgres write queue', () => {
  it('blocks on a batch Postgres rejects five times, refuses writes, and applies everything in order once it recovers', async () => {
    const fake = fakePool();
    const { sink, db, spool } = open(fake);
    fake.fail.active = true;
    fake.fail.match = 'bad';
    fake.fail.error = Object.assign(new Error('duplicate key'), { code: '23505' });
    put(db, 'first');
    put(db, 'bad');
    put(db, 'third');
    await until(() => db.writeHealth().state === 'blocked');
    const health = db.writeHealth();
    expect(health.blockedSeq).toBe(2);
    expect(health.queuedBatches).toBe(2);
    expect(health.queuedOps).toBe(2);
    expect(health.lastError).toContain('23505');
    expect(fake.applied).toEqual(['first']);
    // The batch is still spooled, and writes are refused before the in-memory copy changes.
    expect(readFileSync(spool, 'utf8')).toContain('"bad"');
    expect(() => put(db, 'later')).toThrow(StoreUnavailableError);
    expect(() => db.transaction(() => put(db, 'later'))).toThrow(/blocked at batch 2/);
    expect(db.get('SELECT value FROM meta WHERE key = ?', 'later')).toBeUndefined();
    expect(db.get('SELECT value FROM meta WHERE key = ?', 'bad')).toBeDefined();
    // The cause goes away: the retry applies the batch and everything after it.
    fake.fail.active = false;
    await until(() => db.writeHealth().state === 'ok');
    await sink.flush();
    expect(fake.applied).toEqual(['first', 'bad', 'third']);
    expect(db.writeHealth().queuedBatches).toBe(0);
    put(db, 'later');
    await sink.close();
  });

  it.each([
    ['no code', new Error('socket closed')],
    ['57P01', Object.assign(new Error('terminating'), { code: '57P01' })],
    ['08006', Object.assign(new Error('connection failure'), { code: '08006' })],
  ])('never blocks on a connection error (%s)', async (_name, error) => {
    const fake = fakePool();
    const { sink, db } = open(fake);
    fake.fail.active = true;
    fake.fail.error = error;
    put(db, 'a');
    await until(() => fake.statements.filter((s) => s === 'BEGIN').length >= 4);
    expect(db.writeHealth().state).toBe('retrying');
    expect(() => put(db, 'b')).not.toThrow();
    fake.fail.active = false;
    await sink.flush(5_000);
    expect(fake.applied).toEqual(['a', 'b']);
    await sink.close();
  }, 20_000);

  it('appends spool lines and empties the file once the queue drains', async () => {
    const fake = fakePool();
    const { sink, db, spool } = open(fake);
    fake.fail.active = true;
    fake.fail.error = new Error('down');
    put(db, 'a');
    put(db, 'b');
    expect(readFileSync(spool, 'utf8').trim().split('\n').map((line) => JSON.parse(line).seq)).toEqual([1, 2]);
    fake.fail.active = false;
    await sink.flush(5_000);
    expect(readFileSync(spool, 'utf8')).toBe('');
    put(db, 'c');
    expect(readFileSync(spool, 'utf8').trim().split('\n')).toHaveLength(1);
    await sink.close();
  });

  it('syncs the spool at most every 100 ms in interval mode', async () => {
    const fake = fakePool();
    vi.useFakeTimers();
    try {
      const { sink, db } = open(fake, undefined, { spoolFsync: 'interval' });
      put(db, 'a');
      put(db, 'b');
      await vi.advanceTimersByTimeAsync(150);
      vi.useRealTimers();
      await sink.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('LANDFLOW_PG_SKIP_BATCH sets a batch aside in a rejected file and replays the rest', async () => {
    const fake = fakePool();
    const d = dir();
    const spool = join(d, 'q.jsonl');
    const { sink, db } = open(fake, spool);
    fake.fail.active = true;
    fake.fail.match = 'bad';
    fake.fail.error = Object.assign(new Error('bad row'), { code: '22P02' });
    put(db, 'ok');
    put(db, 'bad');
    put(db, 'ok2');
    await until(() => db.writeHealth().state === 'blocked');
    const spooled = readFileSync(spool, 'utf8');
    // The host stops (here: the file is what the next boot finds).
    fake.fail.active = false;
    await sink.close();
    fake.fail.active = true;
    const { writeFileSync } = await import('node:fs');
    writeFileSync(spool, spooled);
    fake.applied.length = 0;

    // Without the setting, replay fails naming the batch and the variable.
    await expect(replaySpool(fake.pool, spool)).rejects.toThrow(/batch 2.*LANDFLOW_PG_SKIP_BATCH=2/);
    process.env.LANDFLOW_PG_SKIP_BATCH = '2';
    fake.applied.length = 0;
    await replaySpool(fake.pool, spool);
    expect(fake.applied).toContain('ok2');
    expect(fake.applied).not.toContain('bad');
    const rejected = join(d, 'postgres-rejected-2.jsonl');
    expect(existsSync(rejected)).toBe(true);
    expect(JSON.parse(readFileSync(rejected, 'utf8')).ops[0].row.key).toBe('bad');
    expect(readFileSync(spool, 'utf8')).toBe('');
  });

  it('reports queue depth and age', async () => {
    const fake = fakePool();
    const { sink, db } = open(fake);
    expect(db.writeHealth()).toEqual({ state: 'ok', queuedBatches: 0, queuedOps: 0, oldestAgeMs: 0 });
    fake.fail.active = true;
    fake.fail.error = new Error('down');
    put(db, 'a');
    db.transaction(() => {
      put(db, 'b');
      put(db, 'c');
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const health = db.writeHealth();
    expect(health).toMatchObject({ state: 'retrying', queuedBatches: 2, queuedOps: 3 });
    expect(health.oldestAgeMs).toBeGreaterThanOrEqual(15);
    fake.fail.active = false;
    await sink.flush(5_000);
    await sink.close();
  });

  it('SQLite reports ok', () => {
    const db = new Database(openSqliteConnection(':memory:'), 'sqlite', ':memory:');
    expect(db.writeHealth().state).toBe('ok');
  });
});
