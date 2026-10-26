/**
 * Execute Workflow in "Run Once for Each Item" mode with "Wait for Sub-Workflow Completion": the node starts one child
 * per item, and when some of them wait, the parent waits for all of them (`wait.resume = 'subworkflow'`). The state is
 * the parent's `wait.data` (`EachWait`), saved with the execution: it survives a restart, and in queue mode every
 * process reads the same row. One entry per item: the child's execution id and, once it finished, its output or error.
 * Outputs stay inline while they add up to less than EACH_INLINE_MAX_BYTES; past that an entry is only marked `stored`
 * and the parent reads that child's output from its execution when it resumes (failing the node, naming the child, if
 * the execution was deleted in the meantime).
 *
 * A finished child records its result through `settleChildren`, as one step: a synchronous stretch in regular mode,
 * under a cluster lock with the parent's row read fresh in queue mode. The step that settles the last open entry marks
 * the wait `resuming` and resumes the parent with every output in item order (`pairedItem` = the item's index). A
 * failed or canceled child resumes it with that error at once and cancels the children still open, unless the node
 * continues on error: then the item gets `{ error }` and the wait goes on. `resuming` keeps a second child (or the
 * boot check) from resuming the parent again.
 *
 * Also here: stopping a waiting parent cancels the children it waits for (`cancelChildrenOf`, "once" mode too), a run
 * continued after a restart that runs the Execute Workflow step again cancels the children the step's first run left
 * waiting (`cancelRerunChildren`), and `reconcileWaitingParents` (at boot, and on the leader's sweep in queue mode)
 * settles children that finished while nobody listened: their process stopped before it told the parent.
 */
import { context, ROOT_CONTEXT } from '@opentelemetry/api';
import type { JsonObject, NodeItem } from '@landflow/protocol';
import type { ExecutionRecord } from '../shared/types';
import { exclusive } from './cluster/limits';
import { clusterActive, coordinator } from './cluster/state';
import { database } from './db';
import { refreshRows } from './db/replication';
import { store } from './store';
import { logger } from './telemetry';

/** A child of an each-item wait: the input item it ran for and, once it finished, how it ended. */
export interface EachChild {
  item: number;
  executionId: string;
  status?: 'success' | 'error' | 'canceled';
  /** Success: its last node's items (`pairedItem` is set when the parent resumes). */
  output?: NodeItem[];
  /** Success, past the inline cap: the output is read from the child's execution when the parent resumes. */
  stored?: true;
  /** Failed or canceled: the message the parent shows. */
  error?: string;
}

/** `wait.data` of a parent waiting for its children in each-item mode. */
export interface EachWait {
  mode: 'each';
  workflowId: string;
  /** One per input item, in item order. */
  children: EachChild[];
  /** The node continues on error: a failed child becomes an error item instead of failing the parent. */
  continueOnFail?: boolean;
  /** The parent is being resumed: later results change nothing. */
  resuming?: boolean;
}

/** What the finished children's outputs may add up to inline in the parent's wait (JSON bytes); past it they are `stored`. */
export const EACH_INLINE_MAX_BYTES = 256 * 1024;

const FINISHED = new Set<string>(['success', 'error', 'canceled']);
const isFinished = (status: string | undefined) => Boolean(status && FINISHED.has(status));
/** A saved execution's status, without loading its record. */
const statusOf = (id: string) => database().get<{ status: string }>('SELECT status FROM executions WHERE id = ?', id)?.status;

/** Why a child did not succeed, as its parent reports it. */
export function childFailure(child: Pick<ExecutionRecord, 'executionId' | 'status' | 'error'>): string {
  if (child.status === 'canceled') return `The sub-workflow was canceled (execution ${child.executionId})`;
  return `Sub-workflow failed: ${child.error?.message ?? 'unknown error'} (execution ${child.executionId})`;
}

/** The each-item wait of a waiting execution, when that is what it waits for. */
export function eachWaitOf(record: Pick<ExecutionRecord, 'status' | 'wait'> | undefined): EachWait | undefined {
  const data = record?.status === 'waiting' && record.wait?.resume === 'subworkflow' ? record.wait.data : undefined;
  return data?.mode === 'each' && Array.isArray(data.children) ? (data as unknown as EachWait) : undefined;
}

/** The children a waiting execution still waits for: the open entries of an each-item wait, or the one child in "once" mode. */
export function openChildren(record: Pick<ExecutionRecord, 'status' | 'wait'>): string[] {
  if (record.status !== 'waiting' || record.wait?.resume !== 'subworkflow') return [];
  const each = eachWaitOf(record);
  if (each) return each.children.filter((child) => !child.status).map((child) => child.executionId);
  const id = String(record.wait.data?.executionId ?? '');
  return id ? [id] : [];
}

/** A finished child's entry; `items` is its last node's output (the runner's lastNodeItems). */
export function finishedEntry(child: Pick<ExecutionRecord, 'executionId' | 'status' | 'error'>, items: NodeItem[]): Omit<EachChild, 'item' | 'executionId'> {
  if (child.status === 'success') return { status: 'success', output: plainItems(items) };
  return { status: child.status === 'canceled' ? 'canceled' : 'error', error: childFailure(child) };
}

