'use client';
/**
 * Who is in a Run a Team node's team, shown above the node on the canvases (docs/agent-teams.md): every member's face and
 * title, lead first and then each manager's reports in chart order, so a team on the canvas never hides its agents.
 * While the team runs the node itself shows the member at work (team-live.tsx), and the strip becomes its roster: faces
 * only, with each member's state, under the moments that matter.
 */
import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import type { TeamProgress } from '@/lib/shared/team-progress';
import { cn } from '@/lib/utils';
import { AgentAvatar } from '../agents/avatar';
import { useTeamFaces } from './team-live';

/** A team node's progress report (lib/shared/team-progress.ts), when the node is running and has sent one. */
export function liveTeam(data: Record<string, unknown> | undefined): TeamProgress | undefined {
  const team = data?.team as TeamProgress['team'] | undefined;
  return typeof data?.member === 'string' && team && Array.isArray(team.members) ? (data as unknown as TeamProgress) : undefined;
}

/**
 * While the team runs (`live`), the member at work is ringed in its colour, members done have a check, one that failed is
 * ringed red and members not asked yet fade; `moments` (team-live.tsx) sit above. A person can watch the run here
 * without opening it.
 */
export function TeamStrip({ teamId, live, moments }: { teamId: string; live?: TeamProgress; moments?: ReactNode }) {
  const faces = useTeamFaces(teamId);
  if (!faces?.length) return null;
  if (live) {
    const stateOf = (title: string) => live.team.members.find((m) => m.title.toLowerCase() === title.toLowerCase())?.state;
    return (
      <div className="flex flex-col items-center gap-1.5">
        {moments}
        <div className="flex items-center gap-1 rounded-full border border-hair bg-sf px-1 py-0.5 shadow-pop" data-testid="team-strip" title={faces.map((f) => `${f.title}: ${stateOf(f.title) ?? 'idle'}`).join(', ')}>
          {faces.slice(0, 8).map(({ member, face, color, title }) => {
            const state = stateOf(title);
            const now = live.member.toLowerCase() === title.toLowerCase() && live.plain !== 'Done';
            return (
              <span key={member.id} className={cn('relative rounded-full transition-[opacity,transform,filter] duration-300', state === 'idle' && 'opacity-35 saturate-50', now && 'scale-110')}>
                <AgentAvatar agent={face} size={20} round className={cn('ring-2', state === 'failed' ? 'ring-rd' : 'ring-sf')} />
                {now && <span className="pointer-events-none absolute -inset-[3px] animate-pulse-soft rounded-full border-2" style={{ borderColor: color }} />}
                {state === 'done' && (
                  <span className="absolute -bottom-1 -right-1 grid size-3 place-items-center rounded-full bg-gn text-white ring-[1.5px] ring-sf">
                    <Check className="size-2" strokeWidth={4} />
                  </span>
                )}
              </span>
            );
          })}
        </div>
      </div>
    );
  }
  return (
    <div className="flex max-w-[280px] items-center gap-1.5 rounded-full border border-hair bg-sf py-0.5 pl-0.5 pr-2.5 shadow-pop" title={faces.map((f) => f.title).join(', ')} data-testid="team-strip">
      <span className="flex shrink-0">
        {faces.slice(0, 6).map(({ member, face }, i) => (
          <AgentAvatar key={member.id} agent={face} size={20} round className={cn('ring-2 ring-sf', i && '-ml-1.5')} />
        ))}
      </span>
      <span className="truncate text-[11px] font-medium text-t2">
        {faces.map((f, i) => (
          <span key={f.member.id}>
            {i ? ' · ' : ''}
            <span className={i ? undefined : 'font-semibold text-t1'}>{f.title}</span>
          </span>
        ))}
      </span>
    </div>
  );
}
