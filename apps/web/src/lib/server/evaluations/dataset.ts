/**
 * The test cases of an offline evaluation: the rows of the Data Table an Evaluation Trigger names. Each row
 * becomes one item (its columns plus `row_id`); the expected-output column is kept apart for the metrics.
 */
import type { JsonObject, NodeItem } from '@landflow/sdk';
import type { Workflow, WorkflowNode } from '@landflow/engine';
import type { DataTable, DataTableRow } from '../../shared/data-tables';
import { SYSTEM_COLUMNS } from '../../shared/data-tables';
import { dataTables } from '../datatables';

export const EVALUATION_TRIGGER = 'core.evaluationTrigger';
export const EVALUATION_NODE = 'core.evaluation';
/** Tried in order when the trigger names no expected-output column. */
export const EXPECTED_COLUMNS = ['expected', 'expected_output', 'expectedOutput', 'expected_answer', 'expectedAnswer', 'answer'];

export interface Dataset {
  table: DataTable;
  /** The expected-output column, if the table has it. */
  expectedColumn?: string;
  rows: DataTableRow[];
  /** Rows in the table (before the row limit). */
  total: number;
}

/** The workflow's (enabled) Evaluation Trigger. */
export function evaluationTriggerOf(workflow: Pick<Workflow, 'nodes'>): WorkflowNode | undefined {
  return workflow.nodes.find((node) => node.type === EVALUATION_TRIGGER && !node.disabled);
}

/** The expected-output column of a table: the configured one, or the first of EXPECTED_COLUMNS it has. */
export function expectedColumnOf(table: DataTable, configured?: unknown): string | undefined {
  const names = new Set(table.columns.map((column) => column.name));
  const wanted = typeof configured === 'string' ? configured.trim() : '';
  if (wanted) return names.has(wanted) ? wanted : undefined;
  return EXPECTED_COLUMNS.find((name) => names.has(name));
}

/** Read the Data Table of an Evaluation Trigger's parameters (`dataTableId`, `expectedColumn`, `limitRows`, `maxRows`). */
export function loadDataset(parameters: Record<string, unknown>, options: { maxRows?: number } = {}): Dataset {
  const ref = String(parameters.dataTableId ?? '').trim();
  if (!ref) throw new Error('Choose the Data Table with the test cases on the Evaluation Trigger');
  const table = dataTables().findTable(ref);
  if (!table) throw new Error(`Data table “${ref}” not found`);
  const configured = Number(parameters.maxRows);
  const limit = options.maxRows ?? (parameters.limitRows && Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : undefined);
  const page = dataTables().listRows(table.id, { sortBy: 'id', sortDirection: 'asc', ...(limit && { limit }) });
  return { table, expectedColumn: expectedColumnOf(table, parameters.expectedColumn), rows: page.rows, total: page.total };
}

/** A row's own columns (no id or timestamps). */
export function rowColumns(row: DataTableRow): Record<string, unknown> {
  const system: readonly string[] = SYSTEM_COLUMNS;
  return Object.fromEntries(Object.entries(row).filter(([key]) => !system.includes(key)));
}

/** The item the Evaluation Trigger emits for a row: every column plus `row_id`. */
export function rowItem(row: DataTableRow): NodeItem {
  return { json: { ...rowColumns(row), row_id: row.id } as JsonObject };
}

/** A case's inputs (every column but the expected one) and its expected output. */
export function splitRow(row: DataTableRow, expectedColumn?: string): { inputs: Record<string, unknown>; expected?: unknown } {
  const columns = rowColumns(row);
  if (!expectedColumn) return { inputs: columns };
  const { [expectedColumn]: expected, ...inputs } = columns;
  return { inputs, ...(expected !== undefined && expected !== null && { expected }) };
}
