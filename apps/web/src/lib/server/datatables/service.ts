/**
 * Data Tables service: the rules on top of a DataTableStorage. It validates
 * names and columns, coerces cell values and filter values to the column
 * types, enforces the row cap, and does CSV import and export. The API routes
 * and the Data Table node both go through it.
 */
import { nanoid } from 'nanoid';
import {
  COLUMN_NAME,
  COLUMN_TYPES,
  CONDITION_OPERATORS,
  SYSTEM_COLUMNS,
  type CellValue,
  type ColumnType,
  type CsvImportResult,
  type DataTable,
  type DataTableColumn,
  type DataTableRow,
  type DataTableSummary,
  type RowCondition,
  type RowFilter,
  type RowPage,
  type RowQuery,
} from '../../shared/data-tables';
import { defaultProjectId, homeProjects } from '../projects/store';
import { singleton } from '../singleton';
import { parseCsv, toCsv } from './csv';
import { SqlDataTableStorage } from './sql-storage';
import { DataTableError, typeOf, type DataTableStorage, type RowValues } from './storage';

export const MAX_ROWS = 50_000;
export const MAX_COLUMNS = 100;
export const MAX_TABLES = 500;
const MAX_NAME = 128;

const SYSTEM = new Set<string>(SYSTEM_COLUMNS);
const SYSTEM_LOWER = new Set(SYSTEM_COLUMNS.map((c) => c.toLowerCase()));
const OPERATORS = new Map(CONDITION_OPERATORS.map((o) => [o.value, o]));
const TRUE = new Set(['true', '1', 'yes', 'y', 'on']);
const FALSE = new Set(['false', '0', 'no', 'n', 'off']);
const NUMBER_TEXT = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const DATE_TEXT = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

const now = () => new Date().toISOString();
const describe = (value: unknown) => {
  const text = typeof value === 'string' ? JSON.stringify(value) : value instanceof Date ? 'an invalid date' : JSON.stringify(value) ?? String(value);
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
};

/** A value that doesn't fit a column type. */
export class CoercionError extends Error {
  constructor(
    readonly type: ColumnType,
    readonly value: unknown,
  ) {
    super(`expects ${type === 'string' ? 'text' : `a ${type}`}, got ${describe(value)}`);
  }
}

/**
 * A value as a cell of `type`: null for null/undefined (and an empty string
 * outside string columns), numbers from numeric text, booleans from
 * true/false/yes/no/1/0, dates as ISO strings from anything Date.parse reads or
 * epoch milliseconds. Throws a CoercionError when the value doesn't fit.
 */
export function coerceCell(value: unknown, type: ColumnType): CellValue {
  if (value === undefined || value === null) return null;
  switch (type) {
    case 'string':
      if (typeof value === 'string') return value;
      if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
    case 'number':
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value === 'string') {
        const text = value.trim();
        if (!text) return null;
        if (NUMBER_TEXT.test(text)) return Number(text);
      }
      break;
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (value === 1 || value === 0) return value === 1;
      if (typeof value === 'string') {
        const text = value.trim().toLowerCase();
        if (!text) return null;
        if (TRUE.has(text)) return true;
        if (FALSE.has(text)) return false;
      }
      break;
    case 'date': {
      let date: Date | undefined;
      if (value instanceof Date) date = value;
      else if (typeof value === 'number') date = new Date(value);
      else if (typeof value === 'string') {
        const text = value.trim();
        if (!text) return null;
        // Date.parse is lenient ("5" is May 2001): ask for a four-digit year.
        if (/\d{4}/.test(text)) date = new Date(text);
      }
      if (date && !Number.isNaN(date.getTime())) return date.toISOString();
      break;
    }
  }
  throw new CoercionError(type, value);
}

/** The column type CSV values suggest: number, boolean or date when every non-empty value is one, else string. */
export function inferType(values: string[]): ColumnType {
  const filled = values.map((v) => v.trim()).filter(Boolean);
  if (!filled.length) return 'string';
  if (filled.every((v) => NUMBER_TEXT.test(v))) return 'number';
  if (filled.every((v) => v.toLowerCase() === 'true' || v.toLowerCase() === 'false')) return 'boolean';
  if (filled.every((v) => DATE_TEXT.test(v) && !Number.isNaN(Date.parse(v)))) return 'date';
  return 'string';
}

