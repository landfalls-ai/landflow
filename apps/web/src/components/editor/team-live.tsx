'use client';
/**
 * A Run a Team node at work, on both canvases (docs/agent-teams.md#watching-a-team-work): the node becomes the member
 * working now (its face, title and what it does in plain words, with its last three steps), a ribbon at its bottom
 * marks each member's turn, and the moments that matter (tests pass, a review's verdict) appear above it for a while.
 * After the run the node keeps the ribbon and a one-line summary from its output's `activity`. On a phone the execution
 * view pins a Now card with the same over the canvas.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Check, ChevronRight, Hourglass, Loader2, X } from 'lucide-react';
import { duration } from '@/lib/client/format';
import { chartOrder, memberAgent, type TeamMember } from '@/lib/shared/agent-teams';
import type { AgentSummary } from '@/lib/shared/agents';
import type { TeamActivity, TeamMoment, TeamProgress, TeamStep, TeamTurn } from '@/lib/shared/team-progress';
import { cn } from '@/lib/utils';
import { AgentAvatar, type AvatarSource } from '../agents/avatar';
import { faceOf as agentFace, loadRoster, loadTeam } from '../agents/faces';
import type { NodeLive } from '../canvas/node-tile';

export interface TeamFace {
  member: TeamMember;
  title: string;
  face: AvatarSource;
  color: string;
}

/** How long a moment stays above the node. */
const MOMENT_MS = 25_000;
const norm = (s: string) => s.trim().toLowerCase();

/** A Landflow agent wears its own face, also when it is called on kagent; another remote agent gets the A2A node's colour and radio icon. */
export function memberFace(member: TeamMember, agents: AgentSummary[]): AvatarSource {
  const agent = memberAgent(member, agents);
  return agent ? agentFace(agent) : { name: member.title, icon: 'lucide:radio-tower', color: '#a855f7' };
}

/** The team's members in chart order (the lead first) with their faces, once the team and the roster load. */
export function useTeamFaces(teamId: string | undefined): TeamFace[] | undefined {
  const [faces, setFaces] = useState<TeamFace[]>();
  useEffect(() => {
    if (!teamId) return;
    let active = true;
    void Promise.all([loadTeam(teamId), loadRoster()]).then(([team, agents]) => {
      if (!active || !team) return;
      setFaces(
        chartOrder(team.published ?? team.draft).map((member) => {
          const face = memberFace(member, agents);
          return { member, title: member.title, face, color: face.color || '#a855f7' };
        }),
      );
    });
    return () => {
      active = false;
    };
  }, [teamId]);
  return faces;
}

export const faceByTitle = (faces: TeamFace[], title: string) => faces.find((f) => norm(f.title) === norm(title));

/** Milliseconds since the team started, ticking each second between reports while it runs. */
function useElapsed(live: TeamProgress | undefined): number {
  const at = live?.at;
  const [mark, setMark] = useState<{ at: number; received: number }>();
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (at === undefined) return;
    const received = Date.now();
    setMark({ at, received });
    setNow(received);
  }, [at]);
  const running = at !== undefined;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  if (at === undefined) return 0;
  return mark && mark.at === at ? at + Math.max(0, now - mark.received) : at;
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function StepIcon({ status }: { status: TeamStep['status'] }) {
  if (status === 'running') return <Loader2 className="size-3 shrink-0 animate-spin text-t1" />;
  if (status === 'awaiting_approval') return <Hourglass className="size-3 shrink-0 text-warn" />;
  const ok = status === 'success';
  return (
    <span className={cn('grid size-3.5 shrink-0 place-items-center rounded-full', ok ? 'bg-gn/15 text-gn' : 'bg-rd/10 text-rd')}>
      {ok ? <Check className="size-2.5" strokeWidth={3.5} /> : <X className="size-2.5" strokeWidth={3.5} />}
    </span>
  );
}

/** The last three steps, a check, a cross or a spinner each. */
export function TeamTicker({ steps, className }: { steps: TeamStep[]; className?: string }) {
  if (!steps.length) return null;
  return (
    <ol className={cn('flex flex-col gap-1', className)} data-testid="team-ticker">
      {steps.slice(-3).map((step, i) => (
        <li key={`${i}:${step.name}:${step.plain}`} className="flex min-w-0 items-center gap-2 text-[11.5px] leading-4">
          <StepIcon status={step.status} />
          <span className={cn('min-w-0 flex-1 truncate', step.status === 'running' ? 'font-medium text-t1' : 'text-t2')} title={step.args ? `${step.name}: ${step.args}` : step.name}>
            {step.plain}
          </span>
          {step.ms !== undefined && <span className={cn('shrink-0 font-mono text-[10px] tabular-nums', step.status === 'error' ? 'text-rd' : 'text-t3')}>{duration(step.ms)}</span>}
        </li>
      ))}
    </ol>
  );
}

