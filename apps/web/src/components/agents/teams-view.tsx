'use client';
/** The Teams view of the Agents page (docs/agent-teams.md): a card per team with its name, goal and status. */
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Network, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import type { TeamSummary } from '@/lib/shared/agent-teams';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { EmptyState } from '../ui/empty-state';
import { Card } from '../shell/page-header';

/** New team: makes an untitled team and opens it. The Agents page's header shows it on the Teams tab. */
export function useNewTeam() {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
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
  return { create, creating };
}

export function NewTeamButton({ className }: { className?: string }) {
  const { create, creating } = useNewTeam();
  return (
    <Button variant="primary" size="sm" loading={creating} onClick={() => void create()} className={className}>
      {!creating && <Plus className="size-3.5" strokeWidth={2} />} New team
    </Button>
  );
}

export function TeamsView({ teams }: { teams?: TeamSummary[] }) {
  const { create, creating } = useNewTeam();

  if (!teams) return <div className="h-[150px] animate-pulse-soft rounded-2xl border border-hair bg-sf" />;
  if (!teams.length) {
    return (
      <Card className="py-6">
        <EmptyState
          icon={<Network />}
          title="Put agents together as a team"
          hint="A team has a lead, members who report to it and reviewers who sign off the work. A flow runs the whole team on one request."
          action={
            <Button loading={creating} onClick={() => void create()}>
              {!creating && <Plus className="size-3.5" strokeWidth={2} />} New team
            </Button>
          }
        />
      </Card>
    );
  }
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
      {teams.map((team) => (
        <Link key={team.id} href={`/agents/teams/${team.id}`} className="flex flex-col gap-3 rounded-2xl border border-hair bg-sf p-4 transition-colors hover:border-bd focus-visible:outline-2 focus-visible:outline-ac">
          <div className="min-w-0">
            <div className="truncate text-[14px] font-semibold text-t1">{team.name}</div>
            <p className="mt-0.5 line-clamp-2 min-h-[2.4em] text-[12px] leading-snug text-t2">{team.goal || 'No goal yet'}</p>
          </div>
          <div className="mt-auto flex flex-wrap items-center gap-1.5">
            {team.published ? <Badge tone="success">Published v{team.published.version}</Badge> : <Badge tone="muted">Draft</Badge>}
            {(team.issues ?? 0) > 0 && <Badge tone="warning">{team.issues} to fix</Badge>}
          </div>
        </Link>
      ))}
    </div>
  );
}
