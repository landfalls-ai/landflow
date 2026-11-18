/**
 * AG21: what Spotlight's publish tools answer (lib/server/assistant/chat.ts) and the instance MCP server's
 * `list_agent_updates` (lib/server/mcp/instance-tools.ts): the agents a production workflow has newer versions of, and the
 * card that offers to publish the draft or to test and publish an update. Nothing here publishes: the card's buttons do.
 * Names and numbers only: no prompt, no credential.
 */
import { availableLine, pinsDiffer, type AgentUpdate, type PublishOffer } from '../../shared/agent-versions';
import { agentUpdates, blocks, pinsFor, pinsToSet, repinned } from '../agents/versions';
import { getPublication } from '../publications';
import { withAccess } from '../publish';
import { store } from '../store';
import { listVersions, versionFor } from '../versions';

export interface AgentUpdatesAnswer {
  updates: Array<AgentUpdate & { line: string }>;
}

/** The updates for a workflow, or (with `agentId`) the production workflows that pin an older version of that agent; `visible` keeps out workflows the caller may not read. */
export function listAgentUpdates(scope: { workflowId: string } | { agentId: string }, visible: (workflowId: string) => boolean = () => true): AgentUpdatesAnswer {
  return { updates: agentUpdates(scope).filter((u) => visible(u.workflowId)).map((u) => ({ ...u, line: availableLine(u) })) };
}

const newestNumber = (workflowId: string) => listVersions(workflowId)[0]?.number ?? 0;

/** Publish the editor's draft: what it would pin and what stops it. */
export function draftOffer(workflowId: string, by?: string): PublishOffer | undefined {
  const workflow = store.getWorkflow(workflowId);
  if (!workflow) return undefined;
  const pins = pinsToSet(workflow);
  const stopping = withAccess(blocks(workflow), by);
  const version = versionFor(workflow);
  const existing = version ? pinsFor(version.id) : [];
  // The draft's version is published as it is when it has no pins or the same ones; otherwise a new version is recorded.
  const nextVersion = version && (!existing.length || !pinsDiffer(existing, pins)) ? version.number : newestNumber(workflowId) + 1;
  return { workflowId, kind: 'draft', nextVersion, pins, ...(stopping.length && { blocks: stopping }) };
}

/** Test, then publish, the production version's graph with these agents at their latest published versions. */
export function updateOffer(workflowId: string, agentIds: readonly string[]): PublishOffer | string {
  const production = getPublication(workflowId);
  if (!production) return 'This workflow is not published, so there is no production version to update. Offer to publish the draft instead.';
  const updates = agentUpdates({ workflowId }).filter((u) => agentIds.includes(u.agentId));
  if (!updates.length) return 'Production already runs the latest published version of those agents: nothing to update.';
  const pins = repinned(pinsFor(production.versionId), updates.map((u) => u.agentId)).map((p) => ({ ...p, agentName: p.agentName ?? updates.find((u) => u.agentId === p.agentId)?.agentName }));
  return { workflowId, kind: 'update', nextVersion: newestNumber(workflowId) + 1, pins, updates };
}
