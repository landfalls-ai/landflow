/**
 * Data Tables: the JSON storage, coercion, filters, sorting and paging,
 * upsert, column changes, limits, CSV round-trips, and the Data Table node's
 * operations through the engine.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { DataTableRow } from '@/lib/shared/data-tables';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-datatables-'));
const previousDir = process.env.LANDFLOW_DATA_DIR;
process.env.LANDFLOW_DATA_DIR = dataDir;

const { coerceCell, CoercionError, dataTables, DataTableError, DataTablesService, inferType, JsonFileStorage, parseCsv, toCsv } = await import('@/lib/server/datatables');
const { dataTableNode } = await import('@/lib/server/nodes/datatable');
const { outputsOf, runFlow } = await import('./helpers');

afterAll(() => {
  process.env.LANDFLOW_DATA_DIR = previousDir;
});

const tmp = () => mkdtempSync(join(tmpdir(), 'landflow-dt-'));
const service = (options: { maxRows?: number; maxBytes?: number; dir?: string } = {}) =>
  new DataTablesService(new JsonFileStorage(options.dir ?? tmp(), new Map(), options.maxBytes), options.maxRows);

const PEOPLE = [
  { name: 'name', type: 'string' },
  { name: 'age', type: 'number' },
  { name: 'active', type: 'boolean' },
  { name: 'joined', type: 'date' },
] as const;

function people(svc = service()) {
  const table = svc.createTable({ name: 'People', columns: [...PEOPLE] });
  svc.insertRows(table.id, [
    { name: 'Ada', age: 36, active: true, joined: '2024-01-15' },
    { name: 'Grace', age: '45', active: 'yes', joined: '2023-06-01T09:30:00Z' },
    { name: 'Linus', age: 28, active: false, joined: null },
    { name: 'margaret', age: null, active: 'false', joined: '2025-03-10' },
  ]);
  return { svc, table };
}

const names = (rows: DataTableRow[]) => rows.map((r) => r.name);

describe('coercion', () => {
  it('coerces values to the column types', () => {
    expect(coerceCell(42, 'string')).toBe('42');
    expect(coerceCell({ a: 1 }, 'string')).toBe('{"a":1}');
    expect(coerceCell('', 'string')).toBe('');
    expect(coerceCell(' 3.5 ', 'number')).toBe(3.5);
    expect(coerceCell('-1e3', 'number')).toBe(-1000);
    expect(coerceCell('', 'number')).toBeNull();
    expect(coerceCell('YES', 'boolean')).toBe(true);
    expect(coerceCell(0, 'boolean')).toBe(false);
    expect(coerceCell('off', 'boolean')).toBe(false);
    expect(coerceCell('2024-01-15', 'date')).toBe('2024-01-15T00:00:00.000Z');
    expect(coerceCell(0, 'date')).toBe('1970-01-01T00:00:00.000Z');
    expect(coerceCell(new Date('2024-02-03T04:05:06Z'), 'date')).toBe('2024-02-03T04:05:06.000Z');
    expect(coerceCell(undefined, 'number')).toBeNull();
    expect(coerceCell(null, 'date')).toBeNull();
  });

  it('rejects values that do not fit', () => {
    expect(() => coerceCell('abc', 'number')).toThrow(CoercionError);
    expect(() => coerceCell('12px', 'number')).toThrow(/expects a number, got "12px"/);
    expect(() => coerceCell('maybe', 'boolean')).toThrow(CoercionError);
    expect(() => coerceCell(2, 'boolean')).toThrow(CoercionError);
    expect(() => coerceCell('not a date', 'date')).toThrow(CoercionError);
    expect(() => coerceCell('5', 'date')).toThrow(CoercionError);
    expect(() => coerceCell(Number.NaN, 'number')).toThrow(CoercionError);
  });

  it('coerces inserted rows and reports the column on a bad value', () => {
    const { svc, table } = people();
    const rows = svc.listRows(table.id).rows;
    expect(rows[1]).toMatchObject({ id: 2, name: 'Grace', age: 45, active: true, joined: '2023-06-01T09:30:00.000Z' });
    expect(rows[3]).toMatchObject({ age: null, active: false });
    expect(() => svc.insertRows(table.id, [{ name: 'Bad', age: 'old' }])).toThrow('Column "age" expects a number, got "old"');
    expect(() => svc.insertRows(table.id, [{ nickname: 'x' }])).toThrow('Unknown column "nickname"');
    expect(svc.insertRows(table.id, [{ name: 'Ignored', nickname: 'x', id: 999 }], { ignoreUnknown: true })[0]).toMatchObject({ id: 5, name: 'Ignored', age: null });
  });
});

describe('tables and columns', () => {
  it('validates table and column names', () => {
    const svc = service();
    svc.createTable({ name: 'Orders' });
    expect(() => svc.createTable({ name: ' orders ' })).toThrow(expect.objectContaining({ status: 409 }));
    expect(() => svc.createTable({ name: '  ' })).toThrow(/name/);
    expect(() => svc.createTable({ name: 'T', columns: [{ name: '1st', type: 'string' }] })).toThrow(/not a valid column name/);
    expect(() => svc.createTable({ name: 'T', columns: [{ name: 'id', type: 'string' }] })).toThrow(/system column/);
    expect(() => svc.createTable({ name: 'T', columns: [{ name: 'a', type: 'json' }] })).toThrow(/Column types/);
    expect(() => svc.createTable({ name: 'T', columns: [{ name: 'a', type: 'string' }, { name: 'A', type: 'number' }] })).toThrow(/already a column/);
  });

  it('lists tables by name with row counts, renames and deletes', () => {
    const svc = service();
    const b = svc.createTable({ name: 'beta', columns: [{ name: 'x', type: 'number' }] });
    const a = svc.createTable({ name: 'Alpha' });
    svc.insertRows(b.id, [{ x: 1 }, { x: 2 }]);
    expect(svc.listTables().map((t) => [t.name, t.rowCount])).toEqual([
      ['Alpha', 0],
      ['beta', 2],
    ]);
    expect(svc.renameTable(a.id, 'Gamma').name).toBe('Gamma');
    expect(() => svc.renameTable(a.id, 'BETA')).toThrow(/already exists/);
    expect(svc.findTable('gamma')?.id).toBe(a.id);
    expect(svc.deleteTable(a.id)).toBe(true);
    expect(svc.deleteTable(a.id)).toBe(false);
    expect(() => svc.getTable(a.id)).toThrow(expect.objectContaining({ status: 404 }));
  });

  it('adds, renames and deletes columns, carrying the row values', () => {
    const { svc, table } = people();
    svc.addColumn(table.id, { name: 'email', type: 'string' });
    expect(svc.listRows(table.id).rows[0].email).toBeUndefined();
    svc.updateRow(table.id, 1, { email: 'ada@example.com' });
    svc.renameColumn(table.id, 'email', 'mail');
    expect(svc.getTable(table.id).columns.map((c) => c.name)).toEqual(['name', 'age', 'active', 'joined', 'mail']);
    expect(svc.listRows(table.id).rows[0]).toMatchObject({ mail: 'ada@example.com' });
    expect(svc.listRows(table.id).rows[0]).not.toHaveProperty('email');
    expect(() => svc.renameColumn(table.id, 'mail', 'Name')).toThrow(/already a column/);
    svc.deleteColumn(table.id, 'mail');
    expect(svc.listRows(table.id).rows[0]).not.toHaveProperty('mail');
    expect(() => svc.deleteColumn(table.id, 'mail')).toThrow(expect.objectContaining({ status: 404 }));
  });

  it('persists to one JSON file per table', () => {
    const dir = tmp();
    const { table } = people(service({ dir }));
    const reopened = service({ dir });
    expect(reopened.listTables()).toMatchObject([{ id: table.id, name: 'People', rowCount: 4 }]);
    expect(names(reopened.listRows(table.id).rows)).toEqual(['Ada', 'Grace', 'Linus', 'margaret']);
    const file = JSON.parse(readFileSync(join(dir, `${table.id}.json`), 'utf8'));
    expect(file).toMatchObject({ version: 1, nextId: 5, table: { name: 'People' } });
  });
});

describe('queries', () => {
  it('filters with every operator, AND and OR', () => {
    const { svc, table } = people();
    const find = (conditions: unknown[], type: 'and' | 'or' = 'and') => names(svc.listRows(table.id, { filter: { type, conditions: conditions as never } }).rows);
    expect(find([{ column: 'name', operator: 'eq', value: 'Ada' }])).toEqual(['Ada']);
    expect(find([{ column: 'age', operator: 'eq', value: '45' }])).toEqual(['Grace']);
    expect(find([{ column: 'age', operator: 'neq', value: 36 }])).toEqual(['Grace', 'Linus', 'margaret']);
    expect(find([{ column: 'age', operator: 'gt', value: 36 }])).toEqual(['Grace']);
    expect(find([{ column: 'age', operator: 'gte', value: 36 }])).toEqual(['Ada', 'Grace']);
    expect(find([{ column: 'age', operator: 'lt', value: 36 }])).toEqual(['Linus']);
    expect(find([{ column: 'age', operator: 'lte', value: '36' }])).toEqual(['Ada', 'Linus']);
    expect(find([{ column: 'name', operator: 'contains', value: 'AR' }])).toEqual(['margaret']);
    expect(find([{ column: 'age', operator: 'isEmpty' }])).toEqual(['margaret']);
    expect(find([{ column: 'joined', operator: 'isNotEmpty' }])).toEqual(['Ada', 'Grace', 'margaret']);
    expect(find([{ column: 'active', operator: 'eq', value: 'true' }])).toEqual(['Ada', 'Grace']);
    expect(find([{ column: 'joined', operator: 'gt', value: '2024-01-01' }])).toEqual(['Ada', 'margaret']);
    expect(find([{ column: 'id', operator: 'gte', value: 3 }])).toEqual(['Linus', 'margaret']);
    expect(find([{ column: 'createdAt', operator: 'isNotEmpty' }])).toHaveLength(4);
    expect(find([{ column: 'active', operator: 'eq', value: true }, { column: 'age', operator: 'gt', value: 40 }])).toEqual(['Grace']);
    expect(find([{ column: 'name', operator: 'eq', value: 'Linus' }, { column: 'age', operator: 'isEmpty' }], 'or')).toEqual(['Linus', 'margaret']);
    expect(find([])).toHaveLength(4);
  });

  it('rejects unknown columns, operators and values that do not fit the column', () => {
    const { svc, table } = people();
    expect(() => svc.listRows(table.id, { filter: { conditions: [{ column: 'nope', operator: 'eq', value: 1 }] } })).toThrow('Unknown column "nope"');
    expect(() => svc.listRows(table.id, { filter: { conditions: [{ column: 'age', operator: 'like' as never, value: 1 }] } })).toThrow(/Unknown condition/);
    expect(() => svc.listRows(table.id, { filter: { conditions: [{ column: 'age', operator: 'gt', value: 'ten' }] } })).toThrow('Condition on "age" expects a number, got "ten"');
    expect(() => svc.listRows(table.id, { sortBy: 'nope' })).toThrow(/Unknown column/);
  });

  it('sorts (empty cells last), searches and pages', () => {
    const { svc, table } = people();
    expect(names(svc.listRows(table.id, { sortBy: 'age' }).rows)).toEqual(['Linus', 'Ada', 'Grace', 'margaret']);
    expect(names(svc.listRows(table.id, { sortBy: 'age', sortDirection: 'desc' }).rows)).toEqual(['Grace', 'Ada', 'Linus', 'margaret']);
    expect(names(svc.listRows(table.id, { sortBy: 'name' }).rows)).toEqual(['Ada', 'Grace', 'Linus', 'margaret']);
    expect(names(svc.listRows(table.id, { sortBy: 'joined', sortDirection: 'desc' }).rows)).toEqual(['margaret', 'Ada', 'Grace', 'Linus']);
    expect(names(svc.listRows(table.id, { search: 'GR' }).rows)).toEqual(['Grace']);
    expect(names(svc.listRows(table.id, { search: '2025' }).rows)).toEqual(['margaret']);
    const page = svc.listRows(table.id, { sortBy: 'id', sortDirection: 'desc', offset: 1, limit: 2 });
    expect(page).toMatchObject({ total: 4, offset: 1, limit: 2 });
    expect(names(page.rows)).toEqual(['Linus', 'Grace']);
  });
});

describe('writes', () => {
  it('updates by filter and by id, and deletes by ids or filter', () => {
    const { svc, table } = people();
    const updated = svc.updateRows(table.id, { conditions: [{ column: 'active', operator: 'eq', value: false }] }, { age: '99' });
    expect(names(updated)).toEqual(['Linus', 'margaret']);
    expect(updated.every((r) => r.age === 99 && r.updatedAt >= r.createdAt)).toBe(true);
    expect(svc.updateRow(table.id, 1, { name: 'Ada L.' })).toMatchObject({ id: 1, name: 'Ada L.', age: 36 });
    expect(() => svc.updateRow(table.id, 77, { name: 'x' })).toThrow(expect.objectContaining({ status: 404 }));
    expect(names(svc.deleteRows(table.id, { ids: [1, 3] }))).toEqual(['Ada L.', 'Linus']);
    expect(names(svc.deleteRows(table.id, { conditions: [{ column: 'age', operator: 'gt', value: 50 }] }))).toEqual(['margaret']);
    expect(names(svc.listRows(table.id).rows)).toEqual(['Grace']);
    // Ids keep counting up after deletes.
    expect(svc.insertRows(table.id, [{ name: 'New' }])[0].id).toBe(5);
  });

  it('upserts on the chosen columns: updates matches, inserts the rest', () => {
    const svc = service();
    const table = svc.createTable({ name: 'Contacts', columns: [{ name: 'email', type: 'string' }, { name: 'visits', type: 'number' }] });
    let result = svc.upsertRows(table.id, ['email'], [{ email: 'a@x.io', visits: 1 }, { email: 'b@x.io', visits: 1 }]);
    expect(result).toMatchObject({ inserted: 2, updated: 0 });
    result = svc.upsertRows(table.id, ['email'], [{ email: 'a@x.io', visits: 2 }, { email: 'c@x.io', visits: 1 }]);
    expect(result).toMatchObject({ inserted: 1, updated: 1 });
    expect(svc.listRows(table.id).rows.map((r) => [r.email, r.visits])).toEqual([
      ['a@x.io', 2],
      ['b@x.io', 1],
      ['c@x.io', 1],
    ]);
    expect(() => svc.upsertRows(table.id, ['email'], [{ visits: 3 }])).toThrow(/needs a value for "email"/);
    expect(() => svc.upsertRows(table.id, ['nope'], [{ email: 'x' }])).toThrow(/Unknown column/);
  });

  it('caps the rows per table', () => {
    const svc = service({ maxRows: 3 });
    const table = svc.createTable({ name: 'Small', columns: [{ name: 'n', type: 'number' }] });
    svc.insertRows(table.id, [{ n: 1 }, { n: 2 }]);
    expect(() => svc.insertRows(table.id, [{ n: 3 }, { n: 4 }])).toThrow(expect.objectContaining({ status: 413 }));
    expect(svc.listRows(table.id).total).toBe(2);
    svc.insertRows(table.id, [{ n: 3 }]);
    expect(() => svc.upsertRows(table.id, ['n'], [{ n: 9 }])).toThrow(/at most 3 rows/);
  });

  it('refuses a write past the size guard and keeps the table as it was', () => {
    const svc = service({ maxBytes: 2_000 });
    const table = svc.createTable({ name: 'Tiny', columns: [{ name: 'text', type: 'string' }] });
    svc.insertRows(table.id, [{ text: 'short' }]);
    expect(() => svc.insertRows(table.id, [{ text: 'x'.repeat(3_000) }])).toThrow(expect.objectContaining({ status: 413 }));
    expect(svc.listRows(table.id).rows.map((r) => r.text)).toEqual(['short']);
  });

  it('rolls a transaction back when it throws', () => {
    const { svc, table } = people();
    expect(() =>
      svc.transaction(table.id, () => {
        svc.insertRows(table.id, [{ name: 'Temp' }]);
        svc.deleteRows(table.id, { ids: [1] });
        throw new DataTableError('stop');
      }),
    ).toThrow('stop');
    expect(names(svc.listRows(table.id).rows)).toEqual(['Ada', 'Grace', 'Linus', 'margaret']);
    svc.transaction(table.id, () => {
      svc.insertRows(table.id, [{ name: 'Kept' }]);
      svc.updateRow(table.id, 2, { age: 46 });
    });
    expect(svc.listRows(table.id, { filter: { conditions: [{ column: 'name', operator: 'eq', value: 'Kept' }] } }).total).toBe(1);
    expect(svc.listRows(table.id).rows[1].age).toBe(46);
  });
});

describe('CSV', () => {
  it('parses quotes, escaped quotes, line breaks in fields, CRLF, a BOM and semicolons', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n"multi\nline",\r\n\r\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['multi\nline', ''],
    ]);
    expect(parseCsv('name;age\nAda;36')).toEqual([
      ['name', 'age'],
      ['Ada', '36'],
    ]);
    expect(toCsv([['a', 'b, c', 'q"uote', null, 1, true]])).toBe('a,"b, c","q""uote",,1,true\r\n');
  });

  it('infers types for new columns', () => {
    expect(inferType(['1', '2.5', '', '-3'])).toBe('number');
    expect(inferType(['true', 'FALSE'])).toBe('boolean');
    expect(inferType(['2024-01-01', '2024-02-03T10:00:00Z'])).toBe('date');
    expect(inferType(['1', 'two'])).toBe('string');
    expect(inferType(['', ''])).toBe('string');
  });

  it('round-trips a table through export and import', () => {
    const { svc, table } = people();
    svc.updateRow(table.id, 3, { name: 'Linus "the penguin", T.' });
    svc.insertRows(table.id, [{ name: 'line\nbreak', age: 1.5 }]);
    const csv = svc.exportCsv(table.id);
    expect(csv.split('\r\n')[0]).toBe('id,name,age,active,joined,createdAt,updatedAt');

    const copy = svc.createTable({ name: 'Copy', columns: [...PEOPLE] });
    const result = svc.importCsv(copy.id, csv);
    expect(result).toEqual({ inserted: 5, columnsAdded: [], skipped: ['id', 'createdAt', 'updatedAt'] });
    const strip = (rows: DataTableRow[]) => rows.map(({ createdAt: _c, updatedAt: _u, ...rest }) => rest);
    expect(strip(svc.listRows(copy.id).rows)).toEqual(strip(svc.listRows(table.id).rows));
  });

  it('creates columns for unknown headers unless told not to', () => {
    const svc = service();
    const table = svc.createTable({ name: 'Import', columns: [{ name: 'name', type: 'string' }] });
    const result = svc.importCsv(table.id, 'Name,Score,Signed up,Is Admin,ID\nAda,10,2024-01-02,true,7\nBob,,2024-02-03,false,8\n');
    expect(result.inserted).toBe(2);
    expect(result.columnsAdded).toEqual([
      { name: 'Score', type: 'number' },
      { name: 'Signed_up', type: 'date' },
      { name: 'Is_Admin', type: 'boolean' },
    ]);
    expect(result.skipped).toEqual(['ID']);
    expect(svc.listRows(table.id).rows.map((r) => [r.id, r.name, r.Score, r.Signed_up, r.Is_Admin])).toEqual([
      [1, 'Ada', 10, '2024-01-02T00:00:00.000Z', true],
      [2, 'Bob', null, '2024-02-03T00:00:00.000Z', false],
    ]);
    const strict = svc.importCsv(table.id, 'name,extra\nCy,1', { createColumns: false });
    expect(strict).toEqual({ inserted: 1, columnsAdded: [], skipped: ['extra'] });
  });

  it('reports the line of a value that does not fit, and imports nothing', () => {
    const svc = service();
    const table = svc.createTable({ name: 'Typed', columns: [{ name: 'n', type: 'number' }] });
    expect(() => svc.importCsv(table.id, 'n\n1\n2\nthree\n')).toThrow('Line 4: Column "n" expects a number, got "three"');
    expect(svc.listRows(table.id).total).toBe(0);
  });
});

describe('Data Table node', () => {
  const svc = dataTables();
  let tableId = '';

  beforeEach(() => {
    for (const table of svc.listTables()) svc.deleteTable(table.id);
    tableId = svc.createTable({ name: 'Leads', columns: [{ name: 'email', type: 'string' }, { name: 'score', type: 'number' }, { name: 'vip', type: 'boolean' }] }).id;
  });

  const node = (parameters: Record<string, unknown>) => ({ name: 'Table', type: 'core.dataTable', parameters: { dataTableId: tableId, ...parameters } });
  const run = async (parameters: Record<string, unknown>, input: Array<Record<string, unknown>> = [{}]) => runFlow([node(parameters)], [['Start', 'Table']], { input });
  const rows = () => svc.listRows(tableId).rows;
  const seed = () =>
    svc.insertRows(tableId, [
      { email: 'a@x.io', score: 10, vip: false },
      { email: 'b@x.io', score: 50, vip: true },
      { email: 'c@x.io', score: 90, vip: true },
    ]);

  it('inserts rows mapped column by column with expressions', async () => {
    const result = await run(
      { operation: 'insert', mappingMode: 'defineBelow', columns: { column: [{ column: 'email', value: '{{ $json.mail }}' }, { column: 'score', value: '{{ $json.points * 2 }}' }] } },
      [{ mail: 'a@x.io', points: 4 }, { mail: 'b@x.io', points: '5' }],
    );
    expect(outputsOf(result, 'Table')[0]).toMatchObject([
      { id: 1, email: 'a@x.io', score: 8, vip: null },
      { id: 2, email: 'b@x.io', score: 10, vip: null },
    ]);
    expect(rows()).toHaveLength(2);
  });

  it('inserts rows mapped automatically from the item fields, ignoring the rest', async () => {
    await run({ operation: 'insert', mappingMode: 'autoMapInputData' }, [{ email: 'z@x.io', score: '7', vip: 'yes', other: 'ignored', id: 99 }]);
    expect(rows()).toMatchObject([{ id: 1, email: 'z@x.io', score: 7, vip: true }]);
    expect(rows()[0]).not.toHaveProperty('other');
  });

  it('gets rows by conditions, with a limit and an order, or all of them', async () => {
    seed();
    const vips = await run({ operation: 'get', matchType: 'allConditions', filters: { conditions: [{ keyName: 'vip', condition: 'eq', keyValue: 'true' }] }, returnAll: true });
    expect(outputsOf(vips, 'Table')[0].map((r) => r.email)).toEqual(['b@x.io', 'c@x.io']);
    const top = await run({ operation: 'get', returnAll: false, limit: 2, options: { orderByColumn: 'score', orderByDirection: 'DESC' } });
    expect(outputsOf(top, 'Table')[0].map((r) => r.email)).toEqual(['c@x.io', 'b@x.io']);
    const any = await run({
      operation: 'get',
      matchType: 'anyCondition',
      returnAll: true,
      filters: { conditions: [{ keyName: 'score', condition: 'lt', keyValue: '20' }, { keyName: 'email', condition: 'contains', keyValue: '{{ $json.needle }}' }] },
    }, [{ needle: 'C@' }]);
    expect(outputsOf(any, 'Table')[0].map((r) => r.email)).toEqual(['a@x.io', 'c@x.io']);
  });

  it('updates the rows that match, and needs a condition', async () => {
    seed();
    const result = await run({
      operation: 'update',
      filters: { conditions: [{ keyName: 'score', condition: 'gte', keyValue: '50' }] },
      mappingMode: 'defineBelow',
      columns: { column: [{ column: 'vip', value: 'false' }] },
    });
    expect(outputsOf(result, 'Table')[0].map((r) => [r.email, r.vip])).toEqual([
      ['b@x.io', false],
      ['c@x.io', false],
    ]);
    const missing = await run({ operation: 'update', mappingMode: 'defineBelow', columns: { column: [{ column: 'vip', value: 'true' }] } });
    expect(missing.error?.message).toMatch(/Add a condition/);
  });

  it('upserts on the chosen columns', async () => {
    seed();
    const result = await run({ operation: 'upsert', matchingColumns: ['email'], mappingMode: 'autoMapInputData' }, [
      { email: 'b@x.io', score: 51 },
      { email: 'd@x.io', score: 1 },
    ]);
    expect(outputsOf(result, 'Table')[0].map((r) => [r.id, r.email, r.score])).toEqual([
      [2, 'b@x.io', 51],
      [4, 'd@x.io', 1],
    ]);
    expect(rows()).toHaveLength(4);
  });

  it('deletes the rows that match, or only lists them in a dry run', async () => {
    seed();
    const filters = { conditions: [{ keyName: 'vip', condition: 'eq', keyValue: 'true' }] };
    const dry = await run({ operation: 'deleteRows', filters, dryRun: true });
    expect(outputsOf(dry, 'Table')[0]).toHaveLength(2);
    expect(rows()).toHaveLength(3);
    const real = await run({ operation: 'deleteRows', filters });
    expect(outputsOf(real, 'Table')[0].map((r) => r.email)).toEqual(['b@x.io', 'c@x.io']);
    expect(rows().map((r) => r.email)).toEqual(['a@x.io']);
  });

  it('undoes a run when an item fails, unless the node continues on error', async () => {
    const bad = await run({ operation: 'insert', mappingMode: 'autoMapInputData' }, [{ email: 'ok@x.io' }, { email: 'bad@x.io', score: 'lots' }]);
    expect(bad.error?.message).toMatch(/Column "score" expects a number/);
    expect(rows()).toHaveLength(0);
  });

  it('finds a table by name and explains a missing one', async () => {
    const byName = await run({ dataTableId: 'leads', operation: 'insert', mappingMode: 'autoMapInputData' }, [{ email: 'n@x.io' }]);
    expect(outputsOf(byName, 'Table')[0]).toHaveLength(1);
    const missing = await run({ dataTableId: 'dt_gone', operation: 'get', returnAll: true });
    expect(missing.error?.message).toMatch(/Data table “dt_gone” not found/);
  });

  it('loads tables and columns for the pickers', async () => {
    const methods = dataTableNode.methods!.loadOptions!;
    const ctx = { getNodeParameter: (name: string, fallback?: unknown) => (name === 'dataTableId' ? tableId : fallback) } as never;
    expect(await methods.tables(ctx)).toEqual([{ name: 'Leads', value: tableId, description: '0 rows · 3 columns' }]);
    expect((await methods.columns(ctx)).map((o) => o.value)).toEqual(['email', 'score', 'vip']);
    expect((await methods.filterColumns(ctx)).map((o) => o.value)).toEqual(['email', 'score', 'vip', 'id', 'createdAt', 'updatedAt']);
    expect(dataTableNode.description.usableAsTool).toBe(true);
  });
});
