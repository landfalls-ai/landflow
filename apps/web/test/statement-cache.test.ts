/**
 * The prepared-statement cache (lib/server/db/database.ts) is a bounded LRU: LANDFLOW_DB_STATEMENT_CACHE caps it,
 * a hit keeps a statement, and one that was evicted is prepared again without the caller noticing.
 */
import { afterEach, describe, expect, it } from 'vitest';

const { openSqlite } = await import('@/lib/server/db/database');

const open = (cap?: string) => {
  if (cap) process.env.LANDFLOW_DB_STATEMENT_CACHE = cap;
  else delete process.env.LANDFLOW_DB_STATEMENT_CACHE;
  return openSqlite(':memory:');
};

afterEach(() => {
  delete process.env.LANDFLOW_DB_STATEMENT_CACHE;
});

/** A query whose SQL text differs per `n`, like an `IN (?, ?, …)` list of a new length. */
const query = (n: number) => `SELECT ${n} AS n`;

describe('statement cache', () => {
  it('never holds more statements than the cap', async () => {
    const db = open('5');
    for (let n = 0; n < 50; n++) db.get(query(n));
    expect(db.statementCount).toBe(5);
    await db.close();
  });

  it('defaults to 500', async () => {
    const db = open();
    for (let n = 0; n < 600; n++) db.get(query(n));
    expect(db.statementCount).toBe(500);
    await db.close();
  });

  it('keeps what is used and drops the least recently used', async () => {
    const db = open('3');
    const prepare = db.sqlite.prepare.bind(db.sqlite);
    const prepared: string[] = [];
    db.sqlite.prepare = ((sql: string) => (prepared.push(sql), prepare(sql))) as typeof db.sqlite.prepare;
    db.get(query(1));
    db.get(query(2));
    db.get(query(3));
    db.get(query(1)); // a hit: 1 is now the freshest, 2 the stalest
    db.get(query(4)); // evicts 2
    prepared.length = 0;
    db.get(query(1));
    db.get(query(3));
    db.get(query(4));
    expect(prepared).toEqual([]);
    db.get(query(2));
    expect(prepared).toEqual([query(2)]);
    await db.close();
  });

  it('prepares an evicted statement again, with the same result', async () => {
    const db = open('2');
    expect(db.get<{ n: number }>(query(1))?.n).toBe(1);
    db.get(query(2));
    db.get(query(3)); // 1 is gone
    expect(db.statementCount).toBe(2);
    expect(db.get<{ n: number }>(query(1))?.n).toBe(1);
    expect(db.all<{ n: number }>(query(1))).toEqual([{ n: 1 }]);
    await db.close();
  });

  it('keeps writes working while statements churn', async () => {
    const db = open('2');
    db.sqlite.exec('CREATE TABLE IF NOT EXISTS scratch (id TEXT PRIMARY KEY, v TEXT)');
    for (let n = 0; n < 10; n++) {
      db.get(query(n));
      db.sqlite.prepare('INSERT INTO scratch (id, v) VALUES (?, ?)').run(`k${n}`, 'x');
    }
    expect(db.all(`SELECT id FROM scratch`)).toHaveLength(10);
    await db.close();
  });
});