const plainItems = (items: NodeItem[]): NodeItem[] => items.map((item) => ({ json: item.json, ...(item.binary && { binary: item.binary }) }));

/**
 * Keep the wait record small: in item order, successful outputs stay inline while they add up to EACH_INLINE_MAX_BYTES,
 * and later ones become `stored` (read from the child's execution on resume). A child whose execution isn't kept
 * (its workflow doesn't save successful runs) stays inline: there is nothing to read it back from.
 */
export function capInlineOutputs(children: EachChild[]): void {
  let bytes = 0;
  for (const child of [...children].sort((a, b) => a.item - b.item)) {
    if (child.status !== 'success' || !child.output) continue;
    const size = Buffer.byteLength(JSON.stringify(child.output));
    if (bytes + size > EACH_INLINE_MAX_BYTES && statusOf(child.executionId) === 'success') {
      delete child.output;
      child.stored = true;
    } else bytes += size;
  }
}

/** Why a stored output can't be read: the child's execution is gone (retention, or deleted by hand). */
export const goneChildMessage = (child: Pick<EachChild, 'item' | 'executionId'>) =>
  `Sub-execution ${child.executionId} (item ${child.item}) no longer exists, so its output can’t be read: it was deleted before this run resumed`;

/** The children with the outputs of `stored` entries read from their executions, or the error for one that is gone. */
export async function loadStoredOutputs(children: EachChild[]): Promise<{ children: EachChild[] } | { error: string }> {
  if (!children.some((child) => child.stored)) return { children };
  const { lastNodeItems } = await import('./runner');
  const loaded: EachChild[] = [];
  for (const child of children) {
    if (!child.stored) {
      loaded.push(child);
      continue;
    }
    // Queue mode: another process saved it.
    if (clusterActive()) await refreshRows('executions', { id: child.executionId }).catch(() => {});
    const record = store.getExecution(child.executionId);
    if (record?.status !== 'success') return { error: goneChildMessage(child) };
    const { stored: _stored, ...rest } = child;
    loaded.push({ ...rest, output: plainItems(lastNodeItems(record)) });
  }
  return { children: loaded };
}

/** The node's output: every child's items in item order, and `{ error }` for a child that failed (continue on error). */
export function eachOutput(children: EachChild[]): NodeItem[] {
  return [...children]
    .sort((a, b) => a.item - b.item)
    .flatMap((child) =>
      child.status === 'success'
        ? (child.output ?? []).map((item) => ({ json: item.json, ...(item.binary && { binary: item.binary }), pairedItem: { item: child.item } }))
        : [{ json: { error: child.error ?? 'Sub-workflow failed' }, pairedItem: { item: child.item } }],
    );
}

/** What resumes the parent (the finished children, whose `stored` outputs are read then) and which children nothing waits for any more. */
interface Verdict {
  request: { children: EachChild[] } | { error: string };
  cancel: string[];
}

/** A wait that is over: resume with the first failure (unless the node continues on error), or with every output once none is open. */
function verdictOf(data: EachWait): Verdict | undefined {
  const open = data.children.filter((child) => !child.status).map((child) => child.executionId);
  const failed = data.continueOnFail ? undefined : data.children.find((child) => child.status && child.status !== 'success');
  if (failed) return { request: { error: failed.error ?? 'Sub-workflow failed' }, cancel: open };
  return open.length ? undefined : { request: { children: data.children }, cancel: [] };
}

interface SettleOptions {
  /** Also take open children whose saved execution has finished (their word may have been lost). */
  sweep?: boolean;
  /** The boot check: resume a parent a stopped process was resuming. */
  boot?: boolean;
}

/** The step: record finished children in the parent's wait and save it (`saved`); what follows when the wait is over. */
function settleStep(parentId: string, finished: ExecutionRecord[], itemsOf: (child: ExecutionRecord) => NodeItem[], options: SettleOptions) {
  const parent = store.getExecution(parentId);
  const data = eachWaitOf(parent);
  if (!parent?.wait || !data) return { saved: false };
  if (data.resuming) return { saved: false, verdict: options.boot ? verdictOf(data) : undefined };
  const given = new Map(finished.map((child) => [child.executionId, child]));
  let changed = false;
  for (const entry of data.children) {
    if (entry.status) continue;
    const child = given.get(entry.executionId) ?? (options.sweep ? store.getExecution(entry.executionId) : undefined);
    if (!child || !isFinished(child.status)) continue;
    Object.assign(entry, finishedEntry(child, itemsOf(child)));
    changed = true;
  }
  if (!changed) return { saved: false };
  capInlineOutputs(data.children);
  const verdict = verdictOf(data);
  if (verdict) data.resuming = true;
  store.patchExecution(parentId, { wait: { ...parent.wait, data: data as unknown as JsonObject } });
  return { saved: true, verdict };
}

