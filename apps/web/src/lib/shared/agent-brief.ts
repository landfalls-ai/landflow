/**
 * What Spotlight and the AI flow builder know about the caller's published agents (docs/assistant.md#agents and teams):
 * enough to tell whether one already does the job a step needs, so the flow runs that agent (Run an Agent) instead of a
 * new AI Agent, or Spotlight says a dedicated agent is needed and proposes one.
 */
import type { Agent } from './agents';

export interface AgentBrief {
  id: string;
  name: string;
  /** What it does: its description, else its persona's mission. */
  description?: string;
  /** The persona's role ("Editor for the docs team"). */
  role?: string;
  /** The team it belongs to on the Agents page. */
  team?: string;
  version: number;
  /** Skill names, each with its "use when". */
  skills: string[];
  /** What it can do: tool names, knowledge bases, MCP servers, the agents it asks. */
  tools: string[];
}

const clip = (value: string | undefined, max: number) => {
  const text = value?.replace(/\s+/g, ' ').trim();
  return text ? (text.length > max ? `${text.slice(0, max - 1)}…` : text) : undefined;
};

/** A published agent as Spotlight reads it; undefined for one never published (a flow can't run it yet). */
export function agentBrief(agent: Agent, nameOf: (id: string) => string | undefined = () => undefined): AgentBrief | undefined {
  const { published } = agent;
  if (!published) return undefined;
  const config = published.config;
  const description = clip(config.description, 200) ?? clip(config.persona?.mission, 200);
  const role = clip(config.persona?.role, 80);
  return {
    id: agent.id,
    name: config.name,
    ...(description && { description }),
    ...(role && { role }),
    ...(config.team && { team: config.team }),
    version: published.version,
    skills: config.skills.slice(0, 8).map((s) => (s.whenToUse ? `${s.name} (${clip(s.whenToUse, 80)})` : s.name)),
    tools: config.tools.slice(0, 12).map((t) => (t.type === 'agent' ? `asks ${nameOf(t.agentId) ?? 'another agent'}` : t.name)),
  };
}

/** The published agents as prompt text, one line each. */
export function describeAgents(agents: readonly AgentBrief[]): string {
  return agents
    .map((a) => {
      const parts = [
        `- “${a.name}” (agentId ${a.id}, v${a.version}${a.team ? `, team ${a.team}` : ''})${a.description ? `: ${a.description}` : ''}`,
        a.role && `Role: ${a.role}.`,
        a.skills.length && `Skills: ${a.skills.join('; ')}.`,
        a.tools.length && `Tools: ${a.tools.join(', ')}.`,
      ];
      return parts.filter(Boolean).join(' ');
    })
    .join('\n');
}

const agentKey = (value: string) => value.trim().toLowerCase().replace(/\s+agent$/, '');

/**
 * A Run an Agent node's parameters as a model wrote them: models put the agent's name where its id goes. A name that
 * matches one published agent becomes its id; anything else is left as written (the node then asks for an agent).
 */
export function withAgentId<T>(parameters: T, agents: readonly AgentBrief[]): T {
  if (!parameters || typeof parameters !== 'object' || !agents.length) return parameters;
  const p = parameters as Record<string, unknown>;
  const written = typeof p.agentId === 'string' ? p.agentId.trim() : '';
  if (!written || written.includes('{{') || agents.some((a) => a.id === written)) return parameters;
  const named = agents.filter((a) => agentKey(a.name) === agentKey(written));
  return named.length === 1 ? ({ ...p, agentId: named[0].id } as T) : parameters;
}
