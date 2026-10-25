/**
 * The storage port behind Data Tables. The service (./service) validates and
 * coerces everything first, so a backend receives typed cell values and typed
 * filters and only stores and queries them. ./json-storage keeps each table in
 * one JSON file; a SQLite or Postgres backend maps the same calls to tables,
 * WHERE clauses and transactions. The in-memory query helpers below define the
 * semantics such a backend has to match.
 */
import type { CellValue, ColumnType, DataTable, DataTableColumn, DataTableRow, DataTableSummary, RowFilter, RowPage, RowQuery } from '../../shared/data-tables';

/** Values of user columns, already coerced to the column types. */
export type RowValues = Record<string, CellValue>;

export interface DataTableStorage {
  /** Every table with its row count. */
  listTables(): DataTableSummary[];
  getTable(id: string): DataTable | undefined;
  /** Create an empty table. */
  createTable(table: DataTable): void;
  /** Save a table's name and columns. A new column reads as null in existing rows. */
  saveTable(table: DataTable): void;
  deleteTable(id: string): boolean;
  /** Move a column's values to a new name (the caller saves the renamed column). */
  renameColumn(tableId: string, from: string, to: string): void;
  /** Drop a column's values (the caller saves the table without it). */
  dropColumn(tableId: string, name: string): void;
  countRows(tableId: string): number;
  queryRows(tableId: string, query: RowQuery): RowPage;
  /** Insert rows; the backend assigns `id`, `createdAt` and `updatedAt`. */
  insertRows(tableId: string, rows: RowValues[]): DataTableRow[];
  /** Set `values` on every row the filter matches; returns the updated rows. */
  updateRows(tableId: string, filter: RowFilter, values: RowValues): DataTableRow[];
  /** Delete every row the filter matches; returns the deleted rows. */
  deleteRows(tableId: string, filter: RowFilter): DataTableRow[];
  /** Run `fn` as one unit: everything it changed is kept, or nothing if it throws. `fn` must be synchronous. */
  transaction<T>(tableId: string, fn: () => T): T;
}

export class DataTableError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** The type of a column or system column (`id` is a number, the timestamps are dates). */
export function typeOf(columns: DataTableColumn[], name: string): ColumnType | undefined {
  if (name === 'id') return 'number';
  if (name === 'createdAt' || name === 'updatedAt') return 'date';
  return columns.find((c) => c.name === name)?.type;
}

const isEmpty = (value: unknown) => value === null || value === undefined || value === '';

/** Order two cells of one type; empty cells sort last. */
export function compareCells(a: unknown, b: unknown, type: ColumnType | undefined): number {
  if (isEmpty(a) || isEmpty(b)) return isEmpty(a) === isEmpty(b) ? 0 : isEmpty(a) ? 1 : -1;
  switch (type) {
    case 'number':
      return Number(a) - Number(b);
    case 'boolean':
      return Number(a === true) - Number(b === true);
    case 'date':
      return Date.parse(String(a)) - Date.parse(String(b));
    default:
      return String(a).localeCompare(String(b));
  }
}

/** Whether a row matches a filter whose values were coerced to the column types. */
export function matchesFilter(row: DataTableRow, filter: RowFilter | undefined, columns: DataTableColumn[]): boolean {
  if (!filter) return true;
  if (filter.ids && !filter.ids.includes(row.id)) return false;
  const conditions = filter.conditions ?? [];
  if (!conditions.length) return true;
  const test = (index: number) => {
    const { column, operator, value } = conditions[index];
    const cell = row[column];
    const type = typeOf(columns, column);
    switch (operator) {
      case 'isEmpty':
        return isEmpty(cell);
      case 'isNotEmpty':
        return !isEmpty(cell);
      case 'contains':
        return !isEmpty(cell) && String(cell).toLowerCase().includes(String(value ?? '').toLowerCase());
      case 'eq':
        return isEmpty(value) ? isEmpty(cell) : !isEmpty(cell) && compareCells(cell, value, type) === 0;
      case 'neq':
        return isEmpty(value) ? !isEmpty(cell) : isEmpty(cell) || compareCells(cell, value, type) !== 0;
      default: {
        if (isEmpty(cell) || isEmpty(value)) return false;
        const order = compareCells(cell, value, type);
        return operator === 'gt' ? order > 0 : operator === 'gte' ? order >= 0 : operator === 'lt' ? order < 0 : order <= 0;
      }
    }
  };
  return filter.type === 'or' ? conditions.some((_c, i) => test(i)) : conditions.every((_c, i) => test(i));
}

/** Case-insensitive substring search over the id and every column. */
export function matchesSearch(row: DataTableRow, search: string | undefined, columns: DataTableColumn[]): boolean {
  const query = search?.trim().toLowerCase();
  if (!query) return true;
  if (String(row.id) === query) return true;
  return columns.some((column) => !isEmpty(row[column.name]) && String(row[column.name]).toLowerCase().includes(query));
}

/** Filter, search, sort and page rows in memory: the reference semantics of `queryRows`. */
export function queryInMemory(rows: DataTableRow[], query: RowQuery, columns: DataTableColumn[]): RowPage {
  let matched = rows.filter((row) => matchesFilter(row, query.filter, columns) && matchesSearch(row, query.search, columns));
  const total = matched.length;
  if (query.sortBy) {
    const type = typeOf(columns, query.sortBy);
    const direction = query.sortDirection === 'desc' ? -1 : 1;
    const key = query.sortBy;
    // Empty cells stay last in both directions; ties keep insertion order.
    matched = [...matched].sort((a, b) => {
      const emptyA = isEmpty(a[key]);
      const emptyB = isEmpty(b[key]);
      if (emptyA || emptyB) return emptyA === emptyB ? a.id - b.id : emptyA ? 1 : -1;
      return compareCells(a[key], b[key], type) * direction || a.id - b.id;
    });
  }
  const offset = Math.max(0, Math.floor(query.offset ?? 0));
  const limit = query.limit === undefined ? Math.max(0, total - offset) : Math.max(0, Math.floor(query.limit));
  return { rows: matched.slice(offset, offset + limit), total, offset, limit };
}
