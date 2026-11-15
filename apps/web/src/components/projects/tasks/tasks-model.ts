/** Project tasks as the screens show them: the order of the groups, the labels, the next wake-up, which field an error is about. Pure. */
import { TASK_STATUS_LABELS, type ProjectTaskView, type TaskRun, type TaskRunStatus, type TaskStatus } from '@/lib/shared/project-tasks';
import type { Tone } from '@/components/ui/badge';

/** The groups of the list, in the order the API sorts them (`tasks-api.md`). */
export const STATUS_GROUPS: readonly TaskStatus[] = ['in_progress', 'todo', 'blocked', 'done', 'cancelled'];
const PRIORITY_RANK = { high: 0, normal: 1, low: 2 } as const;

/** The server's order: status group, priority (high first), updated newest first, id. */
export function compareTasks(a: ProjectTaskView, b: ProjectTaskView): number {
  return (
    STATUS_GROUPS.indexOf(a.status) - STATUS_GROUPS.indexOf(b.status) ||
    PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
    Date.parse(b.updatedAt) - Date.parse(a.updatedAt) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** The rows under one heading each; empty groups are left out. The order inside a group is the sort above. */
export function groupTasks(tasks: ProjectTaskView[]): Array<{ status: TaskStatus; label: string; tasks: ProjectTaskView[] }> {
  const sorted = [...tasks].sort(compareTasks);
  return STATUS_GROUPS.flatMap((status) => {
    const list = sorted.filter((t) => t.status === status);
    return list.length ? [{ status, label: TASK_STATUS_LABELS[status], tasks: list }] : [];
  });
}

/** The newest run of a task (the API sends them newest first). */
export const lastRun = (task: Pick<ProjectTaskView, 'runs'>): TaskRun | undefined => task.runs[0];

export const RUN_LABELS: Record<TaskRunStatus, string> = {
  requested: 'Asked',
  approved: 'Approved',
  denied: 'Denied',
  running: 'Running',
  waiting: 'Waiting for a tool approval',
  done: 'Done',
  failed: 'Failed',
};
export const RUN_TONES: Record<TaskRunStatus, Tone> = { requested: 'warning', approved: 'accent', denied: 'muted', running: 'accent', waiting: 'warning', done: 'success', failed: 'danger' };

/** "in 3h", "in 2d", "soon": the time until an ISO instant. */
export function untilText(iso: string | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const seconds = Math.round((Date.parse(iso) - now) / 1000);
  if (seconds < 60) return 'soon';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

export type TaskField = 'assignee' | 'schedule' | 'goal' | 'title';

/** The field a server message (tasks-api.md, the 400 table) is about; undefined when it is about none. */
export function fieldOfError(message: string): TaskField | undefined {
  // Match the contract's fixed wording only: the messages carry agent, project and person names.
  if (/isn.t available in project|isn.t allowed in project|isn.t a member of this project/i.test(message)) return 'assignee';
  if (/^That goal isn.t one of/i.test(message)) return 'goal';
  if (/^Only an agent task has a wake-up schedule|^A wake-up schedule has five fields|^This schedule never fires/i.test(message)) return 'schedule';
  if (/^A task needs a title/i.test(message)) return 'title';
  return undefined;
}

/** The option the assignee select needs when the saved assignee is not among the loaded ones; undefined when it is listed. */
export function missingAssigneeOption(
  value: string,
  agents: { id: string }[],
  people: { id: string }[],
  assigneeName?: string,
): { value: string; label: string } | undefined {
  const picked = parseAssignee(value);
  if (!picked) return undefined;
  if ((picked.kind === 'agent' ? agents : people).some((o) => o.id === picked.id)) return undefined;
  return { value, label: assigneeName ?? (picked.kind === 'agent' ? 'Removed agent' : 'Removed person') };
}

/** The assignee select's value: "agent:<id>", "person:<id>" or "". */
export const assigneeValue = (a?: { kind: 'agent' | 'person'; id: string }) => (a ? `${a.kind}:${a.id}` : '');
export function parseAssignee(value: string): { kind: 'agent' | 'person'; id: string } | undefined {
  const at = value.indexOf(':');
  if (at < 0) return undefined;
  const kind = value.slice(0, at);
  return kind === 'agent' || kind === 'person' ? { kind, id: value.slice(at + 1) } : undefined;
}