/** A CSV header as a valid column name: "First name" → "First_name", "2024" → "col_2024". */
function columnNameFrom(header: string): string {
  let name = header.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!/^[A-Za-z]/.test(name)) name = `col_${name}`;
  return name.slice(0, 63) || 'column';
}

export interface ValueOptions {
  /** Skip fields that aren't columns instead of failing (the node's "Map Automatically"). */
  ignoreUnknown?: boolean;
}

export class DataTablesService {
  constructor(
    readonly storage: DataTableStorage,
    readonly maxRows = MAX_ROWS,
  ) {}

  // ---- tables -------------------------------------------------------------

  /** Every table with its row count, by name. */
  listTables(): DataTableSummary[] {
    return this.storage.listTables().sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }

  getTable(id: string): DataTable {
    const table = this.storage.getTable(id);
    if (!table) throw new DataTableError('Data table not found', 404);
    return table;
  }

  /**
   * A table by id, or by name (case-insensitive) — what a node parameter may hold. Names are unique per project, so
   * `projectId` (the project of whoever asks) picks its table when other projects have one of that name too.
   */
  findTable(idOrName: string, projectId?: string): DataTable | undefined {
    const key = String(idOrName ?? '').trim();
    if (!key) return undefined;
    const byId = this.storage.getTable(key);
    if (byId) return byId;
    const named = this.storage.listTables().filter((t) => t.name.toLowerCase() === key.toLowerCase());
    return (projectId && this.inProject(named, projectId)[0]) || named[0];
  }

  /** The tables of `tables` that live in `projectId` (a table without a project row lives in the default project). */
  inProject<T extends { id: string }>(tables: T[], projectId: string | undefined): T[] {
    const homes = homeProjects('dataTable');
    const fallback = defaultProjectId();
    return tables.filter((t) => (homes.get(t.id) ?? fallback) === (projectId ?? fallback));
  }

  /**
   * `id`: keep a given id (Git sync creates tables under the ids in its files, so Data Table nodes keep pointing at them).
   * `projectId`: the project the table will live in, where its name must be free (the default project when omitted).
   */
  createTable(input: { name: string; columns?: Array<{ name: string; type: string }>; id?: string; projectId?: string }): DataTable {
    const tables = this.storage.listTables();
    if (tables.length >= MAX_TABLES) throw new DataTableError(`At most ${MAX_TABLES} data tables`);
    if (input.id !== undefined && (!/^[\w-]+$/.test(input.id) || this.storage.getTable(input.id))) throw new DataTableError(`Data table id "${input.id}" is invalid or taken`, 409);
    const name = this.checkTableName(input.name, this.inProject(tables, input.projectId));
    const columns: DataTableColumn[] = [];
    for (const column of input.columns ?? []) columns.push(this.checkColumn(columns, column));
    if (columns.length > MAX_COLUMNS) throw new DataTableError(`At most ${MAX_COLUMNS} columns`);
    const stamp = now();
    const table: DataTable = { id: input.id ?? `dt_${nanoid(12)}`, name, columns, createdAt: stamp, updatedAt: stamp };
    this.storage.createTable(table);
    return table;
  }

  renameTable(id: string, name: string): DataTable {
    const table = this.getTable(id);
    const checked = this.checkTableName(name, this.inProject(this.storage.listTables(), homeProjects('dataTable').get(id)), id);
    this.storage.saveTable({ ...table, name: checked, updatedAt: now() });
    return this.getTable(id);
  }

  deleteTable(id: string): boolean {
    return this.storage.deleteTable(id);
  }

  // ---- columns ------------------------------------------------------------

  addColumn(id: string, column: { name: string; type: string }): DataTable {
    const table = this.getTable(id);
    if (table.columns.length >= MAX_COLUMNS) throw new DataTableError(`At most ${MAX_COLUMNS} columns`);
    const added = this.checkColumn(table.columns, column);
    this.storage.saveTable({ ...table, columns: [...table.columns, added], updatedAt: now() });
    return this.getTable(id);
  }