/**
 * Children of an each-item wait finished: record their results in the parent's wait, and resume the parent when that
 * was the last open one (or one failed). Atomic per parent: synchronous in regular mode, under the cluster lock
 * `subworkflows:<parent>` with the rows read fresh in queue mode. A child it doesn't wait for (any more) changes nothing.
 */
export async function settleChildren(parentId: string, finished: ExecutionRecord[], options: SettleOptions = {}): Promise<void> {
  try {
    // Loaded lazily: the runner imports this module.
    const { lastNodeItems, resumeExecution } = await import('./runner');
    const step = () => settleStep(parentId, finished, lastNodeItems, options);
    const fresh = async () => {
      await refreshRows('executions', { id: parentId });
      if (options.sweep) await refreshRows('executions', { parent_id: parentId });
      const result = step();
      // Postgres: the next holder of the lock reads what this one wrote.
      if (result.saved) await database().flush();
      return result;
    };
    // Queue mode: many children may finish at once, on any process; they take turns.
    const outcome = clusterActive() ? await exclusive(coordinator(), `subworkflows:${parentId}`, fresh, { waitMs: 60_000 }) : step();
    if (!outcome.verdict) return;
    const { request: verdict, cancel } = outcome.verdict;
    // Outputs past the inline cap come from the children's executions now (with none, no await: the resume below
    // marks the parent running before another settle or the boot check can look at it).
    const loaded = 'error' in verdict || !verdict.children.some((child) => child.stored) ? verdict : await loadStoredOutputs(verdict.children);
    const request = 'error' in loaded ? { error: loaded.error } : { outputs: [eachOutput(loaded.children)] };
    // Its own trace, like any resume.
    void context
      .with(ROOT_CONTEXT, () => resumeExecution(parentId, { kind: 'subworkflow', ...request }))
      .catch((error) => logger.warn('could not resume the parent execution', { 'landflow.execution.id': parentId, error: (error as Error).message }));
    await cancelSubExecutions(cancel);
  } catch (error) {
    logger.warn('could not hand sub-execution results to the parent', { 'landflow.execution.id': parentId, error: (error as Error).message });
  }
}

/** Cancel sub-executions nothing waits for any more, wherever they are: waiting, queued or running (in any process). */
export async function cancelSubExecutions(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const { cancelExecution, cancelQueuedExecution, cancelWaitingExecution } = await import('./runner');
  for (const id of ids) {
    if (clusterActive()) await refreshRows('executions', { id }).catch(() => {});
    if (!cancelWaitingExecution(id) && !cancelQueuedExecution(id)) cancelExecution(id);
  }
}

/** A waiting parent was stopped: the children it waited for are canceled too. */
export function cancelChildrenOf(record: ExecutionRecord): void {
  const ids = openChildren(record);
  if (!ids.length) return;
  const fail = (error: Error) => logger.warn('could not cancel the sub-executions', { 'landflow.execution.id': record.executionId, error: error.message });
  void cancelSubExecutions(ids).catch(fail);
}

/** A run continued after a restart runs these steps again (they start new children): the children their first run left waiting are canceled. */
export function cancelRerunChildren(parentId: string, nodeIds: string[]): void {
  const steps = new Set(nodeIds);
  const ids = store
    .waitingExecutions()
    .filter((child) => child.parentExecutionId === parentId && child.parentNodeId && steps.has(child.parentNodeId))
    .map((child) => child.executionId);
  if (ids.length) void cancelSubExecutions(ids).catch(() => {});
}

/**
 * Parents waiting for children that finished while nobody listened (their process stopped in between): settle them,
 * and at boot (`boot`) also resume parents a stopped process was resuming, and "once" parents whose child finished.
 * At boot (the wait timers' start) and on the leader's sweep in queue mode. Returns how many parents it handled.
 */
export async function reconcileWaitingParents(options: { boot?: boolean } = {}): Promise<number> {
  let handled = 0;
  for (const parent of store.waitingExecutions()) {
    if (parent.wait?.resume !== 'subworkflow') continue;
    const each = eachWaitOf(parent);
    if (each) {
      const finished = each.children.some((child) => !child.status && isFinished(statusOf(child.executionId)));
      if (!finished && !(options.boot && each.resuming)) continue;
      await settleChildren(parent.executionId, [], { sweep: true, boot: options.boot });
      handled++;
      continue;
    }
    if (!options.boot) continue;
    const child = store.getExecution(String(parent.wait.data?.executionId ?? ''));
    if (!child || !isFinished(child.status)) continue;
    const { lastNodeItems, resumeExecution } = await import('./runner');
    const request = child.status === 'success' ? { outputs: [lastNodeItems(child)] } : { error: childFailure(child) };
    void context
      .with(ROOT_CONTEXT, () => resumeExecution(parent.executionId, { kind: 'subworkflow', ...request }))
      .catch((error) => logger.warn('could not resume the parent execution', { 'landflow.execution.id': parent.executionId, error: (error as Error).message }));
    handled++;
  }
  if (handled) logger.info('parents of finished sub-executions handled', { 'landflow.executions.parents': handled });
  return handled;
}
