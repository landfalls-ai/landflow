/**
 * Sessions belong to a project (docs/projects-and-goals.md#sessions-belong-to-a-project): a session is read and continued
 * only from the project it ran in, and sharing an agent never shares its sessions. A session's project is the one its
 * run resolved (`session.context.projectId`), or the agent's home when the session has none (one saved before wave 7).
 * Plain server module: the session routes, the live feed and the readers of ratings and graded replies call these.
 */
import type { AgentSession, SessionSummary } from '../../shared/agents';
import { canResource, executionWorkflowId, isInstanceAdmin, projectRole, resourceAccess, type Actor } from '../projects/access';
import { getProject, homeProjectId } from '../projects/store';

/** What the rule needs of a session or its summary. */
export type SessionScoped = Pick<AgentSession, 'agentId'> & { projectId?: string; context?: { projectId?: string }; execution?: { executionId: string } };

/** The project a session belongs to: its own, else its agent's home now. Undefined only for an agent with no home. */
export function sessionProjectId(session: SessionScoped | SessionSummary): string | undefined {
  const scoped = session as SessionScoped;
  return scoped.context?.projectId ?? scoped.projectId ?? homeProjectId('agent', session.agentId);
}

/**
 * Who reads a session: instance owners and admins; anyone who can read the run that started it (a Run an Agent node's
 * panel); anyone with a role in its project who can also read the agent. A session of a deleted project: the first only.
 */
export function canReadSession(actor: Actor | undefined, session: SessionScoped | SessionSummary): boolean {
  if (!actor) return false;
  if (isInstanceAdmin(actor)) return true;
  const executionId = (session as SessionScoped).execution?.executionId;
  if (executionId) {
    const workflowId = executionWorkflowId(executionId);
    if (workflowId && canResource(actor, 'workflow', workflowId, 'read')) return true;
  }
  const projectId = sessionProjectId(session);
  if (!projectId || !getProject(projectId) || !projectRole(actor, projectId)) return false;
  return Boolean(resourceAccess(actor, 'agent', session.agentId));
}

/**
 * Who continues a session (a message, an approval, a rating or comment, a delete): who reads it and is an editor or
 * admin in its project. The route's guard still needs `run` on the agent.
 */
export function canContinueSession(actor: Actor | undefined, session: SessionScoped | SessionSummary): boolean {
  if (!actor || !canReadSession(actor, session)) return false;
  if (isInstanceAdmin(actor)) return true;
  const projectId = sessionProjectId(session);
  const role = projectRole(actor, projectId);
  return role === 'admin' || role === 'editor';
}

/** Whether `actor` reads `session` (a session that is gone, undefined, is readable only by instance admins). */
export function canReadSessionById(actor: Actor | undefined, session: SessionScoped | undefined): boolean {
  if (!session) return Boolean(actor && isInstanceAdmin(actor));
  return canReadSession(actor, session);
}
