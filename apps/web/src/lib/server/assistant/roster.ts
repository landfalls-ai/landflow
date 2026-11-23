/**
 * The published agents and agent teams the caller can see, as Spotlight's chat and the AI flow builder read them
 * (docs/assistant.md#agents-and-teams): a step that needs an agent runs one of these when one fits.
 */
import { agentBrief, type AgentBrief } from '@/lib/shared/agent-brief';
import { teamBrief, type TeamBrief } from '@/lib/shared/agent-teams';
import { agentTeamStore } from '../agent-teams/store';
import { agentStore } from '../agents/store';
import { withOwnership } from '../projects';
import { catalogAgents } from './tenant-catalog';
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
  // AG18: drafts too, after the published ones (a flow can't run a draft yet; Spotlight can say it exists and reuse it once published)
  const visible = all.filter((a) => visibleAgents.has(a.id));
  const used = usedByCounts(actor);
  const brief = (a: (typeof all)[number]) => agentBrief(a, (id) => names.get(id), { drafts: true, usedBy: used.get(a.id) });
  const agents = [...visible.filter((a) => a.published), ...visible.filter((a) => !a.published)].flatMap((a) => brief(a) ?? []).slice(0, ROSTER_LIMIT);
  return { agents, teams };
}

/** AG18: how many workflows (the caller can read) run each agent, from the same rule the catalog uses. */
function usedByCounts(actor: ReturnType<typeof routeActor>): Map<string, number> {
  return new Map(catalogAgents(actor).map((a) => [a.id, a.usedBy.count]));
}
