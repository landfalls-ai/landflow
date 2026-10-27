/**
 * Offline evaluation runs: read the Evaluation Trigger's Data Table (or the uploaded file), start one execution per row (one after
 * the other, mode `manual`, marked with the case so the Evaluation node records into it and Insights leave it
 * out), then sum up the per-case metrics into the run's averages. Runs go on in the background; the API polls.
 */
import { nanoid } from 'nanoid';
import type { Workflow } from '@landflow/engine';
import type {
  CaseComparison,
  EvaluationCase,
  EvaluationComparison,
  EvaluationFile,
  EvaluationRunDetail,
  EvaluationRunSummary,
  EvaluationsOverview,
  MetricDelta,
  MetricSummary,
} from '../../shared/evaluations';
import type { ExecutionRecord } from '../../shared/types';
import { dataTables } from '../datatables';
import { workflowProject } from '../datatables/projects';
import { singleton } from '../singleton';
import { store } from '../store';
import { logger } from '../telemetry';
import { datasetSourceOf, EVALUATION_NODE, expectedColumnIn, evaluationTriggerOf, loadDataset, loadFileDataset, rowItem, splitRow, type Dataset, type DatasetRow } from './dataset';
import { alertOnEvaluation } from './alerts';
import * as db from './store';

/** Rows one run may evaluate. */
export const MAX_CASES = 1_000;

export class EvaluationError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

interface ActiveRun {
  controller: AbortController;
  done: Promise<EvaluationRunSummary>;
}

const active = singleton('evaluation-runs', () => new Map<string, ActiveRun>());

export const newRunId = () => `ev_${nanoid(12)}`;

export interface StartOptions {
  /** The graph to run (the editor's unsaved one); default: the saved workflow. */
  workflow?: Workflow;
  /** Evaluate at most this many rows (overrides the trigger's limit). */
  maxRows?: number;
  /** The cases, already read (a file dataset is read asynchronously: `startEvaluationRun`). */
  dataset?: Dataset;
  /** What starts it; default a person. */
  trigger?: 'manual' | 'schedule';
}

/**
 * Start an evaluation run of a workflow, reading the file dataset first when the trigger's source is File. The routes and the
 * schedule use this; `startEvaluation` is the same for Data Tables, synchronously.
 */
export async function startEvaluationRun(workflowId: string, options: StartOptions = {}): Promise<EvaluationRunSummary> {
  const workflow = options.workflow ?? store.getWorkflow(workflowId);
  const trigger = workflow && evaluationTriggerOf(workflow);
  if (workflow && trigger && !options.dataset && datasetSourceOf(trigger.parameters) === 'file') {
    let dataset: Dataset;
    try {
      dataset = await loadFileDataset(workflowId, trigger.parameters, { ...(options.maxRows && { maxRows: options.maxRows }) });
    } catch (error) {
      throw new EvaluationError((error as Error).message);
    }
    return startEvaluation(workflowId, { ...options, workflow, dataset });
  }
  return startEvaluation(workflowId, options);
}

