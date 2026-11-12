/**
 * The published agents and agent teams the caller can see, as Spotlight's chat and the AI flow builder read them
 * (docs/assistant.md#agents-and-teams): a step that needs an agent runs one of these when one fits.
 */
import { agentBrief, type AgentBrief } from '@/lib/shared/agent-brief';
import { teamBrief, type TeamBrief } from '@/lib/shared/agent-teams';
import { agentTeamStore } from '../agent-teams/store';
import { agentStore } from '../agents/store';
import { withOwnership } from '../projects';
import { routeActor } from '../projects/http';

/** At most this many of each go in a prompt. */
export const ROSTER_LIMIT = 30;

export function roster(): { agents: AgentBrief[]; teams: TeamBrief[] } {
  const actor = routeActor();
  const visibleTeams = new Set(withOwnership(actor, 'agentTeam', agentTeamStore.summaries()).map((t) => t.id));
  const teams = agentTeamStore
    .list()
    .filter((t) => visibleTeams.has(t.id))
    .flatMap((t) => teamBrief(t) ?? [])
    .slice(0, ROSTER_LIMIT);
  const all = agentStore.list();
  const visibleAgents = new Set(withOwnership(actor, 'agent', all.map((a) => ({ id: a.id }))).map((a) => a.id));
  const names = new Map(all.map((a) => [a.id, a.published?.config.name ?? a.name]));
  const agents = all
    .filter((a) => visibleAgents.has(a.id))
    .flatMap((a) => agentBrief(a, (id) => names.get(id)) ?? [])
    .slice(0, ROSTER_LIMIT);
  return { agents, teams };
}