  renameColumn(id: string, from: string, to: string): DataTable {
    const table = this.getTable(id);
    const column = this.column(table, from);
    const name = to.trim();
    if (name === column.name) return table;
    this.checkColumnName(
      table.columns.filter((c) => c.name !== column.name),
      name,
    );
    this.storage.transaction(id, () => {
      this.storage.renameColumn(id, column.name, name);
      this.storage.saveTable({ ...table, columns: table.columns.map((c) => (c.name === column.name ? { ...c, name } : c)), updatedAt: now() });
    });
    return this.getTable(id);
  }

  deleteColumn(id: string, name: string): DataTable {
    const table = this.getTable(id);
    const column = this.column(table, name);
    this.storage.transaction(id, () => {
      this.storage.dropColumn(id, column.name);
      this.storage.saveTable({ ...table, columns: table.columns.filter((c) => c.name !== column.name), updatedAt: now() });
    });
    return this.getTable(id);
  }

  // ---- rows ---------------------------------------------------------------

  /** Filter, search, sort and page; conditions are checked and their values coerced to the column types. */
  listRows(id: string, query: RowQuery = {}): RowPage {
    const table = this.getTable(id);
    if (query.sortBy && !typeOf(table.columns, query.sortBy)) throw new DataTableError(`Unknown column "${query.sortBy}"`);
    return this.storage.queryRows(id, { ...query, filter: this.prepareFilter(table, query.filter) });
  }

  insertRows(id: string, rows: Array<Record<string, unknown>>, options: ValueOptions = {}): DataTableRow[] {
    const table = this.getTable(id);
    const values = rows.map((row) => this.prepareValues(table, row, { ...options, fill: true }));
    if (!values.length) return [];
    this.checkRoom(id, table, values.length);
    return this.storage.insertRows(id, values);
  }

  /** Change one row by id. */
  updateRow(id: string, rowId: number, values: Record<string, unknown>): DataTableRow {
    const [row] = this.updateRows(id, { ids: [rowId] }, values);
    if (!row) throw new DataTableError(`Row ${rowId} not found`, 404);
    return row;
  }

  /** Set `values` on every row the filter matches. */
  updateRows(id: string, filter: RowFilter, values: Record<string, unknown>, options: ValueOptions = {}): DataTableRow[] {
    const table = this.getTable(id);
    const prepared = this.prepareValues(table, values, options);
    return this.storage.updateRows(id, this.prepareFilter(table, filter) ?? {}, prepared);
  }

  /**
   * For each row: update the rows whose `matchColumns` equal its values, or
   * insert it when none do. Returns every updated or inserted row, in order.
   */
  upsertRows(id: string, matchColumns: string[], rows: Array<Record<string, unknown>>, options: ValueOptions = {}): { rows: DataTableRow[]; inserted: number; updated: number } {
    const table = this.getTable(id);
    if (!matchColumns.length) throw new DataTableError('Choose the columns to match on');
    for (const name of matchColumns) if (!table.columns.some((c) => c.name === name)) throw new DataTableError(`Unknown column "${name}" to match on`);
    return this.storage.transaction(id, () => {
      const result = { rows: [] as DataTableRow[], inserted: 0, updated: 0 };
      for (const row of rows) {
        const values = this.prepareValues(table, row, options);
        const conditions: RowCondition[] = matchColumns.map((column) => {
          const value = values[column];
          if (value === undefined) throw new DataTableError(`Upsert needs a value for "${column}" to match on`);
          return { column, operator: 'eq', value };
        });
        const updated = this.storage.updateRows(id, { conditions }, values);
        if (updated.length) {
          result.rows.push(...updated);
          result.updated += updated.length;
        } else {
          this.checkRoom(id, table, 1);
          result.rows.push(...this.storage.insertRows(id, [this.fill(table, values)]));
          result.inserted += 1;
        }
      }
      return result;
    });
  }