/** Start an evaluation run of a workflow; it goes on in the background. Throws EvaluationError when it can't start. */
export function startEvaluation(workflowId: string, options: StartOptions = {}): EvaluationRunSummary {
  const workflow = options.workflow ?? store.getWorkflow(workflowId);
  if (!workflow) throw new EvaluationError('Workflow not found', 404);
  const trigger = evaluationTriggerOf(workflow);
  if (!trigger) throw new EvaluationError('Add an Evaluation Trigger to the workflow first: it names the Data Table with the test cases.');
  if (runningRun(workflowId)) throw new EvaluationError('An evaluation of this workflow is already running', 409);

  let dataset: Dataset;
  try {
    dataset = options.dataset ?? loadDataset(trigger.parameters, { workflowId, ...(options.maxRows && { maxRows: options.maxRows }) });
  } catch (error) {
    throw new EvaluationError((error as Error).message);
  }
  if (!dataset.rows.length) throw new EvaluationError(dataset.source === 'file' ? `The file “${dataset.name}” has no rows: add one row per test case.` : `Data table “${dataset.name}” has no rows: add one row per test case.`);
  const rows = dataset.rows.slice(0, MAX_CASES);

  const run: EvaluationRunSummary = {
    id: newRunId(),
    workflowId,
    workflowName: workflow.name,
    number: db.nextRunNumber(workflowId),
    status: 'running',
    startedAt: new Date().toISOString(),
    ...(dataset.source === 'file' && { source: 'file' as const }),
    dataTableId: dataset.id,
    dataTableName: dataset.name,
    ...(options.trigger === 'schedule' && { trigger: 'schedule' as const }),
    total: rows.length,
    completed: 0,
    failed: 0,
    metrics: {},
  };
  db.saveRun(run);
  rows.forEach((row, index) => db.saveCase({ runId: run.id, index, rowId: row.id, status: 'pending', ...splitRow(row, dataset.expectedColumn), outputs: {}, metrics: {} }));

  const controller = new AbortController();
  const beat = setInterval(() => db.touchRun(run.id), HEARTBEAT_MS);
  beat.unref?.();
  const done = runCases(run, workflow, trigger.id, rows, controller.signal)
    .catch((error: Error) => {
      logger.error('evaluation run failed', { 'landflow.workflow.id': workflowId, 'landflow.evaluation.run_id': run.id, error: error.message });
      return finish(run.id, 'error', error.message);
    })
    .finally(() => {
      clearInterval(beat);
      active.delete(run.id);
    });
  active.set(run.id, { controller, done });
  return run;
}

async function runCases(run: EvaluationRunSummary, workflow: Workflow, triggerId: string, rows: DatasetRow[], signal: AbortSignal) {
  const { runWorkflow } = await import('../runner');
  for (const [index, row] of rows.entries()) {
    if (signal.aborted) break;
    const startedAt = new Date().toISOString();
    db.updateCase(run.id, index, (current) => ({ ...current, status: 'running', startedAt }));
    let record: ExecutionRecord | undefined;
    let failure: string | undefined;
    try {
      record = await runWorkflow({
        workflow,
        mode: 'manual',
        startNodeId: triggerId,
        triggerItems: [rowItem(row)],
        evaluation: { runId: run.id, caseIndex: index, rowId: row.id },
        bypassConcurrency: true,
        signal,
        onStart: (executionId) => db.updateCase(run.id, index, (current) => ({ ...current, executionId })),
      });
    } catch (error) {
      failure = (error as Error).message;
    }
    const finishedAt = new Date().toISOString();
    const status = record ? caseStatus(record) : 'error';
    db.updateCase(run.id, index, (current) => ({
      ...current,
      status,
      ...(record && { executionId: record.executionId }),
      ...((failure || status === 'error') && { error: failure ?? record?.error?.message ?? (record?.status === 'waiting' ? 'The execution is waiting: evaluation runs can’t wait' : 'The execution failed') }),
      finishedAt,
      durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
    }));
    if (record?.versionId && !run.versionId) run.versionId = record.versionId;
    refresh(run.id, { ...(run.versionId && { versionId: run.versionId }) });
  }
  return finish(run.id, signal.aborted ? 'canceled' : 'success');
}

const caseStatus = (record: ExecutionRecord): EvaluationCase['status'] => (record.status === 'success' ? 'success' : record.status === 'canceled' ? 'canceled' : 'error');

/** Per metric over the cases that recorded it: mean, count, min and max. */
export function summarizeMetrics(cases: EvaluationCase[]): Record<string, MetricSummary> {
  const values: Record<string, number[]> = {};
  for (const testCase of cases) for (const [name, value] of Object.entries(testCase.metrics ?? {})) if (Number.isFinite(value)) (values[name] ??= []).push(value);
  return Object.fromEntries(
    Object.entries(values).map(([name, list]) => [name, { average: list.reduce((sum, v) => sum + v, 0) / list.length, count: list.length, min: Math.min(...list), max: Math.max(...list) }]),
  );
}

