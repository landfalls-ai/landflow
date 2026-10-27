/**
 * The test cases of an offline evaluation: the rows of the Data Table an Evaluation Trigger names (the default), or of
 * the CSV or JSON file uploaded to the workflow's evaluation (`source: 'file'`, ./files.ts). Each row becomes one item
 * (its columns plus `row_id`); the expected-output column is kept apart for the metrics.
 */
import type { JsonObject, NodeItem } from '@landflow/sdk';
import type { Workflow, WorkflowNode } from '@landflow/engine';
import type { EvaluationSource } from '../../shared/evaluations';
import type { DataTable, DataTableRow } from '../../shared/data-tables';
import { SYSTEM_COLUMNS } from '../../shared/data-tables';
import { dataTables } from '../datatables';
import { tableProblem, workflowProject } from '../datatables/projects';
import { readDatasetFile } from './files';

export const EVALUATION_TRIGGER = 'core.evaluationTrigger';
export const EVALUATION_NODE = 'core.evaluation';
/** Tried in order when the trigger names no expected-output column. */
export const EXPECTED_COLUMNS = ['expected', 'expected_output', 'expectedOutput', 'expected_answer', 'expectedAnswer', 'answer'];

/** One test case: the row's id (a Data Table row id, or the line of a file counted from 1) and its own columns. */
export interface DatasetRow {
  id: number;
  values: Record<string, unknown>;
}

export interface Dataset {
  source: EvaluationSource;
  /** The Data Table id, or `file:<file name>`. */
  id: string;
  /** The Data Table's or the file's name. */
  name: string;
  /** The expected-output column, if there is one. */
  expectedColumn?: string;
  rows: DatasetRow[];
  /** Rows in the table or file (before the row limit). */
  total: number;
}

/** The workflow's (enabled) Evaluation Trigger. */
export function evaluationTriggerOf(workflow: Pick<Workflow, 'nodes'>): WorkflowNode | undefined {
  return workflow.nodes.find((node) => node.type === EVALUATION_TRIGGER && !node.disabled);
}

/** Where the trigger reads its cases: the uploaded file, or (default) a Data Table. */
export const datasetSourceOf = (parameters: Record<string, unknown>): EvaluationSource => (parameters.source === 'file' ? 'file' : 'dataTable');

/** The expected-output column among `columns`: the configured one, or the first of EXPECTED_COLUMNS present. */
export function expectedColumnIn(columns: readonly string[], configured?: unknown): string | undefined {
  const names = new Set(columns);
  const wanted = typeof configured === 'string' ? configured.trim() : '';
  if (wanted) return names.has(wanted) ? wanted : undefined;
  return EXPECTED_COLUMNS.find((name) => names.has(name));
}

/** The expected-output column of a table. */
export const expectedColumnOf = (table: DataTable, configured?: unknown): string | undefined =>
  expectedColumnIn(
    table.columns.map((column) => column.name),
    configured,
  );

const rowLimit = (parameters: Record<string, unknown>, maxRows?: number) => {
  const configured = Number(parameters.maxRows);
  return maxRows ?? (parameters.limitRows && Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : undefined);
};

/** A row's own columns (no id or timestamps). */
function rowColumns(row: DataTableRow): Record<string, unknown> {
  const system: readonly string[] = SYSTEM_COLUMNS;
  return Object.fromEntries(Object.entries(row).filter(([key]) => !system.includes(key)));
}

/** Read the Data Table of an Evaluation Trigger's parameters (`dataTableId`, `expectedColumn`, `limitRows`, `maxRows`). */
export function loadDataset(parameters: Record<string, unknown>, options: { maxRows?: number; workflowId?: string } = {}): Dataset {
  if (datasetSourceOf(parameters) === 'file') throw new Error('This Evaluation Trigger reads the uploaded file: use loadFileDataset');
  const ref = String(parameters.dataTableId ?? '').trim();
  if (!ref) throw new Error('Choose the Data Table with the test cases on the Evaluation Trigger');
  // The workflow's project owns its test cases: a table of another project is refused, like the Data Table node does.
  const projectId = options.workflowId ? workflowProject(options.workflowId) : undefined;
  const table = dataTables().findTable(ref, projectId);
  if (!table) throw new Error(`Data table “${ref}” not found`);
  const problem = options.workflowId ? tableProblem(table, projectId) : undefined;
  if (problem) throw new Error(`${problem.message}. ${problem.description}`);
  const limit = rowLimit(parameters, options.maxRows);
  const page = dataTables().listRows(table.id, { sortBy: 'id', sortDirection: 'asc', ...(limit && { limit }) });
  return {
    source: 'dataTable',
    id: table.id,
    name: table.name,
    expectedColumn: expectedColumnOf(table, parameters.expectedColumn),
    rows: page.rows.map((row) => ({ id: row.id, values: rowColumns(row) })),
    total: page.total,
  };
}

/** Read the file uploaded to the workflow's evaluation (`fileExpectedColumn`, `limitRows`, `maxRows`). */
export async function loadFileDataset(workflowId: string, parameters: Record<string, unknown>, options: { maxRows?: number } = {}): Promise<Dataset> {
  const parsed = await readDatasetFile(workflowId);
  if (!parsed) throw new Error('Upload the CSV or JSON file with the test cases on the workflow’s Evaluations tab');
  const limit = rowLimit(parameters, options.maxRows);
  const rows = parsed.rows.map((values, index): DatasetRow => ({ id: index + 1, values }));
  return {
    source: 'file',
    id: `file:${parsed.file.fileName}`,
    name: parsed.file.fileName,
    expectedColumn: expectedColumnIn(parsed.columns, parameters.fileExpectedColumn),
    rows: limit ? rows.slice(0, limit) : rows,
    total: rows.length,
  };
}

/** The item the Evaluation Trigger emits for a row: every column plus `row_id`. */
export function rowItem(row: DatasetRow): NodeItem {
  return { json: { ...row.values, row_id: row.id } as JsonObject };
}

/** A case's inputs (every column but the expected one) and its expected output. */
export function splitRow(row: DatasetRow, expectedColumn?: string): { inputs: Record<string, unknown>; expected?: unknown } {
  if (!expectedColumn) return { inputs: row.values };
  const { [expectedColumn]: expected, ...inputs } = row.values;
  return { inputs, ...(expected !== undefined && expected !== null && { expected }) };
}
