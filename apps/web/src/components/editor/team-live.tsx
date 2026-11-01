'use client';
/**
 * A Run a Team node at work, on both canvases (docs/agent-teams.md#watching-a-team-work): the node becomes the member
 * working now (its face, title and what it does in plain words, with its last three steps), a ribbon at its bottom
 * marks each member's turn, and the moments that matter (tests pass, a review's verdict) appear above it for a while.
 * After the run the node keeps the ribbon and a one-line summary from its output's `activity`. On a phone the execution
 * view pins a Now card with the same over the canvas. A turn on the ribbon opens that member in the Run Trace; a member
 * with a budget gets a bar that turns amber at 80% and red when used up; a member's question for a person turns the
 * node amber, with the question and an Answer button.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Check, ChevronRight, Hourglass, Loader2, X } from 'lucide-react';
import { duration } from '@/lib/client/format';
import { chartOrder, memberAgent, type TeamMember } from '@/lib/shared/agent-teams';
import type { AgentSummary } from '@/lib/shared/agents';
import type { TeamActivity, TeamMoment, TeamProgress, TeamStep, TeamTurn, TeamUsage } from '@/lib/shared/team-progress';
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

/** Where a member's turn opens: its sheet on the Run Trace's Team tab. */
export const memberTraceHref = (executionId: string, member: string) => `/runs/${executionId}?tab=team&member=${encodeURIComponent(member)}`;

/** Keeps a tap on a link inside a canvas node from selecting or dragging the node. */
const own = {
  onClick: (e: React.MouseEvent) => e.stopPropagation(),
  onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
  onDoubleClick: (e: React.MouseEvent) => e.stopPropagation(),
};

/**
 * One segment per turn in the member's colour, at the bottom of the node (above its sub-node slots); the open turn grows.
 * With `hrefOf`, each segment opens that member's turn in the Run Trace (its tap area is taller than it looks).
 */
export function TeamRibbon({ turns, total, faces, open, hrefOf, newTab }: { turns: TeamTurn[]; total: number; faces: TeamFace[]; open?: boolean; hrefOf?: (turn: TeamTurn) => string | undefined; newTab?: boolean }) {
  if (!turns.length || total <= 0) return null;
  return (
    <div className={cn('mx-4 mb-7 mt-2 flex shrink-0 gap-px rounded-full bg-acdim', hrefOf ? 'h-1.5' : 'h-1 overflow-hidden')} data-testid="team-ribbon">
      {turns.map((turn, i) => {
        const length = Math.max(0, (turn.end ?? total) - turn.start);
        const face = faceByTitle(faces, turn.member);
        const style = { width: `${(length / total) * 100}%`, background: face?.color ?? 'var(--t3)' };
        const className = cn('h-full min-w-[3px] transition-[width] duration-500 first:rounded-l-full last:rounded-r-full', open && i === turns.length - 1 && turn.end === undefined && 'animate-pulse-soft');
        const href = hrefOf?.(turn);
        if (!href) return <span key={`${i}:${turn.member}`} title={`${turn.member} · ${duration(length)}`} className={className} style={style} />;
        return (
          <a
            key={`${i}:${turn.member}`}
            href={href}
            {...(newTab && { target: '_blank', rel: 'noopener' })}
            {...own}
            title={`${turn.member} · ${duration(length)} · open in the Run trace`}
            aria-label={`${turn.member}'s turn, ${duration(length)}: open in the Run trace`}
            data-testid="team-ribbon-turn"
            className={cn(className, "nodrag nopan relative cursor-pointer transition-transform hover:scale-y-[1.8] focus-visible:scale-y-[1.8] focus-visible:outline-none after:absolute after:inset-x-0 after:-inset-y-3 after:content-['']")}
            style={style}
          />
        );
      })}
    </div>
  );
}

const levelOf = (u: TeamUsage): 'ok' | 'warn' | 'bad' | undefined => (!u.budget ? undefined : u.tokens >= u.budget ? 'bad' : u.tokens >= u.budget * 0.8 ? 'warn' : 'ok');
const kTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

/** One member's tokens against its budget: a bar in its colour that turns amber at 80% and red once used up. */
export function BudgetBar({ usage, color, className }: { usage: TeamUsage; color?: string; className?: string }) {
  const level = levelOf(usage);
  if (!usage.budget || !level) return null;
  const share = Math.min(1, usage.tokens / usage.budget);
  const about = usage.estimated ? 'about ' : '';
  return (
    <div className={cn('flex min-w-0 items-center gap-2', className)} data-testid="team-budget" data-level={level} title={`${usage.member} used ${about}${usage.tokens.toLocaleString()} of its ${usage.budget.toLocaleString()} tokens`}>
      <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-acdim" role="meter" aria-valuemin={0} aria-valuemax={usage.budget} aria-valuenow={Math.min(usage.tokens, usage.budget)} aria-label={`${usage.member}'s budget`}>
        <span className={cn('block h-full rounded-full transition-[width] duration-700', level === 'bad' && 'bg-rd', level === 'warn' && 'bg-warn animate-pulse-soft')} style={{ width: `${Math.max(2, share * 100)}%`, ...(level === 'ok' && { background: color ?? 'var(--gn)' }) }} />
      </span>
      <span className={cn('shrink-0 font-mono text-[10px] tabular-nums', level === 'bad' ? 'text-rd' : level === 'warn' ? 'text-warn' : 'text-t3')}>
        {usage.estimated ? '~' : ''}
        {kTokens(usage.tokens)} / {kTokens(usage.budget)}
      </span>
    </div>
  );
}

