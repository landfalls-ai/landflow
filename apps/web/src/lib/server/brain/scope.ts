/**
 * Who sees what of the brain (docs/second-brain.md#principles, "projects stay walls"): a person sees the usage, facts and
 * suggestions of the workflows and agents they can open; owners and admins see everything, including what spans
 * projects (node types, credentials, the instance). A workflow that reads usage (Landflow Usage, On Usage Event) sees
 * what the person who created it sees; a workflow nobody created (seeded) and an agent's tools see their own project.
 */
import { agentStore } from '../agents/store';
import { getUser } from '../auth/users';
import { canResource, isInstanceAdmin, visibleIds } from '../projects/access';
import { homeProjectId, resourceIdsIn } from '../projects/store';
import type { Actor } from '../projects/access';
import { store } from '../store';
import type { UsageScope } from '../usage/query';
import type { Proposal } from '../../shared/brain';

export function scopeForActor(actor: Actor): UsageScope | undefined {
  const workflows = visibleIds(actor, 'workflow', store.listWorkflows().map((w) => w.id));
  const agents = visibleIds(actor, 'agent', agentStore.list().map((a) => a.id));
  return workflows || agents ? { workflows: workflows ?? new Set(), agents: agents ?? new Set() } : undefined;
}

export function scopeForWorkflow(workflowId: string | undefined): UsageScope | undefined {
  // An agent's node tools run as `agent:<id>`: the agent sees its own project.
  if (workflowId?.startsWith('agent:')) {
    const projectId = homeProjectId('agent', workflowId.slice('agent:'.length));
    if (!projectId) return { workflows: new Set(), agents: new Set([workflowId.slice('agent:'.length)]) };
    return { workflows: new Set(resourceIdsIn(projectId, 'workflow')), agents: new Set(resourceIdsIn(projectId, 'agent')) };
  }
  const workflow = workflowId ? store.getWorkflow(workflowId) : undefined;
  const creator = workflow?.createdBy ? getUser(workflow.createdBy) : undefined;
  if (creator) return scopeForActor(creator as Actor);
  const projectId = workflowId ? homeProjectId('workflow', workflowId) : undefined;
  if (!projectId) return { workflows: new Set(workflowId ? [workflowId] : []), agents: new Set() };
  return { workflows: new Set(resourceIdsIn(projectId, 'workflow')), agents: new Set(resourceIdsIn(projectId, 'agent')) };
}

/** Whether `scope` covers an event or suggestion about this workflow or agent (undefined scope: everything). */
export function covers(scope: UsageScope | undefined, subject: { workflowId?: string; agentId?: string }): boolean {
  if (!scope) return true;
  if (subject.workflowId) return Boolean(scope.workflows?.has(subject.workflowId));
  if (subject.agentId) return Boolean(scope.agents?.has(subject.agentId));
  return false;
}

/** The projects whose `landflow-brain-<project>` collections `scope` may search (undefined: all). */
export function projectsOf(scope: UsageScope | undefined): Set<string> | undefined {
  if (!scope) return undefined;
  const projects = new Set<string>();
  for (const id of scope.workflows ?? []) {
    const project = homeProjectId('workflow', id);
    if (project) projects.add(project);
  }
  for (const id of scope.agents ?? []) {
    const project = homeProjectId('agent', id);
    if (project) projects.add(project);
  }
  return projects;
}

/** Whether `actor` may see a suggestion (`read`) or decide it (`update`): its workflow's or agent's access; owners and admins for the rest. */
export function canProposal(actor: Actor, proposal: Pick<Proposal, 'target'>, action: 'read' | 'update'): boolean {
  const { type, id } = proposal.target;
  if (type === 'workflow' && id) return canResource(actor, 'workflow', id, action);
  if (type === 'agent' && id) return canResource(actor, 'agent', id, action);
  return isInstanceAdmin(actor);
}
