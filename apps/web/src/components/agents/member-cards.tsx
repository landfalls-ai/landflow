'use client';
/**
 * The team's members as cards (docs/agent-teams.md#member-cards), above the org chart: a big face, the
 * team's name and the member's title, “what I do” lines, and chips for where it runs, who it may consult, its budget and
 * how its last turn went. While a run goes on, the member at work is outlined in its colour and says “Working…”. On a
 * phone the cards swipe sideways (scroll-snap); on a wide screen they wrap. A tap opens the agent's page.
 */
import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import { memberAgent, type AgentTeamConfig, type TeamMember } from '@/lib/shared/agent-teams';
import type { AgentSummary } from '@/lib/shared/agents';
import { formatTokens } from '@/lib/shared/ai-usage';
import { cn } from '@/lib/utils';
import { Chip } from '../ui/badge';
import { AgentAvatar } from './avatar';
import { faceOf } from './faces';
import { modelLabel, type LastTeamRun } from './team-run-data';
import { DevOnly } from '@/lib/client/developer-details';

/** Where a member runs, in a few words: Claude Code on kagent, or its model. */
export function runsOnLabel(member: TeamMember, agent?: AgentSummary): string | undefined {
  if (member.kind === 'a2a' || agent?.kagent) return 'Claude Code · kagent';
  if (member.model) return modelLabel(member.model);
  const [provider, ...rest] = (agent?.model ?? '').split('/');
  return rest.length ? modelLabel({ provider, model: rest.join('/') }) : undefined;
}

/** How a member's last turn went, from the latest run; undefined when there is no run to say. */
export function lastTurn(run: LastTeamRun | null | undefined, title: string): string | undefined {
  const m = run?.members.find((x) => x.title === title);
  if (!run || !m || m.working) return undefined;
  if (m.notAsked) return 'Not asked last run';
  if (m.overBudget) return `Over budget · ${formatTokens(m.tokens)} tokens`;
  return `Last run · ${m.estimated ? '~' : ''}${formatTokens(m.tokens)} tokens`;
}

export function MemberCards({ config, teamName, agents, run }: { config: AgentTeamConfig; teamName: string; agents: readonly AgentSummary[]; run?: LastTeamRun | null }) {
  if (!config.members.length) return null;
  const working = run?.live ? (run.members.find((m) => m.working)?.title ?? run.member) : undefined;
  const titleOf = (id: string) => config.members.find((m) => m.id === id)?.title;
  return (
    <section aria-label="Team members" data-testid="member-cards">
      <ul className="-mx-6 flex snap-x snap-mandatory gap-3 overflow-x-auto scroll-px-6 px-6 pb-2 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
        {config.members.map((member) => {
          const agent = memberAgent(member, agents);
          const color = agent ? faceOf(agent).color : undefined;
          const busy = working !== undefined && working === member.title;
          const lines = agent?.whatIDo ?? [];
          const runsOn = runsOnLabel(member, agent);
          const consults = (member.consults ?? []).map(titleOf).filter(Boolean);
          const turn = lastTurn(run, member.title);
          const glow = color ?? 'var(--gn)';
          const body = (
            <>
              <span className="mx-auto block w-[88px]">
                {agent ? <AgentAvatar agent={faceOf(agent)} size={88} /> : <span className="grid size-[88px] place-items-center rounded-[28%] border border-hair bg-acdim text-[28px] font-semibold text-t2">{member.title.charAt(0)}</span>}
              </span>
              <span className="mt-2 block truncate text-center text-[11px] text-t3">{teamName || 'Team'}</span>
              <span className="block text-center text-[16px] font-semibold leading-tight text-t1">{member.title || 'Untitled'}</span>
              {busy && (
                <span className="mt-1 flex items-center justify-center gap-1 text-[12px] font-semibold" style={{ color: glow }}>
                  <Loader2 className="size-3 animate-spin" aria-hidden /> Working…
                </span>
              )}
              {lines.length > 0 ? (
                <ul className="mt-2.5 space-y-1 text-[12.5px] leading-snug text-t2">
                  {lines.map((line) => (
                    <li key={line} className="flex gap-1.5">
                      <span className="mt-[7px] size-1 shrink-0 rounded-full" style={{ background: color ?? 'var(--t3)' }} aria-hidden />
                      <span>{line}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="mt-2.5 block text-[12.5px] leading-snug text-t3">{member.role || 'No role yet.'}</span>
              )}
            </>
          );
          return (
            <li key={member.id} data-card-member={member.id} data-working={busy || undefined} className="w-[78%] max-w-[300px] shrink-0 snap-center sm:w-[250px]">
              <article className={cn('relative flex h-full flex-col rounded-2xl border bg-sf', busy ? 'border-transparent' : 'border-hair')} style={busy ? { outline: `2px solid ${glow}`, outlineOffset: -1 } : undefined}>
                {busy && (
                  <span
                    className="pointer-events-none absolute inset-0 animate-pulse rounded-2xl"
                    style={{ boxShadow: `0 0 0 4px color-mix(in oklab, ${glow} 28%, transparent), 0 0 22px color-mix(in oklab, ${glow} 45%, transparent)` }}
                    aria-hidden
                  />
                )}
                {agent ? (
                  <Link href={`/agents/${agent.id}`} className="flex flex-1 flex-col rounded-2xl p-3.5 focus-visible:outline-2 focus-visible:outline-ac">
                    {body}
                  </Link>
                ) : (
                  <div className="flex flex-1 flex-col p-3.5">{body}</div>
                )}
                <div className="mt-auto flex flex-wrap gap-1.5 border-t border-hair px-3.5 py-2.5">
                  {runsOn && (
                    <DevOnly>
                      <Chip tone="accent">{runsOn}</Chip>
                    </DevOnly>
                  )}
                  {consults.length > 0 && <Chip className="whitespace-normal border-dashed">Consults {consults.join(', ')}</Chip>}
                  {member.budgetTokens !== undefined && <Chip>{formatTokens(member.budgetTokens)} tokens a run</Chip>}
                  {turn && <Chip tone={turn.startsWith('Over') ? 'danger' : 'muted'}>{turn}</Chip>}
                </div>
              </article>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
