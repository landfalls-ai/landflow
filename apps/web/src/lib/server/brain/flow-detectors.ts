/**
 * Flow detectors (docs/second-brain.md#flow-detectors): a published workflow that starts from a Detector Trigger
 * (core.detectorTrigger, nodes/usage.ts) is a detector like the built-in ones, with the id `flow:<workflowId>`. The brain
 * runs it on its tick and on Run now, handing the trigger the detector's `quiet` multiplier, and the flow's Suggest
 * Improvement nodes post as that detector (source `detector`). So what people decide about its suggestions quiets it,
 * suggestions it stops confirming expire after 14 days, applied ones are measured, and Insights lists it, all as for the
 * built-in detectors.
 */
import type { Workflow, WorkflowNode } from '@landflow/engine';
import type { ExecutionRecord } from '../../shared/types';
import { flowDetectorId, quietBar, type FlowDetectorId } from '../../shared/brain';
import { database, type Database } from '../db';
import { workflowForCall } from '../publish';
import { store } from '../store';
import { logger } from '../telemetry/logger';

export const DETECTOR_TRIGGER = 'core.detectorTrigger';
const SUGGEST = 'core.suggestImprovement';
/** How long one detector flow may run before the brain stops it. */
export const FLOW_TIMEOUT_MS = 10 * 60_000;

export const detectorTriggerOf = (workflow: Workflow | undefined): WorkflowNode | undefined => workflow?.nodes.find((n) => n.type === DETECTOR_TRIGGER && !n.disabled);

/** Whether this workflow is a detector: it has an enabled Detector Trigger. */
export const isDetectorFlow = (workflow: Workflow | undefined) => Boolean(detectorTriggerOf(workflow));

export interface FlowDetector {
  id: FlowDetectorId;
  workflowId: string;
  name: string;
  /** Published: only these run. */
  active: boolean;
}

/** Every workflow with a Detector Trigger, published or not (Insights lists them all). */
export function listFlowDetectors(): FlowDetector[] {
  return store
    .listWorkflows()
    .filter((saved) => isDetectorFlow(saved) || (saved.active && isDetectorFlow(workflowForCall(saved.id, 'trigger'))))
    .map((saved) => ({ id: flowDetectorId(saved.id), workflowId: saved.id, name: saved.name, active: Boolean(saved.active) }));
}

/** The published version of each detector flow, with its trigger. */
function armed(only?: FlowDetectorId[]): Array<{ id: FlowDetectorId; workflow: Workflow; node: WorkflowNode }> {
  const out: Array<{ id: FlowDetectorId; workflow: Workflow; node: WorkflowNode }> = [];
  for (const saved of store.listWorkflows()) {
    if (!saved.active) continue;
    const id = flowDetectorId(saved.id);
    if (only && !only.includes(id)) continue;
    const workflow = workflowForCall(saved.id, 'trigger') ?? saved;
    const node = detectorTriggerOf(workflow);
    if (node) out.push({ id, workflow, node });
  }
  return out;
}

export interface FlowDetectorRun {
  id: FlowDetectorId;
  executionId?: string;
  status?: string;
  /** Findings the flow posted (Suggest Improvement items). */
  found: number;
  /** Of those, the ones kept (new or refreshed). */
  saved: number;
  error?: string;
}

const lastRunKey = (id: FlowDetectorId) => `brain.flow.${id}.lastRun`;

/** What a Suggest Improvement node of this run posted: how many, and how many were kept. */
function postedBy(record: ExecutionRecord, workflow: Workflow): { found: number; saved: number } {
  const suggest = new Set(workflow.nodes.filter((n) => n.type === SUGGEST).flatMap((n) => [n.id, n.name]));
  let found = 0;
  let saved = 0;
  for (const [key, runs] of Object.entries(record.runData ?? {})) {
    if (!suggest.has(key)) continue;
    for (const run of runs) {
      for (const item of run.outputs?.[0] ?? []) {
        found++;
        if ((item.json as { saved?: unknown }).saved === true) saved++;
      }
    }
  }
  return { found, saved };
}

/**
 * Run the published detector flows (or `only` these), one after another. Each run starts at its Detector Trigger with
 * one item: `{ detector, name, quiet, minConfidence, at, lastRunAt }`.
 */
