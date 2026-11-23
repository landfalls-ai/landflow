/**
 * Checkpoints, crash recovery and failing interrupted runs: at boot (and when a worker takes over a dead process's job)
 * running executions continue from their last checkpoint.
 * (Split out of the former runner.ts; lib/server/runner.ts re-exports the public names.)
 */
import { context, ROOT_CONTEXT } from '@opentelemetry/api';
import type { NodeItem } from '@landflow/protocol';
import type { CheckpointState, NodeRun, Workflow } from '@landflow/engine';
import type { ExecutionRecord, ExecutionState } from '../../shared/types';
import { bus } from '../bus';
import { getVersion } from '../versions';
import { singleton } from '../singleton';
import { store } from '../store';
import { logger, recordRuntimeEvent } from '../telemetry';
import { cancelRerunChildren } from '../sub-executions';
import { RerunError } from './types';
import { live } from './state';
import { withSavedSteps } from './live';
import { afterRun } from './links';
import { runSegment, startTriggerBuffers } from './run';
import { drainQueues } from './queue';

/** The first `count` entries of an execution's run order with their runs (runData[node][k] is the node's k-th entry). */
function prefixRuns(record: Pick<ExecutionRecord, 'executionOrder' | 'runData'>, count: number) {
  const executionOrder = record.executionOrder.slice(0, count);
  const runData: Record<string, NodeRun[]> = {};
  for (const nodeId of executionOrder) {
    const run = record.runData[nodeId]?.[(runData[nodeId] ??= []).length];
    if (!run) return undefined;
    runData[nodeId].push(run);
  }
  return { executionOrder, runData };
}

/** `$('Node')` outputs at a checkpoint: those the segment started with, then its successful main-flow runs in order. */
function outputsAt(checkpoint: { baseSteps: number; steps: number; baseOutputs?: Record<string, NodeItem[][]> }, runs: { executionOrder: string[]; runData: Record<string, NodeRun[]> }, workflow: Workflow) {
  const outputs: Record<string, NodeItem[][]> = { ...checkpoint.baseOutputs };
  const names = new Map(workflow.nodes.map((node) => [node.id, node.name]));
  const seen = new Map<string, number>();
  runs.executionOrder.forEach((nodeId, index) => {
    const run = runs.runData[nodeId]?.[seen.get(nodeId) ?? 0];
    seen.set(nodeId, (seen.get(nodeId) ?? 0) + 1);
    const name = names.get(nodeId);
    if (index >= checkpoint.baseSteps && index < checkpoint.steps && run?.source === 'main' && run.status === 'success' && name) outputs[name] = run.outputs;
  });
  return outputs;
}

/** What a retry from a failed execution's last checkpoint starts with: the runs before it (marked reused) and the scheduler state. */
export function seedFromCheckpoint(executionId: string, workflow: Workflow): { runData: Record<string, NodeRun[]>; executionOrder: string[]; state: CheckpointState } {
  const source = store.getExecution(executionId);
  const checkpoint = store.getCheckpoint(executionId);
  if (!source || !checkpoint) throw new RerunError(`Execution ${executionId} has no checkpoint to continue from`, 409);
  const prefix = prefixRuns(source, checkpoint.steps);
  if (!prefix) throw new RerunError(`The run data of execution ${executionId} does not match its checkpoint`, 409);
  const nodeOutputs = outputsAt(checkpoint, prefix, workflow);
  const reused = { executionId };
  const runData = Object.fromEntries(Object.entries(prefix.runData).map(([nodeId, runs]) => [nodeId, runs.map((run) => ({ ...run, reused: run.reused ?? reused }))]));
  const state: CheckpointState = { ...checkpoint.state, startedAt: new Date().toISOString(), activeMs: 0, runData, executionOrder: prefix.executionOrder, nodeOutputs };
  return { runData: structuredClone(runData), executionOrder: [...prefix.executionOrder], state };
}

/** A run that can't go on (or start): saved as failed (or canceled) with what it had done, its parent and error workflow told. */
export function failInterrupted(record: ExecutionRecord, message: string, status: Extract<ExecutionState, 'error' | 'canceled'> = 'error'): ExecutionRecord {
  const finishedAt = new Date();
  const durationMs = Math.max(0, finishedAt.getTime() - Date.parse(record.startedAt));
  const { resumeState: _state, wait: _wait, queued: _queued, ...rest } = record;
  const progress = withSavedSteps(record);
  const failed: ExecutionRecord = { ...rest, ...progress, status, finishedAt: finishedAt.toISOString(), durationMs, error: { message } };
  store.saveExecution(failed);
  store.clearCheckpoint(record.executionId);
  bus.publish({ channel: 'execution', workflowId: failed.workflowId, event: { type: 'execution.finished', executionId: failed.executionId, status, durationMs, error: failed.error, at: failed.finishedAt } });
  afterRun(failed, store.getWorkflow(failed.workflowId) ?? failed.workflow);
  return failed;
}

export interface RecoveryReport {
  resumed: string[];
  failed: Array<{ executionId: string; reason: string }>;
}

type RecoveryPlan =
  | { resume: true; workflow: Workflow; record: ExecutionRecord; state: CheckpointState; stepId: string }
  | { resume: false; reason: string; status?: 'canceled' };

