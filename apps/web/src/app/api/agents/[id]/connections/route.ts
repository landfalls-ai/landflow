/**
 * GET /api/agents/:id/connections?workflowId=&nodeId= — what the agent is connected to, for the canvas's band on a Run an
 * Agent node (docs/agents.md#from-workflows): the same list the Run Trace shows (`agentConnections`), from the version the
 * node runs (the published one; the draft for an agent never published). With a workflow and a node, the project's
 * settings apply and the node's wired Chat Model and Memory are marked as replacing the agent's own, its wired tools listed
 * apart. Credentials come as names, never data. Read access is the agent's; a workflow the caller cannot read is a 404.
 */
import { z } from 'zod';
import { agentConnections, withDocumentCounts } from '@/lib/server/agents/connections';
import { agentStore, configOf } from '@/lib/server/agents/store';
import { error, handler, json, parseQuery } from '@/lib/server/http';
import { canResource } from '@/lib/server/projects/access';
import { routeActor } from '@/lib/server/projects/http';
import { homeProjectId } from '@/lib/server/projects/store';
import { projectAgentRules, type ProjectAgentRules } from '@/lib/server/project-context/project-settings';
import { store } from '@/lib/server/store';
import type { ActorConnection } from '@/lib/shared/run-trace';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** The same data whatever order the keys were written in (the draft's times and versions are not part of it). */
const canonical = (value: unknown): unknown => (Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, canonical(v)])) : value);

export const GET = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  const actor = routeActor();
  const agent = agentStore.get(id);
  if (!agent || !canResource(actor, 'agent', id, 'read')) return error('Agent not found', 404);
  const query = parseQuery(request, z.object({ workflowId: z.string().max(200).optional(), nodeId: z.string().max(200).optional() }));
  if (!query.ok) return query.response;
  const { workflowId, nodeId } = query.data;

  let project: ProjectAgentRules | undefined;
  const wired: { model?: string; memory?: string } = {};
  const wiredTools: ActorConnection[] = [];
  if (workflowId) {
    const workflow = store.getWorkflow(workflowId);
    if (!workflow || !canResource(actor, 'workflow', workflowId, 'read')) return error('Workflow not found', 404);
    project = projectAgentRules(homeProjectId('workflow', workflowId));
    // Only the named node's wired sub-nodes are read from the workflow.
    const nodes = new Map(workflow.nodes.map((n) => [n.id, n]));
    for (const c of nodeId ? workflow.connections ?? [] : []) {
      if (c.target !== nodeId || c.type === 'main') continue;
      const sub = nodes.get(c.source);
      if (!sub || sub.disabled) continue;
      if (c.type === 'ai_languageModel') wired.model = sub.name;
      else if (c.type === 'ai_memory') wired.memory = sub.name;
      else if (c.type === 'ai_tool') wiredTools.push({ kind: 'tool', name: sub.name, nodeType: sub.type, from: 'flow' });
    }
  }

  const config = agent.published?.config;
  const draftDiffers = Boolean(config) && JSON.stringify(canonical(configOf(agent))) !== JSON.stringify(canonical(configOf(config!)));
  const own = agentConnections(agent, {}, { ...(project && { project }), wired });
  const connections = [...(await withDocumentCounts(agent, own)), ...wiredTools];
  return json({
    agent: { id, name: (config ?? agent).name, published: Boolean(config), draftDiffers, icon: (config ?? agent).icon, color: (config ?? agent).color, ...((config ?? agent).avatar && { avatar: (config ?? agent).avatar }) },
    connections,
  });
});
