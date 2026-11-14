'use client';
/**
 * A run as a timeline (docs/run-trace.md#a-run-as-a-timeline), drawn in the new look only: the face of who leads the run,
 * the workflow, who and which team, a status pill, and the steps joined by a line that fills as the run goes. The member at
 * work sits on its step with a bubble saying what it does; a wait for a person pulses amber with what it asks, a failure is
 * a red cross with Re-run from here. Above the Run Trace's tabs (`RunTimelineCard`), and as a card per run going on
 * (`RunTimelineLive`, which reads the run's journal itself).
 */
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { ArrowRight, Check, Hourglass, Workflow, X } from 'lucide-react';
import { useRunJournal } from '@/lib/client/run-trace';
import { headlinesOf } from '@/lib/shared/run-headlines';
import { runLine } from '@/lib/shared/run-line';
import { fitSteps, runTimeline, timelineFill, type RunTimeline, type TimelineStatus, type TimelineStep } from '@/lib/shared/run-timeline';
import { fmtMs, type RunModel } from '@/lib/shared/run-trace-model';
import { cn } from '@/lib/utils';
import { RerunFromHere } from './run-controls';
import { Avatar, actorColor } from './parts';
import { RunLineRow } from './run-line';

const STATUS: Record<TimelineStatus, { label: string; className: string; dot?: boolean }> = {
  'on-track': { label: 'On track', className: 'border-gnbd bg-gndim text-gn', dot: true },
  'needs-you': { label: 'Needs you', className: 'border-warnbd bg-warndim text-warn', dot: true },
  'over-budget': { label: 'Over budget', className: 'border-warnbd bg-warndim text-warn' },
  failed: { label: 'Failed', className: 'border-rdbd bg-rddim text-rd' },
  done: { label: 'Succeeded', className: 'border-gnbd bg-gndim text-gn' },
};

