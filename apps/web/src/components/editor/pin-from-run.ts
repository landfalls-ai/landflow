/**
 * "Copy to editor" from the Run Trace: the workflow opens at `?execution=<id>&pin=<nodeId|all>` with the outputs of the
 * steps that ran before that node pinned (test data), so the flow can be fixed and tried again from there without running
 * the earlier steps.
 */
import type { ExecutionRecord } from '@/lib/shared/types';
import { useEditor } from './store';

/** Pin the first output with items of each step that ran before `until` (all of them for `all`). Returns how many nodes were pinned. */
export function pinFromRun(record: Pick<ExecutionRecord, 'executionOrder' | 'runData'>, until: string): number {
  const state = useEditor.getState();
  const known = new Set(state.nodes.map((n) => n.id));
  const pinned = new Set<string>();
  for (const nodeId of record.executionOrder) {
    if (until !== 'all' && nodeId === until) break;
    if (!known.has(nodeId) || pinned.has(nodeId)) continue;
    const run = [...(record.runData[nodeId] ?? [])].reverse().find((r) => r.source === 'main' && !r.error);
    const items = run?.outputs.find((branch) => branch.length > 0);
    if (!items) continue;
    state.setPinData(nodeId, items);
    pinned.add(nodeId);
  }
  return pinned.size;
}
