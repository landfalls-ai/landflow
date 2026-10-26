import type { ExecutionRecord, NodeRun } from '@/lib/shared/types';

/** `waiting`: the node the execution waits at (a Wait or form page, an Execute Workflow node whose children run, an approval). */
export type NodeRunState = 'idle' | 'running' | 'paused' | 'waiting' | 'success' | 'error';

/** What the canvas shows on a node after (or during) a run. */
export interface NodeStatus {
  state: NodeRunState;
  itemCounts?: number[];
  durationMs?: number;
  error?: string;
  /** Sub-node usage count during the run (tool calls, model turns). */
  uses?: number;
  /** Copied from an earlier execution by a partial re-run, not run again. */
  reused?: boolean;
  /** When the current run of this node started (live runs only). */
  startedAt?: string;
  /** State `waiting`: what it waits for ("Waiting until 14:05", see waitSummary). */
  wait?: string;
}

/** Minimal edge shape shared by the editor and read-only canvases. */
export interface RunEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  data?: { connectionType: string };
}

export function statusesOf(runData: Record<string, NodeRun[]>): Record<string, NodeStatus> {
  const statuses: Record<string, NodeStatus> = {};
  for (const [nodeId, runs] of Object.entries(runData)) {
    const last = runs[runs.length - 1];
    if (!last) continue;
    statuses[nodeId] = {
      state: last.status,
      itemCounts: last.source === 'main' ? last.outputs.map((o) => o.length) : undefined,
      durationMs: last.durationMs,
      error: last.error?.message,
      uses: last.source === 'main' ? undefined : runs.length,
      reused: Boolean(last.reused),
    };
  }
  return statuses;
}

/** Items carried per edge (main) or calls made per edge (sub-node ports). */
export function edgeCountsOf(edges: RunEdge[], runData: Record<string, NodeRun[]>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const edge of edges) {
    const runs = runData[edge.source];
    if (!runs) continue;
    if ((edge.data?.connectionType ?? 'main') === 'main') {
      const index = Number((edge.sourceHandle ?? 'main:0').split(':')[1] ?? 0);
      const count = runs.filter((r) => r.source === 'main').reduce((sum, r) => sum + (r.outputs[index]?.length ?? 0), 0);
      if (count) counts[edge.id] = count;
    } else {
      counts[edge.id] = runs.filter((r) => r.parentNodeId === edge.target).length;
    }
  }
  return counts;
}

export interface RunEntry {
  nodeId: string;
  /** Index into runData[nodeId]. */
  runIndex: number;
  run: NodeRun;
}

/** Every run in the order it started, sub-node calls included. */
export function runsInOrder(runData: Record<string, NodeRun[]>): RunEntry[] {
  return Object.entries(runData)
    .flatMap(([nodeId, runs]) => runs.map((run, runIndex) => ({ nodeId, runIndex, run })))
    .sort((a, b) => Date.parse(a.run.startedAt) - Date.parse(b.run.startedAt) || Number(Boolean(b.run.reused)) - Number(Boolean(a.run.reused)));
}

// ---------------------------------------------------------------------------
// Waiting executions
// ---------------------------------------------------------------------------

/** What a waiting execution waits for (`ExecutionRecord.wait`, or the `wait` of an `execution.finished` event). */
export type WaitInfo = NonNullable<ExecutionRecord['wait']>;

/** A child of a parent waiting for its sub-workflows: the item it ran for and, once it finished, how it ended. */
export interface WaitedChild {
  item: number;
  executionId: string;
  status?: 'success' | 'error' | 'canceled';
}

/** The sub-executions a waiting parent waits for (`wait.data`: one per item in "each" mode, else the one child). */
export function waitedChildren(record: { status?: string; wait?: Pick<WaitInfo, 'resume' | 'data'> } | undefined): WaitedChild[] | undefined {
  if (record?.status !== 'waiting' || record.wait?.resume !== 'subworkflow') return undefined;
  const data = record.wait.data ?? {};
  if (data.mode === 'each' && Array.isArray(data.children)) return data.children as unknown as WaitedChild[];
  return typeof data.executionId === 'string' ? [{ item: 0, executionId: data.executionId }] : undefined;
}

