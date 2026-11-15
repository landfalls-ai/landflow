/**
 * A task's run after a person decides it (docs/projects-and-goals.md#tasks). Approve re-checks the agent against the
 * project, then starts the agent in the background through `runAgent` with the task's project in its context: that is
 * how the run gets the allow-list, the tool kinds and the budget every other run in the project gets. Nothing here calls
 * a model or a tool.
 */
import type { Agent } from '../../shared/agents';
import type { ProjectTask, TaskRun } from '../../shared/project-tasks';
import { newSession, runAgent } from '../agents/runtime';
import { agentStore } from '../agents/store';
import { recordAudit } from '../audit';
import { outsideRequest } from '../auth/context';
import { logger } from '../telemetry/logger';
import { cut, lastReply, reconcileRun, sessionProblem } from './reconcile';
import { requireEditor } from './service';
import { decideRun, getRun, getTask, patchRun, TaskError } from './store';
import { agentProblem, viewerOf } from './views';
import { getProject } from '../projects/store';
import type { Actor } from '../projects/access';

/** What the agent is asked: the task in plain words. */
export function taskMessage(task: Pick<ProjectTask, 'title' | 'description' | 'status' | 'priority'>): string {
  return [`Task: ${task.title}`, ...(task.description ? ['', task.description] : []), '', `Status: ${task.status}. Priority: ${task.priority}.`, '', 'Reply with what you did and anything a person must decide.'].join('\n');
}

const REASON_TEXT: Record<string, string> = {
  budget: 'The run reached its token budget',
  max_iterations: 'The run reached its step limit',
  canceled: 'The run was canceled',
  error: 'The run failed',
};

/** GET /api/task-runs/:id for someone with a role in the run's project (404 otherwise). */
export function readRun(actor: Actor, runId: string): TaskRun {
  const run = getRun(runId);
  if (!run || !viewerOf(actor, run.projectId)) throw new TaskError('Run not found', 404);
  return reconcileRun(run);
}

/**
 * POST /api/task-runs/:id: only a `requested` run moves. Approve re-checks, at this moment, that the agent exists, is
 * published, is available in the project and is allowed by its rules (409 and the run stays `requested`), then answers
 * with the `approved` run and starts the agent outside the request. Deny settles it; nothing runs.
 */
export function decide(actor: Actor, runId: string, decision: 'approve' | 'deny'): TaskRun {
  const found = getRun(runId);
  const viewer = found && viewerOf(actor, found.projectId);
  if (!found || !viewer) throw new TaskError('Run not found', 404);
  requireEditor(viewer);
  const project = getProject(found.projectId);
  const run = decideRun(runId, decision, actor.id, (current) => {
    if (decision !== 'approve') return;
    const agent = agentStore.get(current.agentId);
    if (!agent) throw new TaskError('That agent no longer exists', 409);
    const name = agent.published?.config.name ?? agent.name;
    if (!agent.published) throw new TaskError(`Publish “${name}” before it works on tasks`, 409);
    const problem = agentProblem(agent.id, { id: current.projectId, name: project?.name ?? current.projectId });
    if (problem) throw new TaskError(problem, 409);
    const task = getTask(current.taskId);
    if (!task || task.assignee?.kind !== 'agent' || task.assignee.id !== agent.id) throw new TaskError('The task is no longer assigned to this agent', 409);
  });
  if (!run) throw new TaskError('Run not found', 404);
  const task = getTask(run.taskId);
  recordAudit({ action: 'project.task.run_decided', target: { type: 'task', id: run.taskId, name: task?.title }, project: run.projectId, summary: `${decision === 'approve' ? 'Approved' : 'Denied'} a run of “${task?.title ?? run.taskId}”`, details: { decision, taskId: run.taskId, agentId: run.agentId, runId: run.id } });
  if (decision === 'approve') {
    // The run belongs to no request: it must not run as the person who clicked (their tools run for them, through `caller`).
    outsideRequest(() => {
      void startRun(run.id).catch((error: Error) => {
        logger.warn('a task run could not start', { 'landflow.task.run.id': run.id, error });
        patchRun(run.id, { status: 'failed', error: cut(error.message), finishedAt: new Date().toISOString() });
      });
    });
  }
  return run;
}

/** Run an approved task through the agent runtime and settle the run with how it ended. */
export async function startRun(runId: string): Promise<void> {
  const run = getRun(runId);
  const task = run && getTask(run.taskId);
  const agent: Agent | undefined = run && agentStore.get(run.agentId);
  if (!run || !task || !agent?.published) {
    if (run) patchRun(run.id, { status: 'failed', error: 'The agent or the task is gone', finishedAt: new Date().toISOString() });
    return;
  }
  const session = newSession(agent, { source: 'task', userId: `task:${task.id}`, version: agent.published.version, title: task.title.slice(0, 80) });
  patchRun(run.id, { status: 'running', sessionId: session.id });
  const startedBy = run.decidedBy;
  try {
    const result = await runAgent({
      agent,
      session,
      message: taskMessage(task),
      approvals: 'ask', // a tool that needs approval waits in the session
      rootTrace: true,
      ...(startedBy && { caller: { startedBy } }), // the workflows its tools start run for the approver
      context: { caller: 'task', projectId: task.projectId, ...(task.goalId && { goalId: task.goalId }), agentId: agent.id, nodeName: task.title },
    });
    const at = new Date().toISOString();
    if (result.reason === 'completed') patchRun(run.id, { status: 'done', reply: cut(result.reply ?? lastReply(result.session) ?? ''), finishedAt: at });
    else if (result.reason === 'awaiting_approval') patchRun(run.id, { status: 'waiting' });
    else patchRun(run.id, { status: 'failed', error: cut(sessionProblem(result.session) ?? REASON_TEXT[result.reason] ?? 'The run failed'), finishedAt: at });
  } catch (error) {
    patchRun(run.id, { status: 'failed', error: cut((error as Error).message || 'The run failed'), finishedAt: new Date().toISOString() });
  }
}