/** Recount a run from its cases and save it. */
function refresh(runId: string, patch: Partial<EvaluationRunSummary> = {}): EvaluationRunSummary | undefined {
  const run = db.getRun(runId);
  if (!run) return undefined;
  const cases = db.listCases(runId);
  const next: EvaluationRunSummary = {
    ...run,
    ...patch,
    completed: cases.filter((c) => c.status === 'success' || c.status === 'error').length,
    failed: cases.filter((c) => c.status === 'error').length,
    metrics: summarizeMetrics(cases),
  };
  db.saveRun(next);
  return next;
}

function finish(runId: string, status: EvaluationRunSummary['status'], error?: string): EvaluationRunSummary {
  // Cases that never ran (canceled or failed run) are marked canceled.
  for (const testCase of db.listCases(runId)) {
    if (testCase.status === 'pending' || testCase.status === 'running') db.updateCase(runId, testCase.index, (current) => ({ ...current, status: 'canceled' }));
  }
  const run = db.getRun(runId);
  const finishedAt = new Date().toISOString();
  const next = refresh(runId, {
    status,
    finishedAt,
    ...(run && { durationMs: Date.parse(finishedAt) - Date.parse(run.startedAt) }),
    ...(error && { error }),
  });
  if (run) db.pruneRuns(run.workflowId);
  // Alerts on a falling score (rules of kind "evaluation"); never fails the run.
  if (next && status === 'success') void alertOnEvaluation(next).catch((error: Error) => logger.warn('evaluation alerts skipped', { 'landflow.evaluation.run_id': runId, error: error.message }));
  return next ?? ({ ...run, status } as EvaluationRunSummary);
}

/** A run that is still going (this process). */
function runningRun(workflowId: string): EvaluationRunSummary | undefined {
  return db.listRuns(workflowId, 20).find((run) => run.status === 'running' && active.has(run.id));
}

/** A running evaluation saves a heartbeat this often; one silent for three times as long belongs to a process that stopped. */
export const HEARTBEAT_MS = 10_000;
export const STALE_MS = HEARTBEAT_MS * 3;

/**
 * Runs left `running` by a restart can't go on: they end as errors. `active` only knows this process's runs, and with several
 * mains the others' runs are `running` too, so only a run whose heartbeat stopped counts (a restart is noticed after STALE_MS).
 */
export function settleInterrupted(now = Date.now()): number {
  let settled = 0;
  for (const run of db.staleRunning(STALE_MS, now)) {
    if (active.has(run.id)) continue;
    finish(run.id, 'error', 'The host restarted during the run');
    settled++;
  }
  return settled;
}

/** Resolves when a run is over (immediately if it isn't running here). */
export async function evaluationDone(runId: string): Promise<EvaluationRunSummary | undefined> {
  const entry = active.get(runId);
  return entry ? entry.done : db.getRun(runId);
}

export function cancelEvaluation(runId: string): boolean {
  const entry = active.get(runId);
  if (!entry) return false;
  entry.controller.abort();
  return true;
}

export function deleteEvaluation(runId: string): boolean {
  cancelEvaluation(runId);
  return db.deleteRun(runId);
}

export function evaluationDetail(runId: string): EvaluationRunDetail | undefined {
  const run = db.getRun(runId);
  return run && { ...run, cases: db.listCases(runId) };
}

