/**
 * How documents map to table rows: one place for the stores and the JSON import. JSON documents go
 * in TEXT columns; the other columns are what lists, filters and indexes need.
 */
import type { Workflow } from '@landflow/engine';
import type { DataTable, DataTableRow } from '../../shared/data-tables';
import type { ExecutionRecord, ExecutionSummary, Folder, WorkflowVersion } from '../../shared/types';
import type { Row } from './database';

/** Items kept per output in a saved execution (the live run keeps them all). */
export const MAX_ITEMS_PER_OUTPUT = 200;

export function parse<T>(text: string | null | undefined): T | undefined {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

export function workflowRow(workflow: Workflow): Row {
  return {
    id: workflow.id,
    name: workflow.name ?? '',
    active: Boolean(workflow.active),
    folder_id: workflow.folderId,
    created_at: workflow.createdAt,
    updated_at: workflow.updatedAt,
    data: JSON.stringify(workflow),
  };
}

/** The record with at most MAX_ITEMS_PER_OUTPUT items per input and output branch. */
export function trimRunData(record: ExecutionRecord): ExecutionRecord {
  return {
    ...record,
    runData: Object.fromEntries(
      Object.entries(record.runData ?? {}).map(([nodeId, runs]) => [
        nodeId,
        runs.map((run) => ({
          ...run,
          inputs: (run.inputs ?? []).map((branch) => branch.slice(0, MAX_ITEMS_PER_OUTPUT)),
          outputs: (run.outputs ?? []).map((branch) => branch.slice(0, MAX_ITEMS_PER_OUTPUT)),
        })),
      ]),
    ),
  };
}

export function summarize(record: ExecutionRecord): ExecutionSummary {
  return {
    id: record.executionId,
    workflowId: record.workflowId,
    workflowName: record.workflowName,
    mode: record.mode,
    status: record.status,
    startedAt: record.startedAt,
    durationMs: record.durationMs,
    nodesRun: (record.executionOrder ?? []).filter((id) => !record.runData?.[id]?.at(-1)?.reused).length,
    ...(record.error && { error: record.error }),
    ...(record.rerunOf && { rerunOf: record.rerunOf }),
    ...(record.debug && { debug: true }),
    ...(record.status === 'waiting' && record.wait && { wait: { nodeName: record.wait.nodeName, resume: record.wait.resume, ...(record.wait.until && { until: record.wait.until }) } }),
    ...(record.parentExecutionId && { parentExecutionId: record.parentExecutionId }),
    ...(record.versionId && { versionId: record.versionId }),
    ...(record.versionNumber !== undefined && { versionNumber: record.versionNumber, versionPublished: record.versionPublished === true }),
    ...(record.retryOf && { retryOf: record.retryOf, retryAttempt: record.retryAttempt ?? 1 }),
    ...(record.retriedBy && { retriedBy: record.retriedBy }),
    ...(record.retryAt && { retryAt: record.retryAt }),
    ...(record.resumedAfterRestart && { resumedAfterRestart: true }),
    ...(record.evaluation && { evaluation: { runId: record.evaluation.runId } }),
    ...(record.mcp && { mcp: { tool: record.mcp.tool, caller: record.mcp.caller } }),
  };
}

/** A saved execution: summary columns, the summary and the (already trimmed) record. */
export function executionRow(record: ExecutionRecord): Row {
  return {
    id: record.executionId,
    workflow_id: record.workflowId ?? '',
    status: record.status,
    mode: record.mode ?? 'manual',
    started_at: record.startedAt ?? new Date(0).toISOString(),
    finished_at: record.finishedAt || null,
    duration_ms: Math.max(0, Math.round(Number(record.durationMs) || 0)),
    version_id: record.versionId,
    parent_id: record.parentExecutionId,
    retry_of: record.retryOf,
    wait_until: record.status === 'waiting' ? record.wait?.until : undefined,
    evaluation_run_id: record.evaluation?.runId,
    summary: JSON.stringify(summarize(record)),
    data: JSON.stringify(record),
  };
}

export function versionRow(version: WorkflowVersion): Row {
  const { workflow, ...summary } = version;
  return {
    id: version.id,
    workflow_id: version.workflowId,
    number: version.number,
    hash: version.hash ?? '',
    created_at: version.createdAt ?? new Date().toISOString(),
    summary: JSON.stringify(summary),
    workflow: JSON.stringify(workflow),
  };
}

export function folderRow(folder: Folder): Row {
  return { id: folder.id, name: folder.name, parent_id: folder.parentId, project_id: folder.projectId ?? null, created_at: folder.createdAt, updated_at: folder.updatedAt };
}

export interface StoredVariable {
  key: string;
  value: string;
  createdAt: string;
  updatedAt: string;
}

export function variableRow(variable: StoredVariable): Row {
  return { key: variable.key, value: variable.value, created_at: variable.createdAt, updated_at: variable.updatedAt };
}

export function dataTableRow(table: DataTable, nextRowId: number): Row {
  return { id: table.id, name: table.name, next_row_id: nextRowId, data: JSON.stringify(table) };
}

export function tableRowRow(tableId: string, row: DataTableRow): Row {
  return { table_id: tableId, id: row.id, data: JSON.stringify(row) };
}

export function pollRow(key: string, record: unknown): Row {
  return { key, data: JSON.stringify(record) };
}

/** The settings key of the instance settings document. */
export const INSTANCE_SETTINGS = 'instance';
