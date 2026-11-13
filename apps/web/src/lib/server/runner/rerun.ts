/**
 * Re-runs and retries: turning "run this execution again (from this node)" or "retry this failure" into run options.
 * (Split out of the former runner.ts; lib/server/runner.ts re-exports the public names.)
 */
import type { NodeItem } from '@landflow/protocol';
import type { NodeRun, Workflow } from '@landflow/engine';
import type { ExecutionRecord, RerunOf, RerunScope } from '../../shared/types';
import { retries } from '../retries';
import { getVersion } from '../versions';
import { store } from '../store';
import { fireTrigger, logger, recordRuntimeEvent } from '../telemetry';
import { type RunOptions, RerunError } from './types';
import { runWorkflow } from './run';

export interface RerunRequest {
  scope: RerunScope;
  nodeId?: string;
  /** `current` (default) runs the saved workflow; `original` the version the execution ran. */
  version?: 'current' | 'original';
}

/** The first main-flow run of an execution: its trigger, and the items it was started with. */
function recordedStart(source: ExecutionRecord): { nodeId?: string; items?: NodeItem[] } {
  const nodeId = source.executionOrder.find((id) => source.runData[id]?.some((run: NodeRun) => run.source === 'main'));
  if (!nodeId) return {};
  const items = source.runData[nodeId].find((run) => run.source === 'main')?.inputs[0];
  return { nodeId, ...(items?.length && { items }) };
}

/** Turn "re-run this execution (from this node)" into run options. */
export function planRerun(sourceId: string, request: RerunRequest, workflowOverride?: Workflow): Omit<RunOptions, 'signal' | 'onEvent' | 'onStart'> {
  const source = store.getExecution(sourceId);
  if (!source) throw new RerunError(`Execution ${sourceId} not found`, 404);
  const workflow =
    workflowOverride ?? (request.version === 'original' && source.workflow ? source.workflow : (store.getWorkflow(source.workflowId) ?? source.workflow));
  if (!workflow) throw new RerunError('The workflow of this execution no longer exists', 404);
  const rerunOf: RerunOf = { executionId: source.executionId, scope: request.scope, ...(request.nodeId && { nodeId: request.nodeId }) };

  if (request.scope === 'all') {
    const start = recordedStart(source);
    const startNodeId = start.nodeId && workflow.nodes.some((n) => n.id === start.nodeId) ? start.nodeId : undefined;
    // A poll's run replays the items that poll found, rather than polling again.
    const polled = source.mode === 'poll' && startNodeId ? source.runData[startNodeId]?.find((run) => run.source === 'main')?.outputs[0] : undefined;
    if (polled) return { workflow, mode: source.mode, startNodeId, triggerOutput: { nodeId: startNodeId!, items: polled }, rerunOf };
    return { workflow, mode: source.mode, startNodeId, triggerItems: start.items, rerunOf };
  }
  if (!request.nodeId) throw new RerunError('nodeId is required to re-run from a node');
  if (!workflow.nodes.some((n) => n.id === request.nodeId)) throw new RerunError('That node is not in the workflow any more');
  return { workflow, mode: source.mode, partial: { executionId: source.executionId, nodeId: request.nodeId, scope: request.scope }, rerunOf };
}

export interface RetryRequest {
  /** `failed` (default): continue from the failed node, reusing what ran before it; `start`: run it all again. */
  from?: 'failed' | 'start';
  /** `original` (default): the version the execution ran; `current`: the saved workflow. */
  version?: 'original' | 'current';
  /** Started by the automatic retry timer. */
  automatic?: boolean;
}

/**
 * Turn "retry this failed execution" into run options. From the failed node: from its last checkpoint when it
 * has one and runs on the same version (what ran before is reused exactly), else a partial run from the failed
 * node; from the start (or when it has no failed node): the whole workflow with the same trigger input.
 */
export function planRetry(sourceId: string, request: RetryRequest = {}): Omit<RunOptions, 'signal' | 'onEvent' | 'onStart'> {
  const source = store.getExecution(sourceId);
  if (!source) throw new RerunError(`Execution ${sourceId} not found`, 404);
  if (source.status !== 'error' && source.status !== 'canceled') throw new RerunError('Only failed or canceled executions can be retried', 409);
  const original = source.workflow ?? (source.versionId ? getVersion(source.workflowId, source.versionId)?.workflow : undefined);
  const current = store.getWorkflow(source.workflowId);
  const workflow = request.version === 'current' ? (current ?? original) : (original ?? current);
  if (!workflow) throw new RerunError('The workflow of this execution no longer exists', 404);
  const retry = { of: source.executionId, attempt: (source.retryAttempt ?? 0) + 1 };
  const fromFailed = request.from !== 'start';
  if (fromFailed && workflow === original && store.getCheckpoint(sourceId)) return { workflow, mode: source.mode, retry, fromCheckpoint: { executionId: sourceId } };
  const failedNode = source.error?.nodeId;
  const scope = fromFailed && failedNode && workflow.nodes.some((node) => node.id === failedNode) ? { scope: 'from' as const, nodeId: failedNode } : { scope: 'all' as const };
  const { rerunOf: _rerunOf, ...options } = planRerun(sourceId, scope, workflow);
  return { ...options, retry };
}

/**
 * Retry a failed execution: a new execution linked to it (`retryOf`, and `retriedBy` on the failed one).
 * A manual retry replaces a pending automatic one and is never held back by the concurrency limit.
 * Resolves with the new execution's id once it has started.
 */
export function startRetry(sourceId: string, request: RetryRequest = {}): Promise<string> {
  const plan = planRetry(sourceId, request);
  retries.cancel(sourceId);
  return new Promise<string>((resolve, reject) => {
    let started = false;
    const onStart = (executionId: string) => {
      started = true;
      const source = store.patchExecution(sourceId, { retriedBy: executionId, retryAt: undefined });
      recordRuntimeEvent('retried', plan.workflow.id);
      // Kept only for its automatic retry (the workflow doesn't save failed executions): it has done its part.
      if (request.automatic && source && plan.workflow.settings?.saveFailedExecutions === false) store.deleteExecution(sourceId);
      resolve(executionId);
    };
    const run = () => runWorkflow({ ...plan, bypassConcurrency: true, onStart });
    (request.automatic ? fireTrigger({ source: 'retry', workflowId: plan.workflow.id }, run) : run()).catch((error) => {
      if (!started) reject(error);
      else logger.warn('retry failed', { 'landflow.execution.id': sourceId, error: (error as Error).message });
    });
  });
}