/** The budget bars worth showing: every member with a budget, or (`focus`) the one at work and any past 80%. */
export function TeamBudgets({ usage, faces, focus, className }: { usage?: TeamUsage[]; faces: TeamFace[]; focus?: string; className?: string }) {
  const shown = (usage ?? []).filter((u) => u.budget && (!focus || norm(u.member) === norm(focus) || levelOf(u) !== 'ok'));
  if (!shown.length) return null;
  return (
    <div className={cn('flex flex-col gap-1', className)} data-testid="team-budgets">
      {shown.map((u) => {
        const face = faceByTitle(faces, u.member);
        return (
          <div key={u.member} className="flex min-w-0 items-center gap-1.5">
            {face ? <AgentAvatar agent={face.face} size={14} round /> : <span className="size-3.5" />}
            <BudgetBar usage={u} color={face?.color} className="min-w-0 flex-1" />
          </div>
        );
      })}
    </div>
  );
}

/** A member's question as asked, without the "X asks:" its team puts in front and the list marks. */
export const questionText = (question: string) =>
  question
    .replace(/^[^\n]*\basks:\s*/i, '')
    .replace(/^\s*-\s+/gm, '')
    .trim();

/** The amber head of a node whose run waits on a member's question: the asker's face, "asks", and the question. */
function AskHead({ waiting, faces }: { waiting: { member: string; question: string }; faces: TeamFace[] }) {
  const face = faceByTitle(faces, waiting.member) ?? faces[0];
  const text = questionText(waiting.question);
  return (
    <>
      <span key={face.title} className="relative shrink-0 animate-pop">
        <AgentAvatar agent={face.face} size={44} />
        <span className="pointer-events-none absolute -inset-[4px] animate-pulse-soft rounded-[16px] border-2 border-warn" />
        <span className="absolute -bottom-1.5 -right-1.5 grid size-[18px] place-items-center rounded-full bg-warn text-bg ring-2 ring-sf">
          <Hourglass className="size-2.5" strokeWidth={3} />
        </span>
      </span>
      <div className="min-w-0 flex-1" aria-live="polite">
        <div className="truncate text-[14px] font-semibold text-t1">{face.title} asks a person</div>
        <div className="line-clamp-2 text-[12px] leading-4 text-t2" title={text}>
          {text}
        </div>
      </div>
    </>
  );
}

/** The Answer button: the run's waiting form, where the answer goes back to the member that asked. */
export function AnswerLink({ executionId, className }: { executionId: string; className?: string }) {
  return (
    <a
      href={`/form/waiting/${executionId}`}
      target="_blank"
      rel="noopener"
      {...own}
      data-testid="team-answer"
      className={cn('nodrag nopan inline-flex h-8 items-center justify-center gap-1.5 rounded-full bg-warn px-4 text-[13px] font-semibold text-bg shadow-sm transition-transform hover:scale-[1.03]', className)}
    >
      Answer <ChevronRight className="size-3.5" />
    </a>
  );
}

const TONE: Record<TeamMoment['tone'], string> = { ok: 'bg-gn', bad: 'bg-rd', warn: 'bg-warn', info: 'bg-viz-1' };

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
            className={cn(
              'flex max-w-[260px] items-center gap-1.5 rounded-full border bg-sf py-0.5 pl-0.5 pr-2.5 text-[11px] font-medium shadow-pop animate-pop',
              m.tone === 'bad' ? 'border-hair text-rd' : m.tone === 'warn' ? 'border-warn/50 text-t1' : 'border-hair text-t1',
            )}
            title={m.question ? questionText(m.question) : undefined}
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
        <span
          key={m.text}
          className={cn('rounded-full px-2 py-px text-[10.5px] font-medium', m.tone === 'ok' ? 'bg-gn/12 text-gn' : m.tone === 'bad' ? 'bg-rd/10 text-rd' : m.tone === 'warn' ? 'bg-warndim text-warn' : 'bg-acdim text-t2')}
        >
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

export interface TeamTileOptions {
  /** The run the node is in: its ribbon's turns open in the Run Trace, its question's Answer goes to its form. */
  executionId?: string;
  /** The run waits at this node for a person's answer to a member's question (the execution's `wait.data.teamQuestion`). */
  waiting?: { member: string; question: string };
  /** Open the Run Trace in a new tab (from the editor, so the flow stays open). */
  newTab?: boolean;
}

