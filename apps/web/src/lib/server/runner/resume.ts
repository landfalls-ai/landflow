/**
 * Continuing a waiting execution (same id) on the workflow version it started with.
 * (Split out of the former runner.ts; lib/server/runner.ts re-exports the public names.)
 */
import type { NodeItem } from '@landflow/protocol';
import type { ExecutionEvent, ResumeKind } from '@landflow/engine';
import type { ExecutionRecord } from '../../shared/types';
import { store } from '../store';
import { waits } from '../waits';
import { clusterActive } from '../cluster/state';
import { refreshRows } from '../db/replication';
import { type RunReply, ResumeError } from './types';
import { live } from './state';
import { runSegment } from './run';

export interface ResumeRequest {
  kind: ResumeKind;
  /** The waiting node's output (a webhook request, a form submission); default: what the node returned. */
  outputs?: NodeItem[][];
  /** Fail the waiting node instead (its sub-execution failed). */
  error?: string;
  onEvent?: (event: ExecutionEvent) => void;
  onReply?: (reply: RunReply) => void;
  /** Stream node chunks into onEvent (an approval answered from the chat panel or hosted chat). */
  streaming?: boolean;
}

/**
 * Continue a waiting execution (same id) on the workflow version it started with. Rejects with a
 * ResumeError when it doesn't exist, isn't waiting, or is already being resumed.
 */
export async function resumeExecution(executionId: string, request: ResumeRequest): Promise<ExecutionRecord> {
  // Everything up to runSegment's live.set() is synchronous, so two resume calls can't both get through.
  // (Queue mode: the row is read fresh, and dispatchSegment claims the resume in Valkey.)
  if (clusterActive()) await refreshRows('executions', { id: executionId });
  if (live.has(executionId)) throw new ResumeError('This execution is already running');
  const stored = store.getExecution(executionId);
  if (!stored) throw new ResumeError('Execution not found', 404);
  if (stored.status !== 'waiting' || !stored.resumeState || !stored.wait) throw new ResumeError('This execution is not waiting', 409);
  if (!stored.workflow) throw new ResumeError('The execution has no saved workflow to resume', 409);
  waits.clear(executionId);
  // The saved state leaves out the run data, which the record already holds.
  const state = { ...stored.resumeState, runData: stored.runData, executionOrder: stored.executionOrder };
  const { resumeState: _state, wait: _wait, ...rest } = stored;
  const record: ExecutionRecord = { ...rest, status: 'running', finishedAt: '', runData: structuredClone(stored.runData), executionOrder: [...stored.executionOrder] };
  return runSegment({
    record,
    workflow: stored.workflow,
    engine: { resume: { state, kind: request.kind, ...(request.outputs && { outputs: request.outputs }), ...(request.error && { error: request.error }) } },
    onEvent: request.onEvent,
    onReply: request.onReply,
    streaming: request.streaming,
  });
}
