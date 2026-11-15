/**
 * Tasks in Needs you (`GET /api/runs/needs-you`, appended by the route like the budget items): a run that waits for a
 * person's Approve (`requested`) or for a tool approval in the agent's session (`waiting`), for the editors and admins of
 * its project. A settled run leaves the list on the next read.
 */
import type { TaskNeedsYouFields } from '../../shared/project-tasks';
import { agentStore } from '../agents/store';
import { getUser } from '../auth/users';
import type { NeedsYouItem } from '../journal/needs-you';
import { projectRoleCan } from '../../shared/projects';
import { projectRole, visibleProjectIds, type Actor } from '../projects/access';
import { getProject } from '../projects/store';
import { reconcileRun } from './reconcile';
import { getTask, runsWith } from './store';
import { viewerOf } from './views';

export type TaskNeedsYouItem = NeedsYouItem & TaskNeedsYouFields;

const MAX_ITEMS = 200;

/** The projects where the actor may decide (their editor and admin ones); undefined: every project (instance admins). */
function editableProjectIds(actor: Actor): string[] | undefined {
  const visible = visibleProjectIds(actor);
  return visible && [...visible].filter((id) => projectRoleCan.create(projectRole(actor, id)));
}

/** `cap`: how many open runs of the actor's projects are read (a parameter so a test can lower it). */
export function taskItems(actor: Actor, cap = MAX_ITEMS): TaskNeedsYouItem[] {
  const agentNames = new Map<string, string>();
  const taskCache = new Map<string, ReturnType<typeof getTask>>();
  const editorIn = new Map<string, boolean>();
  const items: TaskNeedsYouItem[] = [];
  // Only the actor's own projects are read, so another project's open runs never push theirs past the cap; a run is
  // settled against its session only once the actor may see it.
  for (const open of runsWith(['requested', 'waiting'], cap, undefined, editableProjectIds(actor))) {
    const run = reconcileRun(open);
    if (run.status !== 'requested' && run.status !== 'waiting') continue; // settled just now
    let canEdit = editorIn.get(run.projectId);
    if (canEdit === undefined) {
      canEdit = Boolean(projectRole(actor, run.projectId) && viewerOf(actor, run.projectId)?.canEdit && getProject(run.projectId));
      editorIn.set(run.projectId, canEdit);
    }
    if (!canEdit) continue;
    if (!taskCache.has(run.taskId)) taskCache.set(run.taskId, getTask(run.taskId));
    const task = taskCache.get(run.taskId);
    if (!task) continue;
    if (!agentNames.has(run.agentId)) agentNames.set(run.agentId, agentStore.get(run.agentId)?.name ?? run.agentId);
    const agent = agentNames.get(run.agentId)!;
    const waiting = run.status === 'waiting';
    const detail = run.reason === 'wake' ? `Wake-up${task.wake ? ` (${task.wake.cron})` : ''}` : `Asked by ${(run.requestedBy && getUser(run.requestedBy)?.name) || 'someone'}`;
    items.push({
      executionId: '',
      workflowId: '',
      workflowName: '',
      kind: 'task',
      projectId: run.projectId,
      taskId: run.taskId,
      taskRunId: run.id,
      taskRunStatus: waiting ? 'waiting' : 'requested',
      title: waiting ? `“${agent}” waits for a tool approval on “${task.title}”` : `“${agent}” wants to work on “${task.title}”`,
      ...(!waiting && { detail }),
      href: waiting && run.sessionId ? `/agents/${run.agentId}?tab=sessions&session=${run.sessionId}` : `/projects/${run.projectId}?tab=tasks&task=${run.taskId}`,
      canDecide: !waiting,
      since: waiting ? (run.decidedAt ?? run.requestedAt) : run.requestedAt,
    });
  }
  return items;
}