export async function runFlowDetectors(
  options: { only?: FlowDetectorId[]; quiet: (id: FlowDetectorId) => number; db?: Database; now?: number; signal?: AbortSignal; reason?: 'tick' | 'run-now' },
): Promise<FlowDetectorRun[]> {
  const db = options.db ?? database();
  const { runWorkflow } = await import('../runner');
  const { fireTrigger } = await import('../telemetry/triggers');
  const results: FlowDetectorRun[] = [];
  for (const { id, workflow, node } of armed(options.only)) {
    if (options.signal?.aborted) break;
    const quiet = options.quiet(id);
    const at = new Date(options.now ?? Date.now()).toISOString();
    const lastRunAt = db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', lastRunKey(id))?.value;
    const item = { detector: id, name: workflow.name, quiet, minConfidence: quietBar(quiet), at, ...(lastRunAt && { lastRunAt }), reason: options.reason ?? 'tick' };
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(FLOW_TIMEOUT_MS)]) : AbortSignal.timeout(FLOW_TIMEOUT_MS);
    try {
      const record = await fireTrigger({ source: 'detector', workflowId: workflow.id, nodeName: node.name }, () =>
        runWorkflow({ workflow, mode: 'trigger', startNodeId: node.id, triggerItems: [{ json: item }], signal }),
      );
      db.upsert('meta', { key: lastRunKey(id), value: at });
      const posted = postedBy(record, workflow);
      const error = record.status === 'error' ? (record.error?.message ?? 'The run failed') : undefined;
      if (error) logger.warn('a flow detector’s run failed', { 'landflow.brain.detector': id, 'landflow.execution.id': record.executionId, error });
      results.push({ id, executionId: record.executionId, status: record.status, ...posted, ...(error && { error }) });
    } catch (error) {
      logger.warn('a flow detector could not run', { error, 'landflow.brain.detector': id });
      results.push({ id, found: 0, saved: 0, error: (error as Error).message ?? String(error) });
    }
  }
  return results;
}

export interface FlowBacktestPoint {
  /** The findings the flow would have posted at this point (Suggest Improvement items, nothing written). */
  findings: Array<{ fingerprint: string; title: string; confidence: number }>;
  /** Suggest Improvement items that stayed under the bar for the quiet being tested. */
  held: number;
  error?: string;
}

/**
 * Run a published detector flow as of `at` for a backtest (./backtest.ts): the Detector Trigger item carries
 * `asOf` (= `at`) and `backtest: true` next to the usual fields, the run is marked a backtest for the nodes in it
 * (backtest-scope.ts: Suggest Improvement posts nothing, Landflow Usage reads the ledger up to `at`), and the execution is
 * deleted afterwards. Throws when the flow is not an armed detector.
 */
export async function backtestFlowAt(id: FlowDetectorId, options: { at: number; quiet: number; lastAt?: number; signal?: AbortSignal }): Promise<FlowBacktestPoint> {
  const found = armed([id])[0];
  if (!found) throw new Error(`No published detector flow ${id}`);
  const { runWorkflow } = await import('../runner');
  const { inBacktest } = await import('./backtest-scope');
  const at = new Date(options.at).toISOString();
  const item = {
    detector: id,
    name: found.workflow.name,
    quiet: options.quiet,
    minConfidence: quietBar(options.quiet),
    at,
    asOf: at,
    backtest: true,
    ...(options.lastAt !== undefined && { lastRunAt: new Date(options.lastAt).toISOString() }),
    reason: 'backtest',
  };
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(FLOW_TIMEOUT_MS)]) : AbortSignal.timeout(FLOW_TIMEOUT_MS);
  const record = await inBacktest({ asOf: options.at, quiet: options.quiet }, () =>
    runWorkflow({ workflow: found.workflow, mode: 'trigger', startNodeId: found.node.id, triggerItems: [{ json: item }], signal, bypassConcurrency: true }),
  );
  store.deleteExecution(record.executionId);
  const suggest = new Set(found.workflow.nodes.filter((n) => n.type === SUGGEST).flatMap((n) => [n.id, n.name]));
  const out: FlowBacktestPoint = { findings: [], held: 0 };
  for (const [key, runs] of Object.entries(record.runData ?? {})) {
    if (!suggest.has(key)) continue;
    for (const run of runs) {
      for (const result of run.outputs?.[0] ?? []) {
        const json = result.json as { fingerprint?: unknown; title?: unknown; confidence?: unknown };
        if (typeof json.fingerprint === 'string') out.findings.push({ fingerprint: json.fingerprint, title: String(json.title ?? ''), confidence: Number(json.confidence ?? 0) });
        else out.held++;
      }
    }
  }
  if (record.status === 'error') out.error = record.error?.message ?? 'The run failed';
  else if (record.status !== 'success') out.error = `The run ended ${record.status}`;
  return out;
}
