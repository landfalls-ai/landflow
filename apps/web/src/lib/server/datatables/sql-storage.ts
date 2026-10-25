/**
 * Data Tables in the database (the default storage): a `data_tables` row per table (its name and
 * columns, and the next row id) and a `data_table_rows` row per table row. Writes are row-level
 * (an insert writes the new rows, an update or delete only the matched ones), so a change costs the
 * rows it touches rather than the whole table. Queries are answered with the reference semantics
 * of ./storage (`queryInMemory`) over a per-table row cache that every write keeps current; a
 * transaction that throws is rolled back in the database and drops the table from the cache.
 */
import type { DataTable, DataTableRow, DataTableSummary, RowFilter, RowPage, RowQuery } from '../../shared/data-tables';
import { database, type Database } from '../db';
import { dataTableRow, parse, tableRowRow } from '../db/rows';
import { DataTableError, matchesFilter, queryInMemory, type DataTableStorage, type RowValues } from './storage';

interface CachedTable {
  table: DataTable;
  nextId: number;
  /** In id order; loaded on the first row query. */
  rows?: DataTableRow[];
}

const safeId = (id: string) => /^[\w-]+$/.test(id);
const now = () => new Date().toISOString();

export class SqlDataTableStorage implements DataTableStorage {
  constructor(
    private readonly db: () => Database = database,
    /** Shared between instances (module graphs, hot reloads) so they all see the same rows. */
    private readonly cache = new Map<string, CachedTable>(),
  ) {}

  private load(id: string): CachedTable | undefined {
    if (!safeId(id)) return undefined;
    let entry = this.cache.get(id);
    if (!entry) {
      const row = this.db().get<{ data: string; next_row_id: number }>('SELECT data, next_row_id FROM data_tables WHERE id = ?', id);
      const table = parse<DataTable>(row?.data);
      if (!row || !table) return undefined;
      entry = { table, nextId: Number(row.next_row_id) || 1 };
      this.cache.set(id, entry);
    }
    return entry;
  }

  private open(id: string): CachedTable {
    const entry = this.load(id);
    if (!entry) throw new DataTableError('Data table not found', 404);
    return entry;
  }

  private rows(entry: CachedTable): DataTableRow[] {
    entry.rows ??= this.db()
      .all<{ data: string }>('SELECT data FROM data_table_rows WHERE table_id = ? ORDER BY id', entry.table.id)
      .flatMap((row) => parse<DataTableRow>(row.data) ?? []);
    return entry.rows;
  }

  /** Run writes as one transaction; if it throws, the table is reloaded from the database next time. */
  private write<T>(tableId: string, fn: () => T): T {
    try {
      return this.db().transaction(fn);
    } catch (error) {
      this.cache.delete(tableId);
      throw error;
    }
  }

  /** Save the table row (name, columns, next id) and cache it. */
  private putTable(entry: CachedTable) {
    this.db().upsert('data_tables', dataTableRow(entry.table, entry.nextId));
    this.cache.set(entry.table.id, entry);
  }

  /** Bump `updatedAt` after a row change. */
  private touch(entry: CachedTable) {
    entry.table = { ...entry.table, updatedAt: now() };
    this.putTable(entry);
  }

  listTables(): DataTableSummary[] {
    return this.db()
      .all<{ data: string; rows: number }>('SELECT t.data AS data, (SELECT COUNT(*) FROM data_table_rows r WHERE r.table_id = t.id) AS rows FROM data_tables t')
      .flatMap((row) => {
        const table = parse<DataTable>(row.data);
        return table ? [{ ...table, rowCount: Number(row.rows) }] : [];
      });
  }

  getTable(id: string): DataTable | undefined {
    const entry = this.load(id);
    return entry && structuredClone(entry.table);
  }

  createTable(table: DataTable) {
    if (!safeId(table.id)) throw new DataTableError('Invalid table id');
    this.write(table.id, () => {
      this.db().delete('data_table_rows', { table_id: table.id });
      this.putTable({ table: structuredClone(table), nextId: 1, rows: [] });
    });
  }