const TIME = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });
const DAY_TIME = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** "14:05" today, else "Oct 27, 14:05" (local time). */
export function waitTime(iso: string, now = Date.now()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toDateString() === new Date(now).toDateString() ? TIME.format(at) : DAY_TIME.format(at);
}

/**
 * What a waiting node waits for, in a few words: "Waiting on 2 of 3 sub-workflows", "Waiting until 14:05", "Waiting
 * for a webhook call (until 14:05)", "Waiting for a form submission", "Waiting for a tool approval". The same data the
 * Executions view's banner reads (`wait`, and the children in `wait.data`).
 */
export function waitSummary(wait: Pick<WaitInfo, 'resume' | 'until' | 'data'>, now = Date.now()): string {
  const limit = wait.until ? ` (until ${waitTime(wait.until, now)})` : '';
  switch (wait.resume) {
    case 'time':
      return wait.until ? `Waiting until ${waitTime(wait.until, now)}` : 'Waiting for a while';
    case 'form':
      return `Waiting for a form submission${limit}`;
    case 'subworkflow': {
      const children = waitedChildren({ status: 'waiting', wait }) ?? [];
      if (children.length <= 1) return 'Waiting on a sub-workflow';
      return `Waiting on ${children.filter((c) => !c.status).length} of ${children.length} sub-workflows`;
    }
    default:
      return wait.data?.approval ? `Waiting for a tool approval${limit}` : `Waiting for a webhook call${limit}`;
  }
}

/** Run statuses with the node a waiting execution waits at marked `waiting` (it has no finished run yet). */
export function withWaiting(statuses: Record<string, NodeStatus>, record: { status?: string; wait?: Pick<WaitInfo, 'nodeId' | 'resume' | 'until' | 'data'> }, now = Date.now()): Record<string, NodeStatus> {
  if (record.status !== 'waiting' || !record.wait?.nodeId) return statuses;
  const { nodeId } = record.wait;
  return { ...statuses, [nodeId]: { ...statuses[nodeId], state: 'waiting', wait: waitSummary(record.wait, now) } };
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

/** How the nodes inside a (collapsed) group did, for its box on the read-only canvases. */
export interface GroupRunSummary {
  /** The loudest of its nodes' states: error, then paused, running, waiting, success; idle when none ran. */
  state: Exclude<NodeRunState, 'idle'> | 'idle';
  total: number;
  /** Nodes that finished a run (failed ones included). */
  ran: number;
  failed: number;
  /** "1 failed", "Running", "Waiting until 14:05", "3 of 4 ran", "Did not run". */
  label: string;
}

const LOUDEST: NodeRunState[] = ['error', 'paused', 'running', 'waiting', 'success'];

export function summarizeGroupRun(nodeIds: readonly string[], statuses: Record<string, NodeStatus>): GroupRunSummary {
  const states = nodeIds.map((id) => statuses[id]).filter((s): s is NodeStatus => Boolean(s));
  const ran = states.filter((s) => s.state === 'success' || s.state === 'error').length;
  const failed = states.filter((s) => s.state === 'error').length;
  const state = LOUDEST.find((candidate) => states.some((s) => s.state === candidate)) ?? 'idle';
  const label =
    state === 'error'
      ? `${failed} failed`
      : state === 'paused'
        ? 'Paused inside'
        : state === 'running'
          ? 'Running'
          : state === 'waiting'
            ? (states.find((s) => s.state === 'waiting')?.wait ?? 'Waiting')
            : state === 'success'
              ? ran < nodeIds.length
                ? `${ran} of ${nodeIds.length} ran`
                : ran === 1
                  ? 'Ran'
                  : `All ${ran} ran`
              : 'Did not run';
  return { state, total: nodeIds.length, ran, failed, label };
}
