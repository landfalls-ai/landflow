/** A read is one SELECT on SQLite (rv4 probes): everything else, and every other database, is a write. */
import { describe, expect, it } from 'vitest';
import { readsByQuery, sendingSteps, writesOutside } from '@/lib/shared/run-check';

const sqlite = 'databases.sqlite';
const reads: unknown[] = ['SELECT 1', 'select total from sales;', '/* hi */ SELECT 1', 'SELECT 1 /* ; */', "SELECT ';' ", 'SELECT * FROM t -- DELETE FROM t'];
const writes: Array<[string, unknown]> = [
  ['WITH ... DELETE', 'WITH d AS (SELECT 1) DELETE FROM t'],
  ['WITH in a select', 'WITH x AS (SELECT 1) SELECT * FROM x'],
  ['Postgres CTE DELETE', 'WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d'],
  ['PRAGMA write', 'PRAGMA writable_schema=1'],
  ['pragma lower', 'pragma user_version = 7'],
  ['PRAGMA journal', 'PRAGMA journal_mode=OFF'],
  ['$fromAI in write SQL', 'DELETE FROM sales WHERE id = {{ $fromAI("id") }}'],
  ['$fromAI alone', "{{ $fromAI('sql', 'any SQL', 'string') }}"],
  ['a comment hides $fromAI', 'DROP TABLE sales -- $fromAI('],
  ['empty', ''],
  ['blank', '   '],
  ['undefined', undefined],
  ['object', { a: 1 }],
  ['array', ['SELECT 1']],
  ['expression', '={{ $json.sql }}'],
  ['EXPLAIN ANALYZE', 'EXPLAIN ANALYZE DELETE FROM t'],
  ['explain', 'explain delete from t'],
  ['SELECT INTO', 'SELECT * INTO copy FROM t'],
  ['INTO OUTFILE', "SELECT * FROM t INTO OUTFILE '/tmp/x'"],
  ['nextval', "SELECT nextval('seq')"],
  ['FOR UPDATE', 'SELECT * FROM t FOR UPDATE'],
  ['dblink_exec', "SELECT dblink_exec('x', 'DELETE FROM t')"],
  ['load_extension', "SELECT load_extension('/tmp/evil')"],
  ['stacked', 'SELECT 1; DROP TABLE x'],
  ['stacked after a comment', 'SELECT * FROM t -- c\n; DELETE FROM t'],
  ['a NUL hides a statement', 'SELECT 1\u0000; DELETE FROM t'],
  ['unclosed comment', 'SELECT 1 /* ; DELETE FROM t'],
  ['ATTACH', 'ATTACH DATABASE "/tmp/x.db" AS x'],
  ['VACUUM INTO', "VACUUM INTO '/tmp/x.db'"],
  ['SHOW', 'SHOW TABLES'],
];
describe('readsByQuery', () => {
  it.each(reads)('SQLite %j is a read', (query) => expect(readsByQuery({ operation: 'executeQuery', query }, sqlite)).toBe(true));
  it.each(writes)('SQLite: %s is not a read', (_name, query) => expect(readsByQuery({ operation: 'executeQuery', ...(query !== undefined && { query }) }, sqlite)).toBe(false));
  it('Postgres and MySQL are never a read, nor is another operation', () => {
    for (const type of ['databases.postgres', 'databases.mysql', undefined]) expect(readsByQuery({ operation: 'executeQuery', query: 'SELECT 1' }, type)).toBe(false);
    expect(readsByQuery({ operation: 'select', query: 'SELECT 1' }, sqlite)).toBe(false);
  });
  it('the test-run gate: a SELECT on SQLite sends nothing, the rest still does', () => {
    expect(writesOutside({ type: sqlite, parameters: { operation: 'executeQuery', query: 'SELECT 1' } })).toBe(false);
    expect(writesOutside({ type: sqlite, parameters: { operation: 'executeQuery', query: 'DELETE FROM t' } })).toBe(true);
    expect(writesOutside({ type: 'databases.postgres', parameters: { operation: 'executeQuery', query: 'SELECT 1' } })).toBe(true);
    expect(sendingSteps([{ name: 'Q', type: sqlite, parameters: { operation: 'executeQuery', query: 'SELECT 1' } } as never])).toEqual([]);
    expect(sendingSteps([{ name: 'Q', type: sqlite, parameters: { operation: 'insert' } } as never])).toEqual(['Q']);
  });
});
