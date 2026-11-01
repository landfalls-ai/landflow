'use client';
/**
 * The Story tab: the run told like a chat. Messages, requests between agents with their result, waits for people,
 * artifacts, failures; quiet spans folded into "n steps". A team run's moments (tests pass, a review's verdict, a budget
 * near its end, a question for a person) head it as a row of headlines; a tap scrolls to where it happened.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { ChevronRight, Diamond, Flag, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { cut, fmtMs, preview, textOf, type RunModel, type RunRound, type RunSpan, type StoryEntry } from '@/lib/shared/run-trace-model';
import { isReviewComment } from '@/lib/shared/review-comments';
import { narrate, type TeamMoment } from '@/lib/shared/team-progress';
import { headlinesOf, type Headline } from '@/lib/shared/run-headlines';
import { Badge } from '../ui/badge';
import { EmptyState } from '../ui/empty-state';
import { Avatar, NowLine, ResultChip, Tap, clock, who } from './parts';
import { ReviewCommentStory } from './review-comment-card';
import { RerunFromHere } from './run-controls';
import type { Open } from './sheet';

function Head({ children, at }: { children: ReactNode; at: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-[12px] text-t3">
      {children}
      <span className="ml-auto font-mono text-[11px] tabular-nums">{clock(at)}</span>
    </div>
  );
}

function Bubble({ children, human }: { children: ReactNode; human?: boolean }) {
  return (
    <div
      className={cn(
        'mt-1 whitespace-pre-wrap break-words rounded-2xl rounded-tl-md border px-3 py-2 text-[13.5px] leading-snug text-t1',
        human ? 'border-acbd bg-acdim' : 'border-hair bg-sf',
      )}
    >
      {children}
    </div>
  );
}

function Ev({ avatar, children, onOpen, label }: { avatar: ReactNode; children: ReactNode; onOpen: () => void; label: string }) {
  return (
    <Tap onClick={onOpen} label={label} className="rounded-xl py-1.5 hover:bg-acdim/60">
      <div className="flex gap-2.5">
        {avatar}
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </Tap>
  );
}

function Line({ icon, children, tone, onOpen, label }: { icon: ReactNode; children: ReactNode; tone?: 'bad' | 'warn'; onOpen: () => void; label: string }) {
  return (
    <Tap
      onClick={onOpen}
      label={label}
      className={cn('rounded-xl px-2 py-1.5 hover:bg-acdim/60', tone === 'bad' && 'bg-rddim', tone === 'warn' && 'bg-warndim')}
    >
      <div className="flex items-start gap-2.5 text-[12.5px] text-t2">
        <span className={cn('mt-px grid size-7 shrink-0 place-items-center', tone === 'bad' ? 'text-rd' : tone === 'warn' ? 'text-warn' : 'text-t3')}>
          {icon}
        </span>
        <div className="min-w-0 flex-1 break-words pt-1">{children}</div>
      </div>
    </Tap>
  );
}

/** What a tool step did, in a few words: the agent's own description of it (Claude Code gives one with each command), else the step in plain words. */
export function stepWords(span: RunSpan): string | undefined {
  if (span.kind !== 'tool') return undefined;
  const input = typeof span.input === 'object' && span.input !== null ? (span.input as Record<string, unknown>) : undefined;
  const description = typeof input?.description === 'string' ? input.description.trim() : '';
  const words = description || narrate(span.name, span.input, { output: span.output }).plain;
  return words.toLowerCase() === span.name.toLowerCase() ? undefined : words;
}