/** The member at work: its face ringed in its colour (with the lead's as a badge), what it does, the command and the clock. */
function WorkerHead({ live, faces, elapsed }: { live: TeamProgress; faces: TeamFace[]; elapsed: number }) {
  const lead = faces[0];
  const worker = faceByTitle(faces, live.member) ?? lead;
  const isLead = !worker || worker === lead;
  const words = live.plain ?? live.doing ?? 'Working';
  return (
    <>
      <span key={worker?.title} className="relative shrink-0 animate-pop">
        {worker && <AgentAvatar agent={worker.face} size={44} />}
        <span className="pointer-events-none absolute -inset-[4px] animate-pulse-soft rounded-[16px] border-2" style={{ borderColor: worker?.color }} />
        {!isLead && lead && (
          <span className="absolute -bottom-1.5 -right-1.5 rounded-full ring-2 ring-sf" title={`Works for ${lead.title}`}>
            <AgentAvatar agent={lead.face} size={18} round />
          </span>
        )}
      </span>
      <div className="min-w-0 flex-1" aria-live="polite">
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate text-[14px] font-semibold text-t1">{worker?.title ?? live.member}</span>
          {!isLead && lead && <span className="shrink-0 text-[10.5px] text-t3">for {lead.title}</span>}
        </div>
        <div key={words} className="truncate text-[12.5px] font-medium leading-4 text-t1 animate-fade-up">
          {words}
        </div>
        {live.command && (
          <div className="truncate font-mono text-[10px] leading-4 text-t3" title={live.command}>
            {live.command}
          </div>
        )}
        <div className="font-mono text-[10px] leading-4 tabular-nums text-t3">
          {clock(elapsed)}
          {!isLead && live.stepCount ? ` · step ${live.stepCount}` : ''}
        </div>
      </div>
    </>
  );
}

/** One segment per turn in the member's colour, at the bottom of the node (above its sub-node slots); the open turn grows. */
export function TeamRibbon({ turns, total, faces, open }: { turns: TeamTurn[]; total: number; faces: TeamFace[]; open?: boolean }) {
  if (!turns.length || total <= 0) return null;
  return (
    <div className="mx-4 mb-7 mt-2 flex h-1 shrink-0 gap-px overflow-hidden rounded-full bg-acdim" data-testid="team-ribbon">
      {turns.map((turn, i) => {
        const length = Math.max(0, (turn.end ?? total) - turn.start);
        const face = faceByTitle(faces, turn.member);
        return (
          <span
            key={`${i}:${turn.member}`}
            title={`${turn.member} · ${duration(length)}`}
            className={cn('h-full min-w-[3px] transition-[width] duration-500', open && i === turns.length - 1 && turn.end === undefined && 'animate-pulse-soft')}
            style={{ width: `${(length / total) * 100}%`, background: face?.color ?? 'var(--t3)' }}
          />
        );
      })}
    </div>
  );
}

const TONE: Record<TeamMoment['tone'], string> = { ok: 'bg-gn', bad: 'bg-rd', info: 'bg-viz-1' };

/** The latest moments, for a while after they happen, newest at the bottom (next to the node). */
export function TeamMoments({ moments, elapsed, faces }: { moments: TeamMoment[]; elapsed: number; faces: TeamFace[] }) {
  const shown = moments.filter((m) => elapsed - m.at < MOMENT_MS).slice(-2);
  if (!shown.length) return null;
  return (
    <div className="flex flex-col items-center gap-1" data-testid="team-moments">
      {shown.map((m) => {
        const face = faceByTitle(faces, m.member);
        return (
          <span
            key={`${m.at}:${m.text}`}
            className={cn('flex max-w-[260px] items-center gap-1.5 rounded-full border border-hair bg-sf py-0.5 pl-0.5 pr-2.5 text-[11px] font-medium shadow-pop animate-pop', m.tone === 'bad' ? 'text-rd' : 'text-t1')}
          >
            {face ? <AgentAvatar agent={face.face} size={16} round /> : <span className="size-4" />}
            <span className={cn('size-1.5 shrink-0 rounded-full', TONE[m.tone])} />
            <span className="truncate">{m.text}</span>
          </span>
        );
      })}
    </div>
  );
}

