/**
 * `Database.atomic()` on its own (wave 5 carryover, note 1): outside a transaction it is one; inside one, a failure undoes
 * only its own rows and drops its own queued write ops (what Postgres mode would replay), and nested calls work. A fake
 * sink records what would be sent to Postgres.
 */
import { describe, expect, it } from 'vitest';
import { Database, openSqliteConnection, type WriteOp, type WriteSink } from '@/lib/server/db/database';

function open() {
  const batches: WriteOp[][] = [];
  const sink: WriteSink = { enqueue: (ops) => void batches.push(ops), flush: async () => {}, close: async () => {} };
  const db = new Database(openSqliteConnection(':memory:'), 'postgres', ':memory:', sink);
  const keys = () => db.all<{ key: string }>('SELECT key FROM meta ORDER BY key').map((row) => row.key);
  const sent = () => batches.map((ops) => ops.map((op) => (op.op === 'upsert' ? String(op.row.key) : op.op)));
  return { db, keys, sent };
}

const boom = () => {
  throw new Error('boom');
};

describe('Database.atomic', () => {
  it('outside a transaction is a transaction of its own', () => {
    const { db, keys, sent } = open();
    db.atomic(() => db.upsert('meta', { key: 'a', value: '1' }));
    expect(() => db.atomic(() => (db.upsert('meta', { key: 'b', value: '1' }), boom()))).toThrow('boom');
    expect(keys()).toEqual(['a']);
    expect(sent()).toEqual([['a']]);
  });

  it('inside a transaction, a failure drops its own rows and queued ops and keeps the outer ones', () => {
    const { db, keys, sent } = open();
    db.transaction(() => {
      db.upsert('meta', { key: 'before', value: '1' });
      expect(() => db.atomic(() => (db.upsert('meta', { key: 'inner', value: '1' }), boom()))).toThrow('boom');
      db.upsert('meta', { key: 'after', value: '1' });
    });
    expect(keys()).toEqual(['after', 'before']);
    expect(sent()).toEqual([['before', 'after']]);
  });

  it('nested calls commit together, and a failing inner one undoes only itself', () => {
    const { db, keys, sent } = open();
    db.transaction(() => {
      db.atomic(() => {
        db.upsert('meta', { key: 'outer', value: '1' });
        db.atomic(() => db.upsert('meta', { key: 'kept', value: '1' }));
        expect(() => db.atomic(() => (db.upsert('meta', { key: 'dropped', value: '1' }), boom()))).toThrow('boom');
      });
    });
    expect(keys()).toEqual(['kept', 'outer']);
    expect(sent()).toEqual([['outer', 'kept']]);
  });

  it('an outer failure after a successful atomic rolls everything back and sends nothing', () => {
    const { db, keys, sent } = open();
    expect(() =>
      db.transaction(() => {
        db.atomic(() => db.upsert('meta', { key: 'inner', value: '1' }));
        boom();
      }),
    ).toThrow('boom');
    expect(keys()).toEqual([]);
    expect(sent()).toEqual([]);
  });
});
