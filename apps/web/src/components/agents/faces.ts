'use client';
/**
 * Whose face a node, a team member or a run's actor wears (docs/agents.md#avatars): the Landflow agent behind it, found
 * by id, by the kagent deployment a remote address names (`memberAgent`), or by name. The roster and teams load once
 * per page and are shared: a canvas draws many nodes, and agents rarely change while a page is open.
 */
import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { memberAgent, rootOf, deploymentOf, type AgentTeam } from '@/lib/shared/agent-teams';
import type { AgentSummary } from '@/lib/shared/agents';
import type { RunActor } from '@/lib/shared/run-trace';
import type { AvatarSource } from './avatar';

const teams = new Map<string, Promise<AgentTeam | undefined>>();
let roster: Promise<AgentSummary[]> | undefined;

export const loadTeam = (id: string) => {
  if (!teams.has(id))
    teams.set(
      id,
      api<{ team: AgentTeam }>(`/api/agent-teams/${encodeURIComponent(id)}`).then(
        (r) => r.team,
        () => undefined,
      ),
    );
  return teams.get(id)!;
};

export const loadRoster = () =>
  (roster ??= api<{ agents: AgentSummary[] }>('/api/agents').then(
    (r) => r.agents ?? [],
    () => [],
  ));

/** The lead's agent of every Run a Team node in `nodes`, by team id (filled in as the teams load). */
export function useTeamLeads(nodes: ReadonlyArray<{ type: string; parameters?: Record<string, unknown> }> | undefined): Record<string, string> {
  const ids = [...new Set((nodes ?? []).flatMap((n) => (n.type === 'core.runTeam' && typeof n.parameters?.teamId === 'string' && n.parameters.teamId ? [n.parameters.teamId] : [])))].sort().join(',');
  const [leads, setLeads] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!ids) return;
    let live = true;
    void Promise.all(ids.split(',').map(async (id) => [id, await loadTeam(id)] as const)).then((teams) => {
      if (!live) return;
      const found: Record<string, string> = {};
      for (const [id, team] of teams) {
        const lead = team && rootOf(team.published ?? team.draft);
        if (lead?.kind === 'agent') found[id] = lead.agentId;
      }
      setLeads(found);
    });
    return () => {
      live = false;
    };
  }, [ids]);
  return leads;
}

/** The roster, once loaded (undefined until then). */
export function useRoster(): AgentSummary[] | undefined {
  const [agents, setAgents] = useState<AgentSummary[]>();
  useEffect(() => {
    let live = true;
    void loadRoster().then((list) => live && setAgents(list));
    return () => {
      live = false;
    };
  }, []);
  return agents;
}

export const faceOf = (agent: AgentSummary): AvatarSource => ({ name: agent.name, icon: agent.icon, color: agent.color, avatar: agent.avatar });

/**
 * The agent a node stands for: Run an Agent's agent, a Run a Team node's lead, or the agent an A2A Agent node calls on
 * kagent. Other nodes keep their icon (undefined).
 */
export function useNodeFace(type: string, parameters: Record<string, unknown>): AvatarSource | undefined {
  const agentId = type === 'core.messageAgent' && typeof parameters.agentId === 'string' && !parameters.agentId.includes('{{') ? parameters.agentId : '';
  const teamId = type === 'core.runTeam' && typeof parameters.teamId === 'string' ? parameters.teamId : '';
  const deployment = type === 'core.a2aAgent' ? (deploymentOf(parameters.agentUrl) ?? '') : '';
  const [face, setFace] = useState<AvatarSource>();
  useEffect(() => {
    if (!agentId && !teamId && !deployment) return setFace(undefined);
    let live = true;
    void Promise.all([loadRoster(), teamId ? loadTeam(teamId) : undefined]).then(([agents, team]) => {
      if (!live) return;
      const config = team?.published ?? team?.draft;
      const lead = config && rootOf(config);
      const agent = agentId
        ? agents.find((a) => a.id === agentId)
        : lead
          ? memberAgent(lead, agents)
          : deployment
            ? agents.find((a) => a.kagent === deployment)
            : undefined;
      setFace(agent ? faceOf(agent) : undefined);
    });
    return () => {
      live = false;
    };
  }, [agentId, teamId, deployment]);
  return face;
}

const sameName = (a: string, b: string) => a.trim().toLowerCase().replace(/[\s_]+/g, '-') === b.trim().toLowerCase().replace(/[\s_]+/g, '-');

/**
 * The Landflow agent a run's actor is: `agent:<id>`, or an agent recorded by name (a remote agent, an agent node in an
 * older run) named like an agent or its kagent deployment. kagent names an agent's card with underscores
 * (`landflow_planner` for `landflow-planner`), so names match whatever their separators.
 */
export function actorAgent(actor: RunActor | undefined, agents: readonly AgentSummary[] | undefined): AgentSummary | undefined {
  if (!actor || !agents || actor.type !== 'agent') return undefined;
  if (actor.id.startsWith('agent:')) return agents.find((a) => a.id === actor.id.slice(6));
  return agents.find((a) => (a.kagent && sameName(a.kagent, actor.name)) || sameName(a.name, actor.name));
}