/** The question a waiting run's node waits on, from its wait's data (nodes/run-team.ts). */
export function teamQuestionOf(wait: { nodeId?: string; data?: Record<string, unknown> } | undefined, nodeId: string): { member: string; question: string } | undefined {
  const q = wait?.nodeId === nodeId ? (wait.data?.teamQuestion as { member?: unknown; question?: unknown } | undefined) : undefined;
  return q && typeof q.member === 'string' && typeof q.question === 'string' ? { member: q.member, question: q.question } : undefined;
}

const AMBER = 'var(--warn)';

/**
 * What a Run a Team node's tile shows (NodeTile `live`): while it runs, the member at work with its last steps, budget
 * bars and the ribbon; once it ran, the summary, the budgets and the ribbon of its activity; while the run waits on a
 * member's question, the question in amber with an Answer button. `moments` go above the node, with the roster.
 */
export function useTeamTile(teamId: string | undefined, live: TeamProgress | undefined, activity: TeamActivity | undefined, options: TeamTileOptions = {}): { tile?: NodeLive; moments?: ReactNode } {
  const faces = useTeamFaces(teamId);
  const elapsed = useElapsed(live);
  if (!faces?.length) return {};
  const { executionId, newTab } = options;
  const hrefOf = executionId ? (turn: TeamTurn) => memberTraceHref(executionId, turn.member) : undefined;
  const asked = options.waiting ?? live?.waiting;
  if (asked) {
    const turns = live?.turns ?? activity?.turns;
    return {
      tile: {
        color: AMBER,
        head: <AskHead waiting={asked} faces={faces} />,
        body: (
          <>
            <div className="mx-4 flex items-center gap-2 border-t border-hair pt-2">
              {executionId && options.waiting ? <AnswerLink executionId={executionId} /> : <span className="text-[11.5px] text-t3">Waiting for the answer…</span>}
            </div>
            <TeamBudgets usage={live?.usage ?? activity?.usage} faces={faces} focus={asked.member} className="mx-4 mt-2" />
            {turns && <TeamRibbon turns={turns} total={live ? elapsed : (activity?.durationMs ?? 0)} faces={faces} hrefOf={hrefOf} newTab={newTab} />}
          </>
        ),
      },
      ...(live && { moments: <TeamMoments moments={live.moments} elapsed={elapsed} faces={faces} /> }),
    };
  }
  if (live) {
    const worker = faceByTitle(faces, live.member) ?? faces[0];
    return {
      tile: {
        color: worker.color,
        head: <WorkerHead live={live} faces={faces} elapsed={elapsed} />,
        body: (
          <>
            <TeamTicker steps={live.steps} className="mx-4 border-t border-hair pt-2" />
            <TeamBudgets usage={live.usage} faces={faces} focus={live.member} className="mx-4 mt-2" />
            <TeamRibbon turns={live.turns} total={elapsed} faces={faces} open hrefOf={hrefOf} newTab={newTab} />
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
            <TeamBudgets usage={activity.usage} faces={faces} className="mx-4 mt-2" />
            <TeamRibbon turns={activity.turns} total={activity.durationMs} faces={faces} hrefOf={hrefOf} newTab={newTab} />
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
  if (live.waiting) return <TeamAskCard teamId={teamId} waiting={live.waiting} nodeName={nodeName} />;
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
      <TeamBudgets usage={live.usage} faces={faces} focus={live.member} className="mt-2.5" />
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

/** The phone card of a run waiting on a member's question: who asks, the question in full, and the Answer button. */
export function TeamAskCard({ teamId, waiting, nodeName, executionId }: { teamId: string; waiting: { member: string; question: string }; nodeName: string; executionId?: string }) {
  const faces = useTeamFaces(teamId);
  if (!faces?.length) return null;
  const face = faceByTitle(faces, waiting.member) ?? faces[0];
  return (
    <section className="rounded-2xl border border-warn/50 bg-warndim p-3 shadow-pop" data-testid="team-ask-card" aria-live="polite">
      <div className="mb-2 truncate text-[11px] font-semibold uppercase tracking-[0.06em] text-warn">Needs you · {nodeName}</div>
      <div className="flex min-w-0 items-start gap-3">
        <span className="relative shrink-0 animate-pop">
          <AgentAvatar agent={face.face} size={40} />
          <span className="pointer-events-none absolute -inset-[3px] animate-pulse-soft rounded-[14px] border-2 border-warn" />
        </span>
        <div className="min-w-0">
          <div className="text-[14px] font-semibold leading-5 text-t1">{face.title} asks</div>
          <p className="mt-0.5 whitespace-pre-line text-[13px] leading-5 text-t1">{questionText(waiting.question)}</p>
        </div>
      </div>
      {executionId && <AnswerLink executionId={executionId} className="mt-3 w-full" />}
    </section>
  );
}
