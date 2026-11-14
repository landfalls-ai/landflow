'use client';
/**
 * One activity trace for every chat (docs/assistant.md#chat-surfaces). While an AI works: one line with a spinner, the
 * step it is on. Once done: "10 steps · 14.5 s ›", which opens the list of what it read, searched, ran and wrote.
 */
import { useState } from 'react';
import { BookOpen, Brain, ChevronRight, Loader2, PenLine, Play, Search, Sparkles, Wrench, X, Check, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePhone } from '@/lib/client/use-phone';
import { formatSeconds, summarizeSteps, type ActivityKind, type ActivityStep } from '@/lib/shared/activity';
import { Collapsible } from './chat-motion';

const KIND_ICON: Record<ActivityKind, LucideIcon> = { read: BookOpen, search: Search, tool: Wrench, think: Brain, model: Sparkles, write: PenLine, run: Play };

function StepRow({ step }: { step: ActivityStep }) {
  const [open, setOpen] = useState(false);
  const Icon = KIND_ICON[step.kind] ?? Wrench;
  const failed = step.status === 'failed';
  const body = (
    <>
      <Icon className={cn('size-3.5 shrink-0', failed ? 'text-rd' : 'text-t3')} aria-hidden />
      <span className={cn('min-w-0 flex-1 truncate', failed ? 'text-rd' : 'text-t2')}>{step.label}</span>
      {step.durationMs !== undefined && <span className="shrink-0 font-mono text-[10.5px] text-t3">{formatSeconds(step.durationMs)}</span>}
      {step.status === 'running' ? <Loader2 className="size-3 shrink-0 animate-spin text-viz-7" aria-label="Running" /> : failed ? <X className="size-3.5 shrink-0 text-rd" aria-label="Failed" /> : <Check className="size-3.5 shrink-0 text-ok" aria-label="Done" />}
    </>
  );
  const rowClass = 'flex min-h-6 w-full items-center gap-1.5 text-left text-[12px] max-md:min-h-11';
  return (
    <li>
      {step.detail ? (
        <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className={cn(rowClass, 'rounded-md hover:bg-acdim')}>
          {body}
        </button>
      ) : (
        <div className={rowClass}>{body}</div>
      )}
      {step.detail && open && <p className={cn('ml-5 whitespace-pre-wrap pb-1 text-[11.5px] leading-snug [overflow-wrap:anywhere]', failed ? 'text-rd' : 'text-t3')}>{step.detail.slice(0, 300)}</p>}
    </li>
  );
}

/** What an AI did, as steps. `live` while it works; `traceUrl` adds "Open trace" under the list. Closed until opened; `defaultOpen` is ignored on a phone. */
export function ActivityTrace({ steps, live, durationMs, traceUrl, defaultOpen }: { steps: ActivityStep[]; live: boolean; durationMs?: number; traceUrl?: string; defaultOpen?: boolean }) {
  const phone = usePhone();
  const [toggled, setToggled] = useState<boolean | null>(null);
  if (live) {
    const at = steps.findLastIndex((s) => s.status === 'running');
    const i = at >= 0 ? at : steps.length - 1;
    const step = steps[i];
    return (
      <div role="status" className="flex min-w-0 items-center gap-1.5 text-[12px] text-t3">
        <Loader2 className="size-3.5 shrink-0 animate-spin text-viz-7" />
        <span className="min-w-0 truncate animate-pulse-soft">{step ? step.label : 'Thinking…'}</span>
        {step && <span className="shrink-0 font-mono text-[10.5px]">· step {i + 1}</span>}
      </div>
    );
  }
  if (!steps.length) return null;
  const open = toggled ?? (!!defaultOpen && !phone);
  return (
    <div className="text-[12px]">
      <button type="button" aria-expanded={open} onClick={() => setToggled(!open)} className="flex min-h-7 items-center gap-0.5 font-mono text-[10.5px] text-t3 hover:text-t1 max-md:min-h-11">
        {summarizeSteps(steps, durationMs)}
        <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} aria-hidden />
      </button>
      <Collapsible open={open}>
        <ul className="max-h-72 space-y-0.5 overflow-y-auto border-l border-hair pl-2 max-md:max-h-64">
          {steps.map((s) => (
            <StepRow key={s.id} step={s} />
          ))}
        </ul>
        {traceUrl && (
          <a href={traceUrl} className="mt-1 inline-flex min-h-7 items-center pl-2 text-[12px] font-semibold text-ac hover:underline max-md:min-h-11">
            Open trace
          </a>
        )}
      </Collapsible>
    </div>
  );
}
