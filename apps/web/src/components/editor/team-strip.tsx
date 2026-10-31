'use client';
/**
 * Who is in a Run a Team node's team, shown above the node on the canvas (docs/agent-teams.md): every member's face and
 * title, lead first and then each manager's reports in chart order, so a team on the canvas never hides its agents.
 */
import { useEffect, useState } from 'react';
import { memberAgent, orgTree, type OrgNode, type TeamMember } from '@/lib/shared/agent-teams';
import type { AgentSummary } from '@/lib/shared/agents';
import { AgentAvatar, type AvatarSource } from '../agents/avatar';
import { faceOf as agentFace, loadRoster, loadTeam } from '../agents/faces';

const inChartOrder = (node: OrgNode): TeamMember[] => [node.member, ...node.reports.flatMap(inChartOrder)];

/** A Landflow agent wears its own face, also when it is called on kagent; another remote agent gets the A2A node's colour and radio icon. */
function faceOf(member: TeamMember, agents: AgentSummary[]): AvatarSource {
  const agent = memberAgent(member, agents);
  return agent ? agentFace(agent) : { name: member.title, icon: 'lucide:radio-tower', color: '#a855f7' };
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