  saveTable(table: DataTable) {
    const entry = this.open(table.id);
    this.putTable({ ...entry, table: structuredClone(table) });
  }

  deleteTable(id: string): boolean {
    if (!this.load(id)) return false;
    this.write(id, () => {
      this.db().delete('data_table_rows', { table_id: id });
      this.db().delete('data_tables', { id });
    });
    this.cache.delete(id);
    return true;
  }

  /** Rewrite the rows `change` returns a new version of. */
  private rewrite(tableId: string, change: (row: DataTableRow) => DataTableRow | undefined) {
    const entry = this.open(tableId);
    const rows = this.rows(entry);
    this.write(tableId, () => {
      entry.rows = rows.map((row) => {
        const next = change(row);
        if (!next) return row;
        this.db().upsert('data_table_rows', tableRowRow(tableId, next));
        return next;
      });
    });
  }

  renameColumn(tableId: string, from: string, to: string) {
    this.rewrite(tableId, (row) => {
      if (!(from in row)) return undefined;
      const { [from]: value, ...rest } = row;
      return { ...rest, [to]: value } as DataTableRow;
    });
  }

  dropColumn(tableId: string, name: string) {
    this.rewrite(tableId, (row) => {
      if (!(name in row)) return undefined;
      const { [name]: _dropped, ...rest } = row;
      return rest as DataTableRow;
    });
  }

  countRows(tableId: string): number {
    const entry = this.open(tableId);
    if (entry.rows) return entry.rows.length;
    return Number(this.db().get<{ n: number }>('SELECT COUNT(*) AS n FROM data_table_rows WHERE table_id = ?', tableId)?.n ?? 0);
  }

  queryRows(tableId: string, query: RowQuery): RowPage {
    const entry = this.open(tableId);
    const page = queryInMemory(this.rows(entry), query, entry.table.columns);
    return { ...page, rows: page.rows.map((row) => ({ ...row })) };
  }

  insertRows(tableId: string, values: RowValues[]): DataTableRow[] {
    const entry = this.open(tableId);
    const rows = this.rows(entry);
    const stamp = now();
    let nextId = entry.nextId;
    const inserted = values.map((row) => ({ ...row, id: nextId++, createdAt: stamp, updatedAt: stamp }) as DataTableRow);
    this.write(tableId, () => {
      for (const row of inserted) this.db().upsert('data_table_rows', tableRowRow(tableId, row));
      entry.rows = [...rows, ...inserted];
      entry.nextId = nextId;
      this.touch(entry);
    });
    return inserted.map((row) => ({ ...row }));
  }

  updateRows(tableId: string, filter: RowFilter, values: RowValues): DataTableRow[] {
    const entry = this.open(tableId);
    const stamp = now();
    const updated: DataTableRow[] = [];
    const rows = this.rows(entry).map((row) => {
      if (!matchesFilter(row, filter, entry.table.columns)) return row;
      const next = { ...row, ...values, id: row.id, createdAt: row.createdAt, updatedAt: stamp } as DataTableRow;
      updated.push(next);
      return next;
    });
    if (updated.length) {
      this.write(tableId, () => {
        for (const row of updated) this.db().upsert('data_table_rows', tableRowRow(tableId, row));
        entry.rows = rows;
        this.touch(entry);
      });
    }
    return updated.map((row) => ({ ...row }));
  }

  deleteRows(tableId: string, filter: RowFilter): DataTableRow[] {
    const entry = this.open(tableId);
    const deleted: DataTableRow[] = [];
    const rows = this.rows(entry).filter((row) => {
      if (!matchesFilter(row, filter, entry.table.columns)) return true;
      deleted.push(row);
      return false;
    });
    if (deleted.length) {
      this.write(tableId, () => {
        for (const row of deleted) this.db().delete('data_table_rows', { table_id: tableId, id: row.id });
        entry.rows = rows;
        this.touch(entry);
      });
    }
    return deleted.map((row) => ({ ...row }));
  }

  transaction<T>(tableId: string, fn: () => T): T {
    this.open(tableId);
    return this.write(tableId, fn);
  }
}
