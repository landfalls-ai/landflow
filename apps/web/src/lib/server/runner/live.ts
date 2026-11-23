/**
 * Reading and signalling the runs of this process: summaries, cancel, the debugger, Respond to Webhook replies, and
 * (queue mode) the runs the cluster runtime asks about.
 * (Split out of the former runner.ts; lib/server/runner.ts re-exports the public names.)
 */
import type { ExecutionMode, NodeItem } from '@landflow/protocol';
import type { DebugCommand } from '@landflow/engine';
import type { ExecutionRecord, ExecutionSummary, PausedState } from '../../shared/types';
import { store } from '../store';
import { cancelEverywhere, remoteRunning } from '../cluster/dispatch';
import { clusterActive } from '../cluster/state';
import { pausedElsewhere } from '../cluster/debug';
import type { RunReply } from './types';
import { live } from './state';

function summaryOf(record: ExecutionRecord, paused?: PausedState): ExecutionSummary {
  return {
    id: record.executionId,
    workflowId: record.workflowId,
    workflowName: record.workflowName,
    mode: record.mode,
    status: record.status,
    startedAt: record.startedAt,
    durationMs: Date.now() - Date.parse(record.startedAt),
    nodesRun: record.executionOrder.filter((id) => !record.runData[id]?.at(-1)?.reused).length,
    ...(record.rerunOf && { rerunOf: record.rerunOf }),
    ...(record.debug && { debug: true }),
    ...(paused && { paused }),
    ...(record.parentExecutionId && { parentExecutionId: record.parentExecutionId }),
    ...(record.versionId && { versionId: record.versionId }),
    ...(record.retryOf && { retryOf: record.retryOf, retryAttempt: record.retryAttempt ?? 1 }),
    ...(record.resumedAfterRestart && { resumedAfterRestart: true }),
    ...(record.evaluation && { evaluation: { runId: record.evaluation.runId } }),
  };
}

/** Executions still in progress (running or paused), newest first. Queue mode: also those other processes run. */
export function liveExecutions(workflowId?: string): ExecutionSummary[] {
  const local = [...live.values()]
    .filter((entry) => !workflowId || entry.record.workflowId === workflowId)
    .map((entry) => summaryOf(entry.record, entry.debug?.paused))
    .reverse();
  if (!clusterActive()) return local;
  return [...local, ...remoteRunning(new Set(live.keys()), workflowId)].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** A running execution as a record, with what it has done so far. Queue mode: also one another process runs (its saved steps). */
export function liveExecution(executionId: string): ExecutionRecord | undefined {
  const entry = live.get(executionId);
  if (!entry) return clusterActive() ? runningElsewhere(executionId) : undefined;
  return { ...entry.record, durationMs: Date.now() - Date.parse(entry.record.startedAt), ...(entry.debug?.paused && { paused: entry.debug.paused }) };
}

/** Queue mode: an execution saved as running by another process, with the node runs it saved since (and where its debugger paused). */
function runningElsewhere(executionId: string): ExecutionRecord | undefined {
  const stored = store.getExecution(executionId);
  if (stored?.status !== 'running') return undefined;
  const paused = pausedElsewhere(executionId);
  return { ...stored, ...withSavedSteps(stored), durationMs: Math.max(0, Date.now() - Date.parse(stored.startedAt)), ...(paused && { paused }) };
}

export function cancelExecution(executionId: string): boolean {
  const entry = live.get(executionId);
  entry?.controller.abort();
  // Queue mode: it may run in another process (its worker aborts it).
  if (!entry && clusterActive()) {
    const stored = store.getExecution(executionId);
    if (stored?.status !== 'running') return false;
    void cancelEverywhere(executionId, stored.workflowId);
    return true;
  }
  return Boolean(entry);
}

/**
 * Respond to Webhook and the Form node's end screen hand their reply to the request waiting on the
 * run. A form end screen is also kept on the execution. False when no request waits for a reply.
 */
export function deliverReply(executionId: string, reply: RunReply): boolean {
  const entry = live.get(executionId);
  if (!entry) return false;
  if (reply.type === 'form') entry.record.formCompletion = reply.completion;
  if (!entry.onReply || (entry.replied && reply.type === 'webhook')) return reply.type === 'form';
  if (reply.type === 'webhook') entry.replied = true;
  entry.onReply(reply);
  return true;
}

/** The items of the last main-flow node that ran successfully: what Execute Workflow returns. */
export function lastNodeItems(record: Pick<ExecutionRecord, 'executionOrder' | 'runData'>): NodeItem[] {
  for (let i = record.executionOrder.length - 1; i >= 0; i--) {
    const run = record.runData[record.executionOrder[i]]?.filter((r) => r.source === 'main').at(-1);
    if (run?.status === 'success') return run.outputs[0] ?? [];
  }
  return [];
}

export type DebugResult = { ok: true; paused?: PausedState } | { ok: false; error: string; status: number };

/** Send a debugger command and/or replace the breakpoints of a live run. */
export function debugExecution(executionId: string, request: { command?: DebugCommand; breakpoints?: string[] }): DebugResult {
  const entry = live.get(executionId);
  if (!entry) return { ok: false, error: 'Execution is not running', status: 404 };
  if (request.breakpoints) entry.debug?.setBreakpoints(request.breakpoints);
  if (request.command) {
    if (entry.debug?.command(request.command)) return { ok: true };
    if (request.command === 'stop') {
      entry.controller.abort();
      return { ok: true };
    }
    return { ok: false, error: 'Execution is not paused', status: 409 };
  }
  return { ok: true, ...(entry.debug?.paused && { paused: entry.debug.paused }) };
}

/** A saved record with the node runs saved after it (contiguous ones only): what an interrupted run had done. */
export function withSavedSteps(record: ExecutionRecord): Pick<ExecutionRecord, 'runData' | 'executionOrder'> {
  const runData = structuredClone(record.runData ?? {});
  const executionOrder = [...(record.executionOrder ?? [])];
  for (const step of store.steps(record.executionId)) {
    if (step.seq < executionOrder.length) continue;
    if (step.seq > executionOrder.length) break;
    (runData[step.nodeId] ??= []).push(step.run);
    executionOrder.push(step.nodeId);
  }
  return { runData, executionOrder };
}

/** The runs going in this process (leases, slots, the Workers status). */
export function localExecutions(): Array<{ executionId: string; workflowId: string; limited: boolean; mode: ExecutionMode }> {
  return [...live.values()].map((entry) => ({ executionId: entry.record.executionId, workflowId: entry.record.workflowId, limited: Boolean(entry.limited), mode: entry.record.mode }));
}

/** Abort a run of this process (a cancel from another process). */
export function abortLocalExecution(executionId: string): boolean {
  const entry = live.get(executionId);
  if (!entry || entry.controller.signal.aborted) return false;
  entry.controller.abort();
  return true;
}

/** Abort every run of this process (stop-all from another process). */
export function abortLocalExecutions(): number {
  let aborted = 0;
  for (const entry of [...live.values()]) {
    if (entry.controller.signal.aborted) continue;
    entry.controller.abort();
    aborted++;
  }
  return aborted;
}
