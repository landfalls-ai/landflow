'use client';
/**
 * Who is in a Run a Team node's team, shown above the node on the canvas (docs/agent-teams.md): every member's face and
 * title, lead first and then each manager's reports in chart order, so a team on the canvas never hides its agents.
 */
import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { orgTree, type AgentTeam, type OrgNode, type TeamMember } from '@/lib/shared/agent-teams';
import type { AgentSummary } from '@/lib/shared/agents';
import { AgentAvatar, type AvatarSource } from '../agents/avatar';

// Loaded once per page: the canvas draws many nodes, and a team rarely changes while a flow is open.
const teams = new Map<string, Promise<AgentTeam | undefined>>();
let roster: Promise<AgentSummary[]> | undefined;

const loadTeam = (id: string) => {
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
const loadRoster = () =>
  (roster ??= api<{ agents: AgentSummary[] }>('/api/agents').then(
    (r) => r.agents ?? [],
    () => [],
  ));

const inChartOrder = (node: OrgNode): TeamMember[] => [node.member, ...node.reports.flatMap(inChartOrder)];

/** A Landflow agent wears its own face; a remote agent gets the A2A node's colour and radio icon. */
function faceOf(member: TeamMember, agents: AgentSummary[]): AvatarSource {
  const agent = member.kind === 'agent' ? agents.find((a) => a.id === member.agentId) : undefined;
  return agent ? { name: agent.name, icon: agent.icon, color: agent.color, avatar: agent.avatar } : { name: member.title, icon: 'lucide:radio-tower', color: '#a855f7' };
}

export function TeamStrip({ teamId }: { teamId: string }) {
  const [members, setMembers] = useState<Array<{ member: TeamMember; face: AvatarSource }>>();
  useEffect(() => {
    let live = true;
    void Promise.all([loadTeam(teamId), loadRoster()]).then(([team, agents]) => {
      if (!live || !team) return;
      const config = team.published ?? team.draft;
      const tree = orgTree(config);
      setMembers((tree ? inChartOrder(tree) : config.members).map((member) => ({ member, face: faceOf(member, agents) })));
    });
    return () => {
      live = false;
    };
  }, [teamId]);
  if (!members?.length) return null;
  return (
    <div className="flex max-w-[280px] items-center gap-1.5 rounded-full border border-hair bg-sf py-0.5 pl-0.5 pr-2.5 shadow-pop" title={members.map((m) => m.member.title).join(', ')}>
      <span className="flex">
        {members.slice(0, 6).map(({ member, face }, i) => (
          <AgentAvatar key={member.id} agent={face} size={20} round className={i ? '-ml-1.5 ring-2 ring-sf' : 'ring-2 ring-sf'} />
        ))}
      </span>
      <span className="truncate text-[11px] font-medium text-t2">
        {members.map((m, i) => (
          <span key={m.member.id}>
            {i ? ' · ' : ''}
            <span className={i ? undefined : 'font-semibold text-t1'}>{m.member.title}</span>
          </span>
        ))}
      </span>
    </div>
  );
}
