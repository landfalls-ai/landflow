import type { NodeRun } from '@/lib/shared/types';

export type NodeRunState = 'idle' | 'running' | 'paused' | 'success' | 'error';

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
