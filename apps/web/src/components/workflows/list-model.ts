import type { ExecutionState, ExecutionSummary } from '@/lib/shared/types';

/** The items of the Workflows page's one "New" menu, in order. */
export const NEW_MENU_ITEMS = [
  { id: 'workflow', label: 'Workflow' },
  { id: 'template', label: 'From template' },
  { id: 'import', label: 'Import…' },
  { id: 'folder', label: 'Folder' },
] as const;
export type NewMenuItem = (typeof NEW_MENU_ITEMS)[number]['id'];

/** The newest run of each workflow, from a newest-first list of executions. */
export function lastRunByWorkflow(executions: ExecutionSummary[]): Map<string, ExecutionSummary> {
  const latest = new Map<string, ExecutionSummary>();
  for (const run of executions) if (!latest.has(run.workflowId)) latest.set(run.workflowId, run);
  return latest;
}

export type RunTone = 'success' | 'danger' | 'warning' | 'muted';

const STATE: Record<string, { label: string; tone: RunTone }> = {
  success: { label: 'Succeeded', tone: 'success' },
  error: { label: 'Failed', tone: 'danger' },
  running: { label: 'Running', tone: 'warning' },
  queued: { label: 'Queued', tone: 'muted' },
  waiting: { label: 'Waiting', tone: 'warning' },
  canceled: { label: 'Stopped', tone: 'muted' },
};

/** What a row says about its last run: "Failed", "Succeeded", … or "Not run yet" when there is none in the list. */
export function describeLastRun(run?: Pick<ExecutionSummary, 'status' | 'startedAt'>): { label: string; tone: RunTone; startedAt?: string } {
  if (!run) return { label: 'Not run yet', tone: 'muted' };
  const state = STATE[run.status as ExecutionState] ?? { label: String(run.status), tone: 'muted' as const };
  return { ...state, startedAt: run.startedAt };
}
