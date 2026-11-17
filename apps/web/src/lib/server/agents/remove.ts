/**
 * Removing an agent for good: its kagent resources, its drafts and versions, its test cases and runs, its caches. Shared by
 * DELETE /api/agents/:id and by Spotlight's take-back of an agent it made (DELETE /api/agents/design), which first asks
 * `agentUsedBy` whether anything else still uses it.
 */
import type { Workflow } from '@landflow/engine';
import { agentTeamStore } from '../agent-teams/store';
import { forgetDeleted } from '../projects/http';
import { rememberLeftover, removeFromKagent } from '../kagent/deploy';
import { getPublication, publishedVersionId } from '../publications';
import { store } from '../store';
import { logger } from '../telemetry';
import { getVersion } from '../versions';
import { deleteAgentEvals } from './eval-gate';
import { responseCache } from './response-cache';
import { semanticCache } from './semantic-cache';
import { agentStore } from './store';

/** Deletes the agent and everything kept for it. False when there was no such agent. */
export async function removeAgent(id: string): Promise<boolean> {
  // An agent deployed to kagent leaves it too. If kagent can't be reached, its resources are remembered and removed the
  // next time an agent is deployed to that cluster.
  const deployment = agentStore.get(id)?.kagent;
  if (deployment) {
    await removeFromKagent(id).catch((cause) => {
      logger.warn('kagent: a deleted agent’s resources could not be removed; they go when the cluster is reached', { agentId: id, error: (cause as Error).message });
      rememberLeftover(deployment, id);
    });
  }
  if (!agentStore.delete(id)) return false;
  deleteAgentEvals(id);
  responseCache.clear(id);
  semanticCache.clear(id);
  forgetDeleted('agent', id);
  return true;
}

const stepsUsing = (workflow: Workflow | undefined, agentId: string) => (workflow?.nodes ?? []).some((n) => n.parameters?.agentId === agentId);

/**
 * What else uses an agent, by name: a step of another workflow (its draft or its published version), a team, an enabled
 * schedule or channel, or a published version beyond the first (Spotlight's own pass publishes version 1 and no more). Empty
 * when nothing does.
 */
export function agentUsedBy(agentId: string, exceptWorkflowId?: string): string[] {
  const used: string[] = [];
  for (const workflow of store.listWorkflows()) {
    if (workflow.id === exceptWorkflowId) continue;
    let hit = stepsUsing(workflow, agentId);
    if (!hit && publishedVersionId(workflow.id)) {
      const published = getPublication(workflow.id);
      hit = Boolean(published && stepsUsing(getVersion(workflow.id, published.versionId)?.workflow, agentId));
    }
    if (hit) used.push(`the workflow “${workflow.name}”`);
  }
  for (const team of agentTeamStore.teamsOfAgent(agentId)) used.push(`the team “${team.name}”`);
  const agent = agentStore.get(agentId);
  const scheduled = [...(agent?.schedules ?? []), ...(agent?.published?.config.schedules ?? [])].some((s) => s.enabled);
  if (scheduled) used.push('a schedule of its own');
  const channelled = [...(agent?.channels ?? []), ...(agent?.published?.config.channels ?? [])].some((c) => c.enabled);
  if (channelled) used.push('a channel of its own');
  if (agent && ((agent.published?.version ?? 0) > 1 || agent.history.some((v) => v.version > 1))) used.push('a later published version');
  return used;
}
