/**
 * "Turn into a team" (docs/agent-teams.md): a Run an Agent node with agents hanging under it as tools (A2A Agent nodes,
 * or Run an Agent nodes used as tools) is already a team in everything but name. This reads such a lead into a team (the
 * lead, and every delegating sub-node as a member reporting to it) and rewrites the graph so one Run a Team node stands
 * where the lead was, keeping the lead's model, memory and other tools and its main connections. Pure: the editor saves the
 * team and applies the rewritten graph as one undo step.
 */
import type { Workflow, WorkflowConnection, WorkflowNode } from '@landflow/engine';
import type { AgentTeamConfig, RemoteMember, TeamMember } from './agent-teams';

export const RUN_AGENT = 'core.messageAgent';
export const A2A_AGENT = 'core.a2aAgent';
export const RUN_TEAM = 'core.runTeam';

type Graph = Pick<Workflow, 'nodes' | 'connections'>;

/** An expression ("{{ … }}") can't name a team member's agent: the team needs a fixed one. */
const fixed = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '' && !value.includes('{{');

const isLead = (node: WorkflowNode | undefined): node is WorkflowNode => node?.type === RUN_AGENT && fixed(node.parameters.agentId);

/** The sub-nodes of `leadId` that are agents the lead delegates to: the members a team would have. */
export function delegatesOf(graph: Graph, leadId: string): WorkflowNode[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  return graph.connections
    .filter((c) => c.type === 'ai_tool' && c.target === leadId)
    .map((c) => byId.get(c.source))
    .filter((n): n is WorkflowNode => Boolean(n) && !n!.disabled && (n!.type === A2A_AGENT || (n!.type === RUN_AGENT && fixed(n!.parameters.agentId))))
    .filter((n, i, all) => all.indexOf(n) === i);
}

/** Why a node can't become a team, or undefined when it can. */
export function turnIntoTeamBlocker(graph: Graph, nodeId: string): string | undefined {
  const lead = graph.nodes.find((n) => n.id === nodeId);
  if (!lead) return 'That node is not here.';
  if (lead.type === RUN_TEAM) return 'It already runs a team.';
  if (lead.type !== RUN_AGENT) return 'Only a Run an Agent node can lead a team.';
  if (!isLead(lead)) return 'Pick the lead’s agent first: a team needs a fixed agent, not an expression.';
  if (!delegatesOf(graph, nodeId).length) return 'Nothing hangs under it to delegate to: add A2A Agent nodes (or Run an Agent nodes) as its tools.';
  return undefined;
}

export function canTurnIntoTeam(graph: Graph, nodeId: string): boolean {
  return turnIntoTeamBlocker(graph, nodeId) === undefined;
}

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

export interface TeamFromLead {
  team: AgentTeamConfig;
  /** The sub-nodes that became members, with the member each one is. */
  members: Array<{ nodeId: string; memberId: string }>;
}

/**
 * The team a lead and its delegating sub-nodes make: the lead at the top, every delegate reporting to it, titles from node
 * names (made different when two match), roles from the node's notes or tool description, parameters and credential
 * references kept as they are on the nodes.
 */
export function teamFromLead(graph: Graph, leadId: string, options: { newId?: () => string } = {}): TeamFromLead | { error: string } {
  const blocker = turnIntoTeamBlocker(graph, leadId);
  if (blocker) return { error: blocker };
  const lead = graph.nodes.find((n) => n.id === leadId)!;
  let counter = 0;
  const newId = options.newId ?? (() => `m_${Math.random().toString(36).slice(2, 8)}${(counter++).toString(36)}`);
  const taken = new Set<string>();
  const title = (name: string) => {
    let candidate = name.trim() || 'Member';
    for (let i = 2; taken.has(candidate.toLowerCase()); i++) candidate = `${name.trim() || 'Member'} ${i}`;
    taken.add(candidate.toLowerCase());
    return candidate;
  };
  const leadMember: TeamMember = {
    id: newId(),
    kind: 'agent',
    title: title(lead.name),
    agentId: String(lead.parameters.agentId),
  };
  const members: TeamFromLead['members'] = [];
  const list: TeamMember[] = [leadMember];
  for (const node of delegatesOf(graph, leadId)) {
    const base = {
      id: newId(),
      title: title(node.name),
      reportsTo: leadMember.id,
      ...(text(node.notes ?? node.parameters.toolDescription) && {
        role: text(node.notes ?? node.parameters.toolDescription),
      }),
    };
    if (node.type === RUN_AGENT)
      list.push({
        ...base,
        kind: 'agent',
        agentId: String(node.parameters.agentId),
      });
    else {
      const { agentUrl, authentication, options: nodeOptions } = node.parameters;
      const { questionsGoTo, ...kept } = (nodeOptions && typeof nodeOptions === 'object' ? nodeOptions : {}) as Record<string, unknown>;
      const remote: RemoteMember = {
        ...base,
        kind: 'a2a',
        parameters: {
          agentUrl: agentUrl ?? '',
          authentication: authentication ?? 'none',
          ...(Object.keys(kept).length && { options: kept }),
        },
        ...(node.credentials &&
          Object.keys(node.credentials).length && {
            credentials: { ...node.credentials },
          }),
        questionsTo: questionsGoTo === 'person' ? 'person' : 'manager',
      };
      list.push(remote);
    }
    members.push({ nodeId: node.id, memberId: base.id });
  }
  return { team: { name: `${lead.name} team`, members: list }, members };
}

/**
 * The graph with one Run a Team node where the lead was (same id, name, place and notes, so main connections and `$('…')`
 * references hold), the member sub-nodes gone with their connections, and the lead's other sub-nodes (chat model, memory,
 * tools that don't delegate) still connected to it.
 */
export function replaceWithTeam<W extends Graph>(workflow: W, leadId: string, memberNodeIds: string[], team: { id: string; name: string }): W {
  const drop = new Set(memberNodeIds);
  const lead = workflow.nodes.find((n) => n.id === leadId);
  if (!lead) return workflow;
  const { agentId: _agent, conversation: _conversation, sessionKey: _session, ...kept } = lead.parameters;
  const node: WorkflowNode = {
    ...lead,
    type: RUN_TEAM,
    typeVersion: 1,
    parameters: {
      ...kept,
      teamId: team.id,
      teamName: team.name,
      message: lead.parameters.message ?? '{{ $json.chatInput ?? $json.text }}',
      version: 'published',
    },
  };
  return {
    ...workflow,
    nodes: workflow.nodes.filter((n) => !drop.has(n.id)).map((n) => (n.id === leadId ? node : n)),
    connections: workflow.connections.filter((c: WorkflowConnection) => !drop.has(c.source) && !drop.has(c.target)),
  };
}
