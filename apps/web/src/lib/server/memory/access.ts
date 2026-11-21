/**
 * Who may reach a container (C07 FR-3), checked before any read or write. A container the caller may not read answers
 * "not found", the same as one that does not exist. Reuses project, team and agent access (projects/access.ts), no rules of
 * its own.
 */
import { agentStore } from '../agents/store';
import { agentTeamStore } from '../agent-teams/store';
import { canResource, projectRole } from '../projects/access';
import { homeProjectId } from '../projects/store';
import { getProject } from '../projects/store';
import { projectRoleCan } from '../../shared/projects';
import type { MemoryContainer } from '../../shared/memory';
import { MemoryNotFoundError, type MemoryCaller } from './backend';

/** Throws `MemoryNotFoundError` unless `caller` may `read` (or `write`) the container; the container must exist. */
export function assertContainer(caller: MemoryCaller, container: MemoryContainer, action: 'read' | 'write'): void {
  if (!allowed(caller, container, action)) throw new MemoryNotFoundError();
}

function allowed(caller: MemoryCaller, c: MemoryContainer, action: 'read' | 'write'): boolean {
  const { actor } = caller;
  if (c.kind === 'project') {
    if (!getProject(c.id)) return false;
    if (actor) {
      const role = projectRole(actor, c.id);
      return action === 'read' ? role !== undefined : projectRoleCan.create(role);
    }
    return Boolean(caller.system && caller.projectId === c.id);
  }
  if (c.kind === 'team') {
    if (!agentTeamStore.get(c.id)) return false;
    if (actor) return canResource(actor, 'agentTeam', c.id, action === 'read' ? 'read' : 'update');
    return Boolean(caller.system && caller.projectId && homeProjectId('agentTeam', c.id) === caller.projectId);
  }
  // An agent's memory of one person: that person's, whatever their role; the agent's editors may read it (to help them).
  if (!agentStore.get(c.id)) return false;
  const who = actor?.id ?? caller.userId;
  if (who === c.userId) return caller.system ? caller.run?.agentId === c.id : true;
  return action === 'read' && Boolean(actor) && canResource(actor, 'agent', c.id, 'update');
}
