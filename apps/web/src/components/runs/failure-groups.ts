/**
 * Repeated failures, collapsed (docs/run-trace.md#the-runs-list): consecutive failed runs of one workflow that stopped at
 * the same node with the same message become one group. Plain data in, plain data out, so a test can read it.
 */
import type { ExecutionSummary } from '@/lib/shared/types';

export type RunRow = { kind: 'run'; run: ExecutionSummary } | { kind: 'group'; key: string; failure: string; runs: ExecutionSummary[]; workflowName: string; node?: string; message: string };

/** What makes two failures "the same": workflow, node and message. */
export function failureKey(run: Pick<ExecutionSummary, 'workflowId' | 'status' | 'error'>): string | undefined {
  if (run.status !== 'error' || !run.error) return undefined;
  return JSON.stringify([run.workflowId, run.error.nodeId ?? run.error.nodeName ?? '', run.error.message]);
}

/**
 * Two or more neighbours with one key become a group, keyed by its oldest run so a newer failure doesn't remount the row;
 * a run of another kind (a success, another error) ends it. `failure` is the `failureKey` the list holds open state by,
 * so a group stays open when its oldest run is deleted, leaves the loaded window or is filtered out.
 */
export function groupFailures(runs: ExecutionSummary[]): RunRow[] {
  const rows: RunRow[] = [];
  let i = 0;
  while (i < runs.length) {
    const key = failureKey(runs[i]);
    let j = i + 1;
    if (key) while (j < runs.length && failureKey(runs[j]) === key) j++;
    if (key && j - i > 1) {
      const first = runs[i];
      rows.push({ kind: 'group', key: `${key}#${runs[j - 1].id}`, failure: key, runs: runs.slice(i, j), workflowName: first.workflowName, node: first.error?.nodeName, message: first.error?.message ?? '' });
    } else for (let k = i; k < j; k++) rows.push({ kind: 'run', run: runs[k] });
    i = j;
  }
  return rows;
}

/** "Failed ×9 · Post to Slack: no credential" */
export function groupTitle(group: Extract<RunRow, { kind: 'group' }>): string {
  return `Failed ×${group.runs.length} · ${group.node ? `${group.node}: ` : ''}${group.message}`;
}
