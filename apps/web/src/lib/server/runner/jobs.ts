/**
 * Queue mode: what the cluster runtime (lib/server/cluster) runs here for a worker.
 * (Split out of the former runner.ts; lib/server/runner.ts re-exports the public names.)
 */
import type { ExecuteWorkflowOptions, Workflow } from '@landflow/engine';
import type { ExecutionRecord } from '../../shared/types';
import { store } from '../store';
import { logger, recordRuntimeEvent } from '../telemetry';
import { cancelRerunChildren } from '../sub-executions';
import type { Segment } from './types';
import { runSegment } from './run';
import { failInterrupted, planRecovery } from './recovery';

/** A worker runs a job's stretch of an execution here (the record and engine options its main built). */
export function runJob(record: ExecutionRecord, workflow: Workflow, engine: Partial<ExecuteWorkflowOptions>, callbacks: Pick<Segment, 'signal' | 'onEvent' | 'onReply' | 'streaming'> = {}): Promise<ExecutionRecord> {
  return runSegment({ record, workflow, engine, ...callbacks, dispatched: true });
}

/**
 * A worker took over the job of a run whose process stopped (it is still saved as running): continue it from its last
 * checkpoint, as recoverExecutions does at boot, or save it as failed when it can't continue.
 */
export function recoverExecution(record: ExecutionRecord, callbacks: Pick<Segment, 'signal' | 'onEvent' | 'onReply' | 'streaming'> = {}): Promise<ExecutionRecord> {
  // Every run saved as running counts: a parent being taken over decides about its children.
  const running = new Map(store.executionsWithStatus('running').map((stored) => [stored.executionId, stored]));
  running.set(record.executionId, record);
  const plan = planRecovery(record, running);
  if (!plan.resume) {
    recordRuntimeEvent('recovery_failed', record.workflowId);
    logger.warn('execution not continued after its process stopped', { 'landflow.execution.id': record.executionId, 'landflow.workflow.id': record.workflowId, reason: plan.reason });
    return Promise.resolve(failInterrupted(record, plan.reason, plan.status));
  }
  recordRuntimeEvent('recovered', record.workflowId);
  cancelRerunChildren(record.executionId, plan.state.stack.map((entry) => entry.nodeId));
  logger.info('execution taken over after its process stopped', { 'landflow.execution.id': record.executionId, 'landflow.workflow.id': record.workflowId, 'landflow.checkpoint.step': plan.stepId });
  return runSegment({
    record: plan.record,
    workflow: plan.workflow,
    engine: { resume: { state: plan.state, kind: 'restart' }, spanAttributes: { 'landflow.execution.resumed_after_restart': true, 'landflow.checkpoint.step': plan.stepId } },
    ...callbacks,
    dispatched: true,
  });
}

/** Save a run that can't go on as failed (a job that kept losing its worker). */
export function failExecution(record: ExecutionRecord, message: string): ExecutionRecord {
  return failInterrupted(record, message);
}
