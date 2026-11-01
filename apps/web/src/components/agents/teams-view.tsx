'use client';
/** The Teams view of the Agents page (docs/agent-teams.md): a card per team with its goal, lead, member faces and published version. */
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Network, Plus, RadioTower } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import type { AgentSummary } from '@/lib/shared/agents';
import type { TeamSummary } from '@/lib/shared/agent-teams';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { AgentAvatar } from './avatar';

const FACES = 5;

export function TeamsView({ teams, agents }: { teams?: TeamSummary[]; agents: AgentSummary[] }) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const byId = new Map(agents.map((a) => [a.id, a]));

  const create = async () => {
    setCreating(true);
    try {
      const { team } = await api<{ team: { id: string } }>('/api/agent-teams', { method: 'POST', json: { name: 'Untitled team' } });
      router.push(`/agents/teams/${team.id}`);
    } catch (e) {
      toast.error((e as Error).message);
      setCreating(false);
    }
  };

  if (!teams) return <div className="h-[150px] animate-pulse-soft rounded-2xl border border-hair bg-sf" />;
  if (!teams.length) {
    return (
      <div className="mx-auto mt-6 flex max-w-[460px] flex-col items-center text-center">
        <span className="grid size-16 place-items-center rounded-[22px] border border-acbd bg-acdim text-ac">
          <Network className="size-8" strokeWidth={1.5} />
        </span>
        <h2 className="mt-5 text-[20px] font-semibold tracking-[-0.01em] text-t1">Put agents together as a team</h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-t2">A team has a lead, members who report to it and reviewers who sign off the work. A flow runs the whole team on one request.</p>
        <Button variant="primary" className="mt-5" loading={creating} onClick={() => void create()}>
          <Plus className="size-3.5" strokeWidth={2} /> New team
        </Button>
      </div>
    );
  }
  return (
    <>
      <div className="mb-4 flex justify-end">
        <Button variant="primary" size="sm" loading={creating} onClick={() => void create()}>
          <Plus className="size-3.5" strokeWidth={2} /> New team
        </Button>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
        {teams.map((team) => {
          const members = (team.agentIds ?? []).map((id) => byId.get(id)).filter((a): a is AgentSummary => Boolean(a));
          return (
            <Link key={team.id} href={`/agents/teams/${team.id}`} className="flex flex-col gap-3 rounded-2xl border border-hair bg-sf p-4 transition-colors hover:border-bd focus-visible:outline-2 focus-visible:outline-ac">
              <div className="min-w-0">
                <div className="truncate text-[14px] font-semibold text-t1">{team.name}</div>
                <p className="mt-0.5 line-clamp-2 min-h-[2.4em] text-[12px] leading-snug text-t2">{team.goal || 'No goal yet'}</p>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex -space-x-2">
                  {members.slice(0, FACES).map((a) => (
                    <AgentAvatar key={a.id} agent={a} size={28} round className="ring-2 ring-[var(--sf,transparent)]" />
                  ))}
                  {(team.remote ?? 0) > 0 && (
                    <span title="Remote agents" className="grid size-7 place-items-center rounded-full border border-hair bg-wl text-t3">
                      <RadioTower className="size-3.5" />
                    </span>
                  )}
                </div>
                <span className="text-[12px] text-t3">
                  {team.members} {team.members === 1 ? 'member' : 'members'}
                  {team.lead && <> · Lead: {team.lead}</>}
                </span>
              </div>
              <div className="mt-auto flex flex-wrap items-center gap-1.5 border-t border-hair pt-2">
                {team.published ? <Badge tone="success">Published v{team.published.version}</Badge> : <Badge tone="muted">Draft</Badge>}
                {(team.issues ?? 0) > 0 && <Badge tone="warning">{team.issues} to fix</Badge>}
                <span className="ml-auto text-[11px] tabular-nums text-t3">{timeAgo(team.updatedAt)}</span>
              </div>
            </Link>
          );
        })}
      </div>
    </>
  );
}