const tokensText = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k tokens` : n ? `${n} tokens` : '');

function StatusPill({ status }: { status: TimelineStatus }) {
  const s = STATUS[status];
  return (
    <span className={cn('inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[11.5px] font-semibold', s.className)}>
      {s.dot && <span className={cn('size-1.5 rounded-full bg-current', 'animate-pulse-soft')} />}
      {s.label}
    </span>
  );
}

/** A step's mark on the line: a check, the member's face with a halo, an hourglass, a cross, or an empty ring. */
function Mark({ step }: { step: TimelineStep }) {
  const color = actorColor(step.actor);
  if (step.state === 'done')
    return (
      <span className="grid size-7 place-items-center rounded-full bg-gn text-bg shadow-[0_0_0_3px_var(--sf)] animate-pop">
        <Check className="size-4" strokeWidth={3} />
      </span>
    );
  if (step.state === 'failed')
    return (
      <span className="grid size-7 place-items-center rounded-full bg-rd text-bg shadow-[0_0_0_3px_var(--sf)] animate-shake">
        <X className="size-4" strokeWidth={3} />
      </span>
    );
  if (step.state === 'waiting')
    return (
      <span className="lf-halo grid size-7 place-items-center rounded-full border-2 border-warn bg-warndim text-warn shadow-[0_0_0_3px_var(--sf)]" style={{ ['--halo' as string]: 'var(--warn)' }}>
        <Hourglass className="size-3.5" />
      </span>
    );
  if (step.state === 'now')
    return (
      <span className="lf-halo grid size-7 place-items-center rounded-full shadow-[0_0_0_3px_var(--sf)]" style={{ ['--halo' as string]: color }}>
        {step.actor ? <Avatar actor={step.actor} size={28} /> : <span className="size-3 rounded-full" style={{ background: color }} />}
      </span>
    );
  return <span className="grid size-7 place-items-center rounded-full border-2 border-dashed border-bd bg-sf shadow-[0_0_0_3px_var(--sf)]" />;
}

/** The bubble over the step at work or waiting, pointing at it, kept inside the card at the ends. */
function Bubble({ step, index, count }: { step: TimelineStep; index: number; count: number }) {
  const left = ((index + 0.5) / count) * 100;
  const edge = index === 0 ? 'start' : index === count - 1 ? 'end' : 'mid';
  const waiting = step.state === 'waiting';
  return (
    <div className="relative mb-2 h-[30px]">
      <div
        key={step.doing}
        className={cn(
          'absolute top-0 max-w-[85%] truncate rounded-full border px-2.5 py-1 text-[12px] font-medium shadow-[0_2px_8px_var(--hair)] animate-fade-up',
          waiting ? 'border-warnbd bg-warndim text-warn' : 'border-hair bg-sf text-t1',
        )}
        style={edge === 'start' ? { left: 0 } : edge === 'end' ? { right: 0 } : { left: `${left}%`, transform: 'translateX(-50%)' }}
      >
        {step.doing}
      </div>
      <span
        aria-hidden
        className={cn('absolute bottom-0 size-2 rotate-45 border-b border-r', waiting ? 'border-warnbd bg-warndim' : 'border-hair bg-sf')}
        style={{ left: `calc(${left}% - 4px)` }}
      />
    </div>
  );
}

export function TimelineSteps({ timeline, max = 6 }: { timeline: RunTimeline; max?: number }) {
  const steps = fitSteps(timeline.steps, max);
  const fill = timelineFill(steps);
  const bubbleAt = steps.findIndex((s) => (s.state === 'now' || s.state === 'waiting') && s.doing);
  const live = timeline.status === 'on-track' || timeline.status === 'needs-you' || timeline.status === 'over-budget';
  return (
    <div>
      {bubbleAt >= 0 && <Bubble step={steps[bubbleAt]} index={bubbleAt} count={steps.length} />}
      <ol className="relative grid" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
        {/* The line between the first and the last mark, and the part of it the run has covered. */}
        <span aria-hidden className="absolute top-[13px] h-[2px] rounded-full bg-bd" style={{ left: `${50 / steps.length}%`, right: `${50 / steps.length}%` }} />
        <span
          aria-hidden
          className={cn('absolute top-[13px] h-[2px] rounded-full bg-gn transition-[width] duration-700 ease-out', live && 'lf-glint')}
          style={{ left: `${50 / steps.length}%`, width: `${fill * (100 - 100 / steps.length)}%` }}
        />
        {steps.map((s) => (
          <li key={s.key} className="relative flex min-w-0 flex-col items-center gap-1.5 px-0.5 text-center animate-in" aria-current={s.state === 'now' || s.state === 'waiting' ? 'step' : undefined}>
            <Mark step={s} />
            <span className={cn('line-clamp-2 text-[12px] font-semibold leading-tight', s.state === 'next' ? 'text-t3' : s.state === 'failed' ? 'text-rd' : s.state === 'waiting' ? 'text-warn' : 'text-t1')}>{s.label}</span>
            {s.who && <span className="-mt-1 w-full truncate text-[11px] text-t3">{s.who}</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** The card's top: who leads, the workflow, who and which team, and the status. */
function CardHead({ timeline }: { timeline: RunTimeline }) {
  return (
    <div className="flex items-start gap-3">
      {timeline.lead ? (
        <Avatar actor={timeline.lead} size={40} />
      ) : (
        <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-hair bg-sf2 text-t2">
          <Workflow className="size-5" />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-[14.5px] font-semibold text-t1">{timeline.title}</p>
        <p className="truncate text-[12.5px] text-t3">{[timeline.lead?.name, timeline.team].filter(Boolean).join(' · ') || 'Workflow'}</p>
      </div>
      <StatusPill status={timeline.status} />
    </div>
  );
}

/**
 * Above the Run Trace's tabs, in the new look. A wait points at Needs you below (its buttons decide it); a failure offers
 * Re-run from the failed step; a run that is done says how long it took and what it used, with a link to the Story.
 */
export function RunTimelineCard({ model, onStory }: { model: RunModel; onStory?: () => void }) {
  const timeline = useMemo(() => runTimeline(model, headlinesOf(model)), [model]);
  const [steps, setSteps] = useState(false);
  if (model.empty || !timeline.steps.length) return null;
  // Once a run is over, its timeline folds into one line: what came in, who did it, what came out.
  if (!model.live && (timeline.status === 'done' || timeline.status === 'failed' || timeline.status === 'over-budget') && !steps)
    return (
      <section aria-label="What the run did" className="flex flex-col gap-1.5">
        <RunLineRow line={runLine(model)} onOpen={onStory} />
        <button type="button" onClick={() => setSteps(true)} className="self-start px-1 text-[12px] font-medium text-t3 hover:text-t1">
          Show the steps
        </button>
      </section>
    );
  const failed = timeline.steps.find((s) => s.state === 'failed');
  return (
    <section aria-label="The run as a timeline" className={cn('rounded-2xl border bg-sf p-3.5 shadow-[0_1px_3px_var(--hair)]', timeline.status === 'needs-you' ? 'border-warnbd' : timeline.status === 'failed' ? 'border-rdbd' : 'border-hair')}>
      <CardHead timeline={timeline} />
      <div className="mt-3.5">
        <TimelineSteps timeline={timeline} />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-hair pt-2.5 text-[12px] text-t3">
        <span>{[fmtMs(timeline.ms), tokensText(timeline.tokens)].filter(Boolean).join(' · ')}</span>
        <span className="flex-1" />
        {timeline.status === 'needs-you' && (
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1 rounded-full bg-warn px-3 text-[12px] font-semibold text-bg"
            onClick={() => document.querySelector('[aria-label="Needs you"]')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
          >
            Answer below
          </button>
        )}
        {failed?.spanId && <RerunFromHere spanId={failed.spanId} model={model} />}
        {timeline.status !== 'needs-you' && onStory && (
          <button type="button" onClick={onStory} className="inline-flex items-center gap-1 font-medium text-t1 hover:underline">
            Open the Story <ArrowRight className="size-3" />
          </button>
        )}
      </div>
    </section>
  );
}

/** A card per run going on (Home, the runs list, the team page), from the run's own journal; a tap opens its Run Trace. */
export function RunTimelineLive({ executionId, name }: { executionId: string; name?: string }) {
  const { model } = useRunJournal(executionId);
  const timeline = useMemo(() => (model.empty ? undefined : runTimeline(model, headlinesOf(model))), [model]);
  return (
    <Link
      href={`/runs/${executionId}`}
      className={cn(
        'block rounded-2xl border bg-sf p-3.5 transition-colors hover:bg-acdim/40',
        timeline?.status === 'needs-you' ? 'border-warnbd' : timeline?.status === 'failed' ? 'border-rdbd' : 'border-hair',
      )}
    >
      {timeline ? (
        <>
          <CardHead timeline={{ ...timeline, title: name ?? timeline.title }} />
          {timeline.steps.length > 0 && (
            <div className="mt-3.5">
              <TimelineSteps timeline={timeline} max={5} />
            </div>
          )}
          <p className="mt-2.5 text-[12px] text-t3">
            {[fmtMs(timeline.ms), tokensText(timeline.tokens)].filter(Boolean).join(' · ')}
            {timeline.waiting && <span className="font-medium text-warn"> · {timeline.waiting.title}</span>}
          </p>
        </>
      ) : (
        <div className="flex items-center gap-3">
          <span className="size-10 shrink-0 rounded-xl bg-acdim animate-pulse-soft" />
          <div className="flex-1">
            <p className="truncate text-[14.5px] font-semibold text-t1">{name ?? 'Run'}</p>
            <p className="text-[12.5px] text-t3">Starting…</p>
          </div>
        </div>
      )}
    </Link>
  );
}