/** The Evaluations tab: the runs, the trigger's table and whether metrics are set. */
export function evaluationsOverview(workflow: Workflow): EvaluationsOverview {
  settleInterrupted();
  const node = evaluationTriggerOf(workflow);
  let trigger: EvaluationsOverview['trigger'];
  if (node) {
    const source = datasetSourceOf(node.parameters);
    const ref = String(node.parameters.dataTableId ?? '').trim();
    const table = source === 'dataTable' && ref ? dataTables().findTable(ref, workflowProject(workflow.id)) : undefined;
    const maxRows = node.parameters.limitRows ? Number(node.parameters.maxRows) || undefined : undefined;
    let dataset: Dataset | undefined;
    try {
      dataset = table ? loadDataset(node.parameters, { maxRows: 1, workflowId: workflow.id }) : undefined;
    } catch {
      dataset = undefined;
    }
    const uploaded = db.getSettings(workflow.id).file;
    trigger = {
      nodeId: node.id,
      nodeName: node.name,
      source,
      ...(source === 'dataTable' && ref && { dataTableId: table?.id ?? ref }),
      ...(table && { dataTableName: table.name }),
      ...(dataset && { rows: dataset.total }),
      ...(dataset?.expectedColumn && { expectedColumn: dataset.expectedColumn }),
      ...(source === 'file' && uploaded && { rows: uploaded.rows, dataTableName: uploaded.fileName, expectedColumn: expectedColumnIn(uploaded.columns, node.parameters.fileExpectedColumn) }),
      ...(maxRows && { maxRows }),
    };
  }
  const hasMetrics = workflow.nodes.some((n) => n.type === EVALUATION_NODE && !n.disabled && n.parameters.operation === 'setMetrics');
  const { binaryId: _binaryId, ...file } = db.getSettings(workflow.id).file ?? ({} as { binaryId?: string });
  const schedule = db.getSettings(workflow.id).schedule;
  return { runs: db.listRuns(workflow.id), ...(trigger && { trigger }), ...(Object.keys(file).length && { file: file as EvaluationFile }), ...(schedule && { schedule }), hasMetrics };
}

// ---------------------------------------------------------------------------
// Comparing two runs
// ---------------------------------------------------------------------------

const EPSILON = 1e-9;
const pick = (c: EvaluationCase | undefined) => c && { status: c.status, metrics: c.metrics, outputs: c.outputs, ...(c.executionId && { executionId: c.executionId }), ...(c.error && { error: c.error }) };

/** Compare run `a` (the baseline) with run `b`: metric averages and, per case (matched by row, else position), b − a. */
export function compareRuns(aId: string, bId: string): EvaluationComparison | undefined {
  const a = db.getRun(aId);
  const b = db.getRun(bId);
  if (!a || !b) return undefined;
  const names = [...new Set([...Object.keys(a.metrics), ...Object.keys(b.metrics)])].sort();
  const metrics: MetricDelta[] = names.map((name) => {
    const [av, bv] = [a.metrics[name]?.average, b.metrics[name]?.average];
    return { name, ...(av !== undefined && { a: av }), ...(bv !== undefined && { b: bv }), ...(av !== undefined && bv !== undefined && { delta: bv - av }) };
  });

  const casesA = db.listCases(aId);
  const casesB = db.listCases(bId);
  const keyOf = (c: EvaluationCase) => (c.rowId !== undefined ? `row:${c.rowId}` : `idx:${c.index}`);
  const byKeyB = new Map(casesB.map((c) => [keyOf(c), c]));
  const seen = new Set<string>();
  const cases: CaseComparison[] = [];
  let improved = 0;
  let regressed = 0;
  let unchanged = 0;
  for (const ca of casesA) {
    const key = keyOf(ca);
    seen.add(key);
    cases.push(compareCase(ca, byKeyB.get(key)));
  }
  for (const cb of casesB) if (!seen.has(keyOf(cb))) cases.push(compareCase(undefined, cb));
  for (const entry of cases) {
    if (!entry.a || !entry.b) continue;
    const deltas = Object.values(entry.deltas);
    const up = deltas.filter((d) => d > EPSILON).length;
    const down = deltas.filter((d) => d < -EPSILON).length;
    if (up > down) improved++;
    else if (down > up) regressed++;
    else unchanged++;
  }
  return { a, b, metrics, cases, improved, regressed, unchanged };
}

function compareCase(a: EvaluationCase | undefined, b: EvaluationCase | undefined): CaseComparison {
  const base = (a ?? b)!;
  const deltas: Record<string, number> = {};
  if (a && b) for (const [name, value] of Object.entries(b.metrics)) if (a.metrics[name] !== undefined) deltas[name] = value - a.metrics[name];
  return {
    index: base.index,
    ...(base.rowId !== undefined && { rowId: base.rowId }),
    inputs: base.inputs,
    ...(base.expected !== undefined && { expected: base.expected }),
    ...(a && { a: pick(a) }),
    ...(b && { b: pick(b) }),
    deltas,
  };
}
