/**
 * GET /api/agents/:id/connections?workflowId=&nodeId= — what the agent is connected to, for the canvas's bubbles on a Run an
 * Agent node (docs/agents.md#from-workflows): the same list the Run Trace shows (`agentConnections`), from the version the
 * node runs (the published one; the draft for an agent never published). With a workflow and a node, the project's
 * settings apply and the node's wired Chat Model and Memory are marked as replacing the agent's own, its wired tools listed
 * apart. AG16 adds `draft` (the draft's own list, when it differs from the published one; a node tool that lacks a required
 * credential is `credential: 'missing'`) and `usedBy` (the workflows the caller can read that run the agent). Credentials come as names, never data. Read access is the agent's; a workflow the caller cannot read is a 404.
 */
import { z } from 'zod';
import { isPropertyVisible, withPropertyDefaults } from '@landflow/protocol'; // AG16:
import { agentTeamStore } from '@/lib/server/agent-teams/store'; // AG16:
import { registry } from '@/lib/server/plugins/registry'; // AG16:
import { rootOf } from '@/lib/shared/agent-teams'; // AG16:
import type { Agent, NodeToolConfig } from '@/lib/shared/agents'; // AG16:
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

/**
 * AG16: the tool ids of a config whose node needs a credential nobody picked (the smoke test's rule): the bubble says
 * "needs a credential", the person picks it on the agent's page. The connection then carries `credential: 'missing'`.
 */
function lackingCredential(config: { tools?: unknown[] }): Set<string> {
  const out = new Set<string>();
  for (const raw of config.tools ?? []) {
    const tool = raw as NodeToolConfig;
    if (tool.type !== 'node') continue;
    const resolved = registry.resolve(tool.nodeType);
    if ('error' in resolved) continue;
    const parameters = withPropertyDefaults(resolved.descriptor.properties, tool.parameters);
    if ((resolved.descriptor.credentials ?? []).some((c) => c.required && isPropertyVisible(c, parameters) && !tool.credentials?.[c.name])) out.add(tool.id);
  }
  return out;
}

/** AG16: the connections of one config (the published one, or the draft), the document counts read and the missing credentials marked. */
async function connectionsOf(agent: Agent, options: Parameters<typeof agentConnections>[2]): Promise<ActorConnection[]> {
  const config = agent.published?.config ?? agent;
  const lacking = lackingCredential(config);
  const list = await withDocumentCounts(agent, agentConnections(agent, {}, options));
  return lacking.size ? list.map((c) => (c.toolId && lacking.has(c.toolId) && !c.credential ? { ...c, credential: 'missing' } : c)) : list;
}

/** AG16: the workflows the caller can read whose Run an Agent node runs this agent (or whose Run a Team node's lead it is). */
function workflowsRunning(actor: ReturnType<typeof routeActor>, agentId: string): Array<{ workflowId: string; name: string }> {
  const lead = (teamId: unknown) => {
    const team = typeof teamId === 'string' && teamId ? agentTeamStore.get(teamId) : undefined;
    const root = team && rootOf(team.published ?? team.draft);
    return root?.kind === 'agent' ? root.agentId : undefined;
  };
  const out: Array<{ workflowId: string; name: string }> = [];
  for (const w of store.listWorkflows()) {
    const runs = w.nodes.some((n) => (n.type === 'core.messageAgent' && n.parameters?.agentId === agentId) || (n.type === 'core.runTeam' && lead(n.parameters?.teamId) === agentId));
    if (runs && canResource(actor, 'workflow', w.id, 'read')) out.push({ workflowId: w.id, name: w.name });
  }
  return out;
}

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
  const options = { ...(project && { project }), wired };
  const connections = [...(await connectionsOf(agent, options)), ...wiredTools];
  // AG16: the draft's own connections when it differs from what is published (the bubbles show the draft, marked against the published one), and who runs the agent.
  const draft = draftDiffers ? await connectionsOf({ ...agent, published: undefined }, options) : undefined;
  return json({
    ...(draft && { draft }),
    usedBy: workflowsRunning(actor, id),
    agent: { id, name: (config ?? agent).name, published: Boolean(config), draftDiffers, icon: (config ?? agent).icon, color: (config ?? agent).color, ...((config ?? agent).avatar && { avatar: (config ?? agent).avatar }) },
    connections,
  });
});
