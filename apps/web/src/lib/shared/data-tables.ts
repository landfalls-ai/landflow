/**
 * Data Tables: built-in tables shared by the API routes, the Data Tables page
 * and the Data Table node. Types plus a few constants; no server imports.
 */

export type ColumnType = 'string' | 'number' | 'boolean' | 'date';

export const COLUMN_TYPES: ColumnType[] = ['string', 'number', 'boolean', 'date'];

/** Every row has these; they can be filtered and sorted on but not written. */
export const SYSTEM_COLUMNS = ['id', 'createdAt', 'updatedAt'] as const;

/** Column names: a letter, then letters, digits and underscores. */
export const COLUMN_NAME = /^[A-Za-z][A-Za-z0-9_]{0,62}$/;

export interface DataTableColumn {
  name: string;
  type: ColumnType;
}

export interface DataTable {
  id: string;
  name: string;
  columns: DataTableColumn[];
  createdAt: string;
  updatedAt: string;
}

export interface DataTableSummary extends DataTable {
  rowCount: number;
}

/** A stored cell: dates are ISO strings, empty cells are null. */
export type CellValue = string | number | boolean | null;

export interface DataTableRow {
  id: number;
  createdAt: string;
  updatedAt: string;
  [column: string]: CellValue;
}

export type ConditionOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'isEmpty' | 'isNotEmpty';

export const CONDITION_OPERATORS: Array<{ value: ConditionOperator; name: string; unary?: boolean }> = [
  { value: 'eq', name: 'Equals' },
  { value: 'neq', name: 'Not Equals' },
  { value: 'gt', name: 'Greater Than' },
  { value: 'gte', name: 'Greater Than or Equal' },
  { value: 'lt', name: 'Less Than' },
  { value: 'lte', name: 'Less Than or Equal' },
  { value: 'contains', name: 'Contains' },
  { value: 'isEmpty', name: 'Is Empty', unary: true },
  { value: 'isNotEmpty', name: 'Is Not Empty', unary: true },
];

export interface RowCondition {
  /** A column name, or `id` / `createdAt` / `updatedAt`. */
  column: string;
  operator: ConditionOperator;
  /** Coerced to the column's type; ignored by isEmpty / isNotEmpty. */
  value?: unknown;
}

/** Which rows an operation applies to. No conditions and no ids = every row. */
export interface RowFilter {
  /** How conditions combine (default `and`). */
  type?: 'and' | 'or';
  conditions?: RowCondition[];
  /** Only these row ids (ANDed with the conditions). */
  ids?: number[];
}

export interface RowQuery {
  filter?: RowFilter;
  /** Case-insensitive substring over every column. */
  search?: string;
  sortBy?: string;
  sortDirection?: 'asc' | 'desc';
  offset?: number;
  /** Default: every row. */
  limit?: number;
}

export interface RowPage {
  rows: DataTableRow[];
  /** Rows matching the filter and search, before offset/limit. */
  total: number;
  offset: number;
  limit: number;
}

export interface CsvImportResult {
  inserted: number;
  /** Columns created from CSV headers the table didn't have. */
  columnsAdded: DataTableColumn[];
  /** Headers that were skipped (system columns, or unknown ones when columns aren't created). */
  skipped: string[];
}