  /** Delete every row the filter matches (all rows for an empty filter). */
  deleteRows(id: string, filter: RowFilter): DataTableRow[] {
    const table = this.getTable(id);
    return this.storage.deleteRows(id, this.prepareFilter(table, filter) ?? {});
  }

  /** Run several operations on one table as a unit (one file write). `fn` must be synchronous. */
  transaction<T>(id: string, fn: () => T): T {
    return this.storage.transaction(id, fn);
  }

  // ---- CSV ----------------------------------------------------------------

  /**
   * Append the rows of a CSV whose first line names the columns. Headers match
   * columns case-insensitively; `id`, `createdAt` and `updatedAt` are skipped;
   * other unknown headers become new columns (type inferred from the values)
   * unless `createColumns` is false. Empty fields are empty cells.
   */
  importCsv(id: string, text: string, options: { createColumns?: boolean } = {}): CsvImportResult {
    const table = this.getTable(id);
    const [header, ...body] = parseCsv(text);
    const result: CsvImportResult = { inserted: 0, columnsAdded: [], skipped: [] };
    if (!header) return result;
    const known = new Map(table.columns.map((c) => [c.name.toLowerCase(), c.name]));
    const mapping: Array<string | undefined> = header.map((raw, index) => {
      const name = raw.trim();
      if (!name) return undefined;
      if (SYSTEM_LOWER.has(name.toLowerCase())) {
        result.skipped.push(name);
        return undefined;
      }
      const existing = known.get(name.toLowerCase());
      if (existing) return existing;
      if (options.createColumns === false) {
        result.skipped.push(name);
        return undefined;
      }
      let columnName = columnNameFrom(name);
      for (let n = 2; known.has(columnName.toLowerCase()) || SYSTEM_LOWER.has(columnName.toLowerCase()); n++) columnName = `${columnNameFrom(name).slice(0, 59)}_${n}`;
      known.set(columnName.toLowerCase(), columnName);
      result.columnsAdded.push({ name: columnName, type: inferType(body.map((fields) => fields[index] ?? '')) });
      return columnName;
    });
    if (table.columns.length + result.columnsAdded.length > MAX_COLUMNS) throw new DataTableError(`At most ${MAX_COLUMNS} columns`);
    this.checkRoom(id, table, body.length);

    return this.storage.transaction(id, () => {
      const target = result.columnsAdded.length ? { ...table, columns: [...table.columns, ...result.columnsAdded], updatedAt: now() } : table;
      if (target !== table) this.storage.saveTable(target);
      const values = body.map((fields, line) => {
        const input: Record<string, unknown> = {};
        mapping.forEach((column, index) => {
          if (column) input[column] = fields[index] === undefined || fields[index] === '' ? null : fields[index];
        });
        try {
          return this.prepareValues(target, input, { fill: true });
        } catch (caught) {
          throw new DataTableError(`Line ${line + 2}: ${(caught as Error).message}`);
        }
      });
      result.inserted = values.length ? this.storage.insertRows(id, values).length : 0;
      return result;
    });
  }

  /** Every row as CSV: id, the columns, createdAt, updatedAt. */
  exportCsv(id: string): string {
    const table = this.getTable(id);
    const names = ['id', ...table.columns.map((c) => c.name), 'createdAt', 'updatedAt'];
    const { rows } = this.storage.queryRows(id, { sortBy: 'id' });
    return toCsv([names, ...rows.map((row) => names.map((name) => row[name] ?? null))]);
  }

  // ---- validation ---------------------------------------------------------

  private column(table: DataTable, name: string): DataTableColumn {
    const column = table.columns.find((c) => c.name === name);
    if (!column) throw new DataTableError(`Unknown column "${name}"`, 404);
    return column;
  }

  private checkTableName(raw: string, tables: DataTable[], exceptId?: string): string {
    const name = String(raw ?? '').trim();
    if (!name) throw new DataTableError('Enter a name for the table');
    if (name.length > MAX_NAME) throw new DataTableError(`Table names are at most ${MAX_NAME} characters`);
    if (tables.some((t) => t.id !== exceptId && t.name.toLowerCase() === name.toLowerCase())) throw new DataTableError(`A data table named “${name}” already exists in this project`, 409);
    return name;
  }