/** How a `running` execution found at boot goes on: from its last checkpoint, or not (and why). */
export function planRecovery(record: ExecutionRecord, running: Map<string, ExecutionRecord>): RecoveryPlan {
  if (record.debug) return { resume: false, reason: 'The debug session ended when the host restarted', status: 'canceled' };
  // A sub-execution whose parent will run the Execute Workflow step again (that starts a new one).
  const parent = record.parentExecutionId ? running.get(record.parentExecutionId) : undefined;
  if (parent && record.parentNodeId && store.getCheckpoint(parent.executionId)?.state.stack.some((entry) => entry.nodeId === record.parentNodeId)) {
    return { resume: false, reason: `The host restarted: the parent execution ${parent.executionId} runs the step that started this one again`, status: 'canceled' };
  }
  const workflow = record.workflow ?? (record.versionId ? getVersion(record.workflowId, record.versionId)?.workflow : undefined);
  if (!workflow) {
    return {
      resume: false,
      reason: record.versionId
        ? `Could not continue after the restart: workflow version ${record.versionId} no longer exists`
        : 'Could not continue after the restart: the workflow it ran was not saved',
    };
  }
  const checkpoint = store.getCheckpoint(record.executionId);
  if (!checkpoint) return { resume: false, reason: 'Could not continue after the restart: the host stopped before the execution saved a checkpoint' };
  // The record was saved when the segment started; the node runs since are steps.
  const prefix = record.executionOrder.length >= checkpoint.baseSteps ? prefixRuns(record, checkpoint.baseSteps) : undefined;
  const steps = store.steps(record.executionId).filter((step) => step.seq >= checkpoint.baseSteps && step.seq < checkpoint.steps);
  if (!prefix || steps.length !== checkpoint.steps - checkpoint.baseSteps || steps.some((step, index) => step.seq !== checkpoint.baseSteps + index)) {
    return { resume: false, reason: 'Could not continue after the restart: its saved progress is incomplete' };
  }
  for (const step of steps) {
    (prefix.runData[step.nodeId] ??= []).push(step.run);
    prefix.executionOrder.push(step.nodeId);
  }
  const nodeOutputs = outputsAt(checkpoint, prefix, workflow);
  const at = new Date().toISOString();
  const { resumeState: _state, wait: _wait, ...rest } = record;
  return {
    resume: true,
    workflow,
    stepId: checkpoint.stepId,
    record: { ...rest, status: 'running', finishedAt: '', runData: structuredClone(prefix.runData), executionOrder: [...prefix.executionOrder], resumedAfterRestart: { at, stepId: checkpoint.stepId } },
    state: { ...checkpoint.state, runData: prefix.runData, executionOrder: prefix.executionOrder, nodeOutputs },
  };
}

/**
 * Boot: continue each execution a crash or restart left `running` from its last checkpoint (tagged "resumed
 * after restart"), on the workflow version it ran. One that can't continue (a debug session, its version is
 * gone, no checkpoint yet) is saved as failed with the reason; a sub-execution whose parent repeats the step
 * that started it is canceled. Queued executions are started separately (drainQueues).
 */
export function recoverExecutions(): RecoveryReport {
  const report: RecoveryReport = { resumed: [], failed: [] };
  const running = new Map(store.executionsWithStatus('running').filter((record) => !live.has(record.executionId)).map((record) => [record.executionId, record]));
  // Decide for all first: a parent's checkpoint decides about its children before it moves on.
  const plans = [...running.values()].map((record) => ({ record, plan: planRecovery(record, running) }));
  for (const { record, plan } of plans) {
    if (plan.resume) continue;
    failInterrupted(record, plan.reason, plan.status);
    report.failed.push({ executionId: record.executionId, reason: plan.reason });
    recordRuntimeEvent('recovery_failed', record.workflowId);
    logger.warn('execution not continued after the restart', { 'landflow.execution.id': record.executionId, 'landflow.workflow.id': record.workflowId, reason: plan.reason });
  }
  for (const { record, plan } of plans) {
    if (!plan.resume) continue;
    report.resumed.push(record.executionId);
    recordRuntimeEvent('recovered', record.workflowId);
    cancelRerunChildren(record.executionId, plan.state.stack.map((entry) => entry.nodeId));
    logger.info('execution resumed after restart', { 'landflow.execution.id': record.executionId, 'landflow.workflow.id': record.workflowId, 'landflow.checkpoint.step': plan.stepId });
    // Its own trace (the one it started in has ended).
    void context
      .with(ROOT_CONTEXT, () =>
        runSegment({
          record: plan.record,
          workflow: plan.workflow,
          engine: {
            resume: { state: plan.state, kind: 'restart' },
            spanAttributes: { 'landflow.execution.resumed_after_restart': true, 'landflow.checkpoint.step': plan.stepId },
          },
        }),
      )
      .catch((error) => logger.warn('could not resume the execution after the restart', { 'landflow.execution.id': record.executionId, error: (error as Error).message }));
  }
  return report;
}

/** Boot: recover interrupted executions and start what the queues can run, after `graceMs` (plugins announce first). */
export function startRecovery(graceMs = 3_000): void {
  startTriggerBuffers();
  singleton('execution-recovery', () => {
    const timer = setTimeout(() => {
      try {
        const report = recoverExecutions();
        if (report.resumed.length || report.failed.length) {
          logger.info('interrupted executions handled', { 'landflow.executions.resumed': report.resumed.length, 'landflow.executions.failed': report.failed.length });
        }
        drainQueues();
      } catch (error) {
        logger.error('execution recovery failed', { error });
      }
    }, graceMs);
    timer.unref?.();
    return true;
  });
}