/** A finished run in one line: the results that matter, then each member's steps. */
export function TeamSummary({ activity, className }: { activity: TeamActivity; className?: string }) {
  const results = [...new Map(activity.moments.filter((m) => m.tone !== 'info' || / reported back$|^Branch pushed$|^Committed$/.test(m.text)).map((m) => [m.text, m])).values()].slice(-3);
  const steps = Object.entries(activity.steps);
  if (!results.length && !steps.length) return null;
  return (
    <div className={cn('flex flex-wrap gap-1', className)} data-testid="team-summary">
      {results.map((m) => (
        <span key={m.text} className={cn('rounded-full px-2 py-px text-[10.5px] font-medium', m.tone === 'ok' ? 'bg-gn/12 text-gn' : m.tone === 'bad' ? 'bg-rd/10 text-rd' : 'bg-acdim text-t2')}>
          {m.text}
        </span>
      ))}
      {steps.map(([title, count]) => (
        <span key={title} className="rounded-full bg-acdim px-2 py-px text-[10.5px] text-t2">
          {title} · {count} {count === 1 ? 'step' : 'steps'}
        </span>
      ))}
    </div>
  );
}

/**
 * What a Run a Team node's tile shows (NodeTile `live`): while it runs, the member at work with its last steps and the
 * ribbon; once it ran, the summary and the ribbon of its activity. `moments` go above the node, with the roster.
 */
export function useTeamTile(teamId: string | undefined, live: TeamProgress | undefined, activity: TeamActivity | undefined): { tile?: NodeLive; moments?: ReactNode } {
  const faces = useTeamFaces(teamId);
  const elapsed = useElapsed(live);
  if (!faces?.length) return {};
  if (live) {
    const worker = faceByTitle(faces, live.member) ?? faces[0];
    return {
      tile: {
        color: worker.color,
        head: <WorkerHead live={live} faces={faces} elapsed={elapsed} />,
        body: (
          <>
            <TeamTicker steps={live.steps} className="mx-4 border-t border-hair pt-2" />
            <TeamRibbon turns={live.turns} total={elapsed} faces={faces} open />
          </>
        ),
      },
      moments: <TeamMoments moments={live.moments} elapsed={elapsed} faces={faces} />,
    };
  }
  if (activity) {
    return {
      tile: {
        body: (
          <>
            <TeamSummary activity={activity} className="mx-4 border-t border-hair pt-2" />
            <TeamRibbon turns={activity.turns} total={activity.durationMs} faces={faces} />
          </>
        ),
      },
    };
  }
  return {};
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/**
 * The execution view's Now card on a phone, where the canvas is small: who works and on what in a sentence, the command,
 * the ticker, and a way into the Run Trace.
 */
export function TeamNowCard({ teamId, live, nodeName, onOpenTrace }: { teamId: string; live: TeamProgress; nodeName: string; onOpenTrace?: () => void }) {
  const faces = useTeamFaces(teamId);
  const elapsed = useElapsed(live);
  if (!faces?.length) return null;
  const lead = faces[0];
  const worker = faceByTitle(faces, live.member) ?? lead;
  const words = live.plain ?? live.doing ?? 'Working';
  return (
    <section className="rounded-2xl border border-hair bg-sf p-3 shadow-pop" data-testid="team-now-card" aria-live="polite">
      <div className="mb-2 flex items-center justify-between text-[11px] text-t3">
        <span className="truncate font-semibold uppercase tracking-[0.06em]">Now · {nodeName}</span>
        <span className="shrink-0 font-mono tabular-nums">{clock(elapsed)}</span>
      </div>
      <div className="flex min-w-0 items-center gap-3">
        <span key={worker.title} className="relative shrink-0 animate-pop">
          <AgentAvatar agent={worker.face} size={40} />
          <span className="pointer-events-none absolute -inset-[3px] animate-pulse-soft rounded-[14px] border-2" style={{ borderColor: worker.color }} />
        </span>
        <div className="min-w-0">
          <div key={words} className="text-[14px] font-semibold leading-5 text-t1 animate-fade-up">
            {worker.title} is {lowerFirst(words)}
          </div>
          {live.command && <div className="truncate font-mono text-[10.5px] text-t3">{live.command}</div>}
        </div>
      </div>
      <TeamTicker steps={live.steps} className="mt-2.5" />
      <div className="mt-2.5 flex items-center justify-between border-t border-hair pt-2 text-[11.5px] text-t3">
        <span className="truncate">
          {worker === lead ? 'Leading the team' : `For ${lead.title}`}
          {worker !== lead && live.stepCount ? ` · step ${live.stepCount}` : ''}
        </span>
        {onOpenTrace && (
          <button onClick={onOpenTrace} className="flex shrink-0 items-center gap-0.5 font-semibold text-t1">
            Run trace <ChevronRight className="size-3.5" />
          </button>
        )}
      </div>
    </section>
  );
}