  private checkColumnName(columns: DataTableColumn[], name: string) {
    if (!COLUMN_NAME.test(name)) throw new DataTableError(`“${name}” is not a valid column name: start with a letter, then letters, digits or "_" (up to 63)`);
    if (SYSTEM_LOWER.has(name.toLowerCase())) throw new DataTableError(`“${name}” is a system column`);
    if (columns.some((c) => c.name.toLowerCase() === name.toLowerCase())) throw new DataTableError(`There is already a column named “${name}”`, 409);
  }

  private checkColumn(columns: DataTableColumn[], input: { name: string; type: string }): DataTableColumn {
    const name = String(input?.name ?? '').trim();
    this.checkColumnName(columns, name);
    if (!COLUMN_TYPES.includes(input.type as ColumnType)) throw new DataTableError(`Column types are ${COLUMN_TYPES.join(', ')}`);
    return { name, type: input.type as ColumnType };
  }

  private checkRoom(id: string, table: DataTable, adding: number) {
    if (this.storage.countRows(id) + adding > this.maxRows) {
      throw new DataTableError(`“${table.name}” holds at most ${this.maxRows.toLocaleString('en-US')} rows`, 413);
    }
  }

  /** Values of user columns coerced to their types; system fields are ignored. `fill` sets missing columns to null. */
  private prepareValues(table: DataTable, input: Record<string, unknown>, options: ValueOptions & { fill?: boolean }): RowValues {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DataTableError('A row is an object of column values');
    const out: RowValues = {};
    for (const [key, value] of Object.entries(input)) {
      if (SYSTEM.has(key)) continue;
      const column = table.columns.find((c) => c.name === key);
      if (!column) {
        if (options.ignoreUnknown) continue;
        throw new DataTableError(`Unknown column "${key}"`);
      }
      try {
        out[key] = coerceCell(value, column.type);
      } catch (caught) {
        if (caught instanceof CoercionError) throw new DataTableError(`Column "${key}" ${caught.message}`);
        throw caught;
      }
    }
    return options.fill ? this.fill(table, out) : out;
  }

  private fill(table: DataTable, values: RowValues): RowValues {
    return Object.fromEntries(table.columns.map((c) => [c.name, values[c.name] ?? null]));
  }

  /** Check columns and operators and coerce condition values; undefined stays undefined. */
  private prepareFilter(table: DataTable, filter: RowFilter | undefined): RowFilter | undefined {
    if (!filter) return undefined;
    const conditions = (filter.conditions ?? []).map((condition) => {
      const type = typeOf(table.columns, condition.column);
      if (!type) throw new DataTableError(`Unknown column "${condition.column}"`);
      const operator = OPERATORS.get(condition.operator);
      if (!operator) throw new DataTableError(`Unknown condition "${condition.operator}"`);
      if (operator.unary) return { column: condition.column, operator: condition.operator };
      if (condition.operator === 'contains') return { column: condition.column, operator: condition.operator, value: condition.value == null ? '' : String(condition.value) };
      try {
        return { column: condition.column, operator: condition.operator, value: coerceCell(condition.value === '' ? null : condition.value, type) };
      } catch (caught) {
        if (caught instanceof CoercionError) throw new DataTableError(`Condition on "${condition.column}" ${caught.message}`);
        throw caught;
      }
    });
    const ids = filter.ids?.map(Number);
    if (ids?.some((n) => !Number.isInteger(n))) throw new DataTableError('Row ids are integers');
    return { type: filter.type === 'or' ? 'or' : 'and', conditions, ...(ids && { ids }) };
  }
}

let instance: DataTablesService | undefined;

/** The instance's data tables (in the database). Rows are cached process-wide. */
export function dataTables(): DataTablesService {
  instance ??= new DataTablesService(new SqlDataTableStorage(undefined, singleton('data-tables-sql-cache', () => new Map())));
  return instance;
}