function Steps({ spans, open }: { spans: RunSpan[]; open: (o: Open) => void }) {
  const [expanded, setExpanded] = useState(false);
  const running = spans.filter((s) => s.status === 'running').length;
  return (
    <div className="ml-[38px]">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="flex min-h-8 items-center gap-1.5 rounded-full border border-hair px-3 text-[12px] text-t2 hover:text-t1"
      >
        <ChevronRight className={cn('size-3 transition-transform', expanded && 'rotate-90')} />
        {spans.length} step{spans.length > 1 ? 's' : ''}
        {running > 0 && <span className="size-1.5 rounded-full bg-warn animate-pulse-soft" />}
      </button>
      {expanded && (
        <ul className="mt-1 divide-y divide-hair rounded-xl border border-hair bg-sf">
          {spans.map((s) => {
            const words = stepWords(s);
            return (
              <li key={s.id}>
                <Tap onClick={() => open({ kind: 'span', id: s.id })} className="flex items-center gap-2 px-3 py-2 text-[12.5px] hover:bg-acdim/60">
                  <span className={cn('min-w-0 flex-1 truncate', s.status === 'error' ? 'text-rd' : 'text-t1')}>{words ?? s.name}</span>
                  {words && <span className="shrink-0 text-[11px] text-t3">{s.name}</span>}
                  <span className="shrink-0 font-mono text-[11px] text-t3">{s.status === 'running' ? 'running' : fmtMs(s.ms)}</span>
                </Tap>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** "Round 2" and why the work went back: the Run report's send-back and the checks it failed. */
function RoundDivider({ round, open }: { round: RunRound; open: (o: Open) => void }) {
  const why = round.why;
  return (
    <div className="my-1.5">
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">
        <span className="h-px flex-1 bg-hair" />
        Round {round.n}
        <span className="font-mono normal-case tracking-normal">{clock(round.startedAt)}</span>
        <span className="h-px flex-1 bg-hair" />
      </div>
      {why && (
        <Tap onClick={() => open({ kind: 'span', id: why.spanId })} label={`Why round ${round.n} began`} className="mt-1.5 rounded-xl border border-warnbd bg-warndim px-3 py-2 hover:bg-warndim/70">
          <b className="block text-[12.5px] font-semibold text-warn">Sent back{why.by ? ` by ${why.by}` : ''}</b>
          {why.failed.length > 0 ? (
            <ul className="mt-1 space-y-0.5 text-[12.5px] text-t1">
              {why.failed.slice(0, 4).map((f) => (
                <li key={f.name} className="break-words">
                  {cut(f.name, 60)}
                  {f.message && <span className="text-t3"> · {cut(f.message, 100)}</span>}
                </li>
              ))}
              {why.failed.length > 4 && <li className="text-t3">and {why.failed.length - 4} more</li>}
            </ul>
          ) : (
            <p className="mt-1 break-words text-[12.5px] text-t1">{preview(why.text, 240)}</p>
          )}
        </Tap>
      )}
    </div>
  );
}

function Entry({ entry, model, open }: { entry: StoryEntry; model: RunModel; open: (o: Open) => void }) {
  switch (entry.type) {
    case 'round':
      return <RoundDivider round={entry.round} open={open} />;
    case 'msg':
      return (
        <Ev avatar={<Avatar actor={entry.from} />} onOpen={() => open({ kind: 'span', id: entry.spanId })} label={`Message from ${entry.from.name}`}>
          <Head at={entry.at}>
            {who(entry.from)}
            {entry.to && <span>to {entry.to.name}</span>}
          </Head>
          <Bubble human={entry.from.type === 'human'}>{preview(entry.text, 1200)}</Bubble>
        </Ev>
      );
    case 'agent': {
      const s = entry.span;
      return (
        <Line icon={<Avatar actor={s.actor} size={24} />} onOpen={() => open({ kind: 'span', id: s.id })} label={`${s.actor.name} at work`}>
          {who(s.actor)} {s.status === 'running' ? 'is at work' : 'worked'}
          {s.actor.role && <span className="text-t3"> · {cut(s.actor.role, 60)}</span>}
          <span className="text-t3"> · {fmtMs(s.ms)}</span>
        </Line>
      );
    }
    case 'ask': {
      const s = entry.span;
      const running = s.status === 'running' || s.status === 'waiting';
      const caller = s.caller;
      const doing = [...model.order].reverse().find((c) => c.id.startsWith(`${s.id}/`) && c.status === 'running' && !c.hidden);
      return (
        <Ev avatar={<Avatar actor={caller ?? s.actor} />} onOpen={() => open({ kind: 'span', id: s.id })} label={`Request to ${s.actor.name}`}>
          {entry.continued ? (
            <Head at={entry.at}>
              {who(s.actor)}
              <span>went on with</span>
              {who(caller)}
              <span>’s request after the wait</span>
            </Head>
          ) : (
            <Head at={entry.at}>
              {who(caller)}
              <span>{s.kind === 'handoff' ? 'handed off to' : 'asked'}</span>
              {who(s.actor)}
              <Badge tone="muted" className="font-mono font-medium">
                {s.kind === 'handoff' ? 'handoff' : 'A2A'}
              </Badge>
            </Head>
          )}
          {!entry.continued && typeof s.attrs.reason === 'string' && s.attrs.reason && (
            <p className="mt-1 break-words text-[12.5px] text-t2">
              <b className="font-semibold text-t1">Why </b>
              {preview(s.attrs.reason, 220)}
            </p>
          )}
          {!entry.continued && s.input !== undefined && <Bubble>{preview(textOf(s.input, 400), 180)}</Bubble>}
          {running ? (
            <NowLine>
              {s.actor.name} {s.status === 'waiting' ? 'waiting' : 'working'} · {fmtMs(s.ms)}
              {doing ? ` · now: ${cut(doing.name, 46)}` : s.note ? ` · ${cut(s.note, 46)}` : ''}
            </NowLine>
          ) : (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {s.steps > 0 && <Badge tone="neutral">{s.steps} {s.steps === 1 ? 'step' : 'steps'}</Badge>}
              {s.failedSteps > 0 && <Badge tone="danger">{s.failedSteps} failed</Badge>}
              <Badge tone="neutral">{fmtMs(s.ms)}</Badge>
            </div>
          )}
        </Ev>
      );
    }
    case 'reply': {
      const s = entry.span;
      const [, tone] = entry.result;
      return (
        <Ev avatar={<Avatar actor={s.actor} />} onOpen={() => open({ kind: 'span', id: s.id })} label={`Answer from ${s.actor.name}`}>
          <Head at={entry.at}>
            {who(s.actor)}
            {s.caller && <span>answered {s.caller.name}</span>}
          </Head>
          {s.error ? <Bubble>{cut(s.error, 180)}</Bubble> : textOf(s.output) ? <Bubble>{preview(textOf(s.output, 2000), 180)}</Bubble> : null}
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <ResultChip span={s} />
            {tone === 'bad' && s.status === 'error' && <Badge tone="danger">failed</Badge>}
          </div>
        </Ev>
      );
    }
    case 'wait': {
      const s = entry.span;
      const running = s.status === 'running' || s.status === 'waiting';
      return (
        <Ev avatar={<Avatar actor={s.caller ?? model.run?.actor} />} onOpen={() => open({ kind: 'span', id: s.id })} label={`Wait for ${s.actor.name}`}>
          <Head at={entry.at}>
            {who(s.caller ?? model.run?.actor)}
            <span>{running ? 'is waiting for' : 'waited for'}</span>
            {who(s.actor)}
          </Head>
          <Bubble>{preview(textOf(s.input, 400) || s.name, 240)}</Bubble>
          {running ? (
            <NowLine>Waiting · {fmtMs(s.ms)}</NowLine>
          ) : (
            <div className="mt-1.5 flex gap-1.5">
              <Badge tone="neutral">waited {fmtMs(s.ms)}</Badge>
              <ResultChip span={s} />
            </div>
          )}
        </Ev>
      );
    }
    case 'steps':
      return <Steps spans={entry.spans} open={open} />;
    case 'stepfail': {
      const s = entry.span;
      return (
        <>
          <Line tone="bad" icon={<TriangleAlert className="size-4" />} onOpen={() => open({ kind: 'span', id: s.id })} label={`${s.name} failed`}>
            {who(s.actor)}{' '}
            <span>
              {s.name} failed{s.error ? `: ${cut(s.error, 100)}` : ''}
            </span>
            <span className="ml-1.5 font-mono text-[11px] text-t3">{clock(entry.at)}</span>
          </Line>
          <div className="pb-1 pl-9">
            <RerunFromHere spanId={s.id} model={model} />
          </div>
        </>
      );
    }
    case 'artifact': {
      const a = entry.item.artifact;
      if (isReviewComment(a)) return <ReviewCommentStory item={entry.item} open={open} />;
      return (
        <Line icon={<Diamond className="size-4 text-gn" />} onOpen={() => open({ kind: 'artifact', id: entry.item.id })} label={`Artifact ${a.name}`}>
          {who(entry.item.actor)} <span>produced {a.kind ?? 'an artifact'}</span> <b className="font-semibold text-t1">{cut(a.name, 60)}</b>
          <span className="ml-1.5 font-mono text-[11px] text-t3">{clock(entry.at)}</span>
        </Line>
      );
    }
    case 'check': {
      const c = entry.item.check;
      const bad = c.status === 'fail';
      return (
        <Line
          tone={bad ? 'bad' : 'warn'}
          icon={<Flag className="size-4" />}
          onOpen={() => open({ kind: 'check', id: entry.item.id })}
          label={`Check ${c.name}`}
        >
          <b className="font-semibold text-t1">
            Check {bad ? (c.resolution ? (c.resolution.decision === 'accepted' ? 'failed, accepted' : 'failed, sent back') : 'failed') : 'to look at'}
          </b>
          <span> · {cut(c.name, 50)}</span>
          {c.message && <span className="block text-t3">{cut(c.message, 100)}</span>}
        </Line>
      );
    }
  }
  return null;
}

const DOT: Record<TeamMoment['tone'], string> = { ok: 'bg-gn', bad: 'bg-rd', warn: 'bg-warn', info: 'bg-viz-1' };

/** The run's moments in a row at the top of the story, newest last; a tap scrolls to the moment and flashes it. */
function Headlines({ items, model }: { items: Headline[]; model: RunModel }) {
  if (!items.length) return null;
  const go = (h: Headline) => {
    const el = h.entryKey ? document.getElementById(`story-${h.entryKey}`) : null;
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('animate-flash');
    void el.offsetWidth;
    el.classList.add('animate-flash');
  };
  return (
    <section aria-label="Headlines" className="mb-2" data-testid="story-headlines">
      <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">Headlines</h3>
      <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
        {items.slice(-12).map((h, i) => {
          const actor = model.actors.find((a) => a.actor.name.trim().toLowerCase() === h.moment.member.trim().toLowerCase())?.actor;
          return (
            <button
              key={`${h.at}:${i}`}
              type="button"
              onClick={() => go(h)}
              title={h.moment.question ?? h.moment.text}
              className={cn(
                'flex h-8 shrink-0 items-center gap-1.5 rounded-full border bg-sf py-0.5 pl-0.5 pr-3 text-[12px] font-medium shadow-sm transition-transform animate-pop hover:-translate-y-px',
                h.moment.tone === 'bad' ? 'border-rd/30 text-rd' : h.moment.tone === 'warn' ? 'border-warn/50 text-t1' : 'border-hair text-t1',
              )}
              style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}
            >
              {actor ? <Avatar actor={actor} size={26} /> : <span className="size-[26px]" />}
              <span className={cn('size-1.5 shrink-0 rounded-full', DOT[h.moment.tone])} />
              <span className="max-w-[220px] truncate">{h.moment.text}</span>
              <span className="font-mono text-[10.5px] font-normal tabular-nums text-t3">{clock(new Date(h.at).toISOString())}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

export function Story({ model, open }: { model: RunModel; open: (o: Open) => void }) {
  const headlines = useMemo(() => (model.empty ? [] : headlinesOf(model)), [model]);
  if (model.empty) return <EmptyState compact title="Nothing recorded yet" hint="The story appears as the run starts." />;
  return (
    <div className="flex flex-col gap-1">
      <Headlines items={headlines} model={model} />
      {model.story.map((entry) => (
        <div key={entry.key} id={`story-${entry.key}`} className="scroll-mt-24 rounded-xl">
          <Entry entry={entry} model={model} open={open} />
        </div>
      ))}
      <p className="mt-3 flex items-center justify-center gap-2 text-center text-[12px] text-t3">
        {model.live ? (
          <>
            <span className="size-1.5 rounded-full bg-warn animate-pulse-soft" /> Live at {clock(model.foldedAt)}
          </>
        ) : (
          <>
            Run {model.status === 'success' ? 'finished' : model.status === 'waiting' ? 'is waiting' : model.status} at {clock(model.endedAt ?? model.foldedAt)}{' '}
            · {fmtMs(model.t1 - model.t0)}
          </>
        )}
      </p>
    </div>
  );
}
