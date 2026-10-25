/**
 * Data Tables on JSON files: one document per table under
 * <data dir>/data-tables/<id>.json holding its columns, rows and next row id.
 * Documents are cached in memory after the first read; every change builds a
 * new document (rows are never mutated in place), checks the size guard and
 * is written atomically before it replaces the cached one, so a failed write
 * or a throwing transaction leaves the table as it was.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DataTable, DataTableRow, DataTableSummary, RowFilter, RowPage, RowQuery } from '../../shared/data-tables';
import { DataTableError, matchesFilter, queryInMemory, type DataTableStorage, type RowValues } from './storage';

/** Largest table file (serialized JSON). */
export const MAX_TABLE_BYTES = 32 * 1024 * 1024;

interface TableDocument {
  version: 1;
  table: DataTable;
  nextId: number;
  rows: DataTableRow[];
}

const safeId = (id: string) => /^[\w-]+$/.test(id);
const now = () => new Date().toISOString();

export class JsonFileStorage implements DataTableStorage {
  /** Working copies of tables inside a transaction. */
  private readonly pending = new Map<string, { doc: TableDocument }>();

  constructor(
    readonly dir: string,
    /** Shared between instances (module graphs, hot reloads) so they all see the same documents. */
    private readonly cache = new Map<string, TableDocument>(),
    private readonly maxBytes = MAX_TABLE_BYTES,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  private path(id: string) {
    return join(this.dir, `${id}.json`);
  }

  /** The current document: a transaction's working copy, the cached one, or the file. */
  private load(id: string): TableDocument | undefined {
    const pending = this.pending.get(id);
    if (pending) return pending.doc;
    if (!safeId(id)) return undefined;
    let doc = this.cache.get(id);
    if (!doc) {
      try {
        doc = JSON.parse(readFileSync(this.path(id), 'utf8')) as TableDocument;
      } catch {
        return undefined;
      }
      if (!doc?.table?.id) return undefined;
      doc.rows ??= [];
      doc.nextId ??= doc.rows.reduce((max, row) => Math.max(max, row.id), 0) + 1;
      this.cache.set(id, doc);
    }
    return doc;
  }

  private open(id: string): TableDocument {
    const doc = this.load(id);
    if (!doc) throw new DataTableError('Data table not found', 404);
    return doc;
  }

  /** Replace a document: inside a transaction only the working copy, otherwise write it. */
  private put(id: string, doc: TableDocument) {
    const pending = this.pending.get(id);
    if (pending) pending.doc = doc;
    else this.write(doc);
  }

  private write(doc: TableDocument) {
    const text = JSON.stringify(doc);
    if (Buffer.byteLength(text) > this.maxBytes) {
      throw new DataTableError(`“${doc.table.name}” would grow past ${Math.round(this.maxBytes / 1024 / 1024)} MB. Delete rows or split the table.`, 413);
    }
    const path = this.path(doc.table.id);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, path);
    this.cache.set(doc.table.id, doc);
  }

  /** A changed copy of the document with `updatedAt` bumped. */
  private touch(doc: TableDocument, change: Partial<TableDocument>): TableDocument {
    return { ...doc, ...change, table: { ...(change.table ?? doc.table), updatedAt: now() } };
  }

  listTables(): DataTableSummary[] {
    const ids = readdirSync(this.dir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => file.slice(0, -5));
    return ids.flatMap((id) => {
      const doc = this.load(id);
      return doc ? [{ ...structuredClone(doc.table), rowCount: doc.rows.length }] : [];
    });
  }

  getTable(id: string): DataTable | undefined {
    const doc = this.load(id);
    return doc && structuredClone(doc.table);
  }

  createTable(table: DataTable) {
    if (!safeId(table.id)) throw new DataTableError('Invalid table id');
    this.write({ version: 1, table: structuredClone(table), nextId: 1, rows: [] });
  }

  saveTable(table: DataTable) {
    const doc = this.open(table.id);
    this.put(table.id, { ...doc, table: structuredClone(table) });
  }

  deleteTable(id: string): boolean {
    if (!this.load(id)) return false;
    this.cache.delete(id);
    this.pending.delete(id);
    rmSync(this.path(id), { force: true });
    return true;
  }

  renameColumn(tableId: string, from: string, to: string) {
    const doc = this.open(tableId);
    const rows = doc.rows.map((row) => {
      if (!(from in row)) return row;
      const { [from]: value, ...rest } = row;
      return { ...rest, [to]: value } as DataTableRow;
    });
    this.put(tableId, { ...doc, rows });
  }

  dropColumn(tableId: string, name: string) {
    const doc = this.open(tableId);
    const rows = doc.rows.map((row) => {
      if (!(name in row)) return row;
      const { [name]: _dropped, ...rest } = row;
      return rest as DataTableRow;
    });
    this.put(tableId, { ...doc, rows });
  }

  countRows(tableId: string): number {
    return this.open(tableId).rows.length;
  }

  queryRows(tableId: string, query: RowQuery): RowPage {
    const doc = this.open(tableId);
    const page = queryInMemory(doc.rows, query, doc.table.columns);
    return { ...page, rows: page.rows.map((row) => ({ ...row })) };
  }

  insertRows(tableId: string, values: RowValues[]): DataTableRow[] {
    const doc = this.open(tableId);
    const stamp = now();
    let nextId = doc.nextId;
    const inserted = values.map((row) => ({ ...row, id: nextId++, createdAt: stamp, updatedAt: stamp }) as DataTableRow);
    this.put(tableId, this.touch(doc, { rows: [...doc.rows, ...inserted], nextId }));
    return inserted.map((row) => ({ ...row }));
  }

  updateRows(tableId: string, filter: RowFilter, values: RowValues): DataTableRow[] {
    const doc = this.open(tableId);
    const stamp = now();
    const updated: DataTableRow[] = [];
    const rows = doc.rows.map((row) => {
      if (!matchesFilter(row, filter, doc.table.columns)) return row;
      const next = { ...row, ...values, id: row.id, createdAt: row.createdAt, updatedAt: stamp } as DataTableRow;
      updated.push(next);
      return next;
    });
    if (updated.length) this.put(tableId, this.touch(doc, { rows }));
    return updated.map((row) => ({ ...row }));
  }

  deleteRows(tableId: string, filter: RowFilter): DataTableRow[] {
    const doc = this.open(tableId);
    const deleted: DataTableRow[] = [];
    const rows = doc.rows.filter((row) => {
      if (!matchesFilter(row, filter, doc.table.columns)) return true;
      deleted.push(row);
      return false;
    });
    if (deleted.length) this.put(tableId, this.touch(doc, { rows }));
    return deleted.map((row) => ({ ...row }));
  }

  transaction<T>(tableId: string, fn: () => T): T {
    if (this.pending.has(tableId)) return fn(); // nested: part of the outer transaction
    const original = this.open(tableId);
    const state = { doc: original };
    this.pending.set(tableId, state);
    try {
      const result = fn();
      if (result instanceof Promise) throw new Error('Data table transactions must be synchronous');
      this.pending.delete(tableId);
      if (state.doc !== original && this.load(tableId)) this.write(state.doc);
      return result;
    } finally {
      this.pending.delete(tableId);
    }
  }
}
