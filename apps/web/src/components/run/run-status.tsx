'use client';
/**
 * Status vocabulary shared by every screen that shows a run (docs/ui-review.md#words): Succeeded (green), Failed (red),
 * Running and Paused (amber), Waiting (blue), Queued and Canceled (grey). Use `RUN_STATE[state].label`, never the raw
 * status.
 */
import { useEffect, useState } from 'react';
import { Ban, CircleCheck, CircleDashed, CircleX, Hourglass, Loader2, Pause, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { duration, stamp } from '@/lib/client/format';
import type { ExecutionState } from '@/lib/shared/types';

export type RunState = ExecutionState | 'paused';

interface StateMeta {
  label: string;
  icon: LucideIcon;
  text: string;
  /** Left accent border of cards and rows. */
  border: string;
  bar: string;
  soft: string;
}

export const RUN_STATE: Record<RunState, StateMeta> = {
  success: { label: 'Succeeded', icon: CircleCheck, text: 'text-gn', border: 'border-l-gn', bar: 'bg-gn', soft: 'bg-gndim' },
  error: { label: 'Failed', icon: CircleX, text: 'text-rd', border: 'border-l-rd', bar: 'bg-rd', soft: 'bg-rddim' },
  running: { label: 'Running', icon: Loader2, text: 'text-warn', border: 'border-l-warn', bar: 'bg-warn', soft: 'bg-warndim' },
  paused: { label: 'Paused', icon: Pause, text: 'text-warn', border: 'border-l-warn', bar: 'bg-warn', soft: 'bg-warndim' },
  waiting: { label: 'Waiting', icon: Hourglass, text: 'text-viz-1', border: 'border-l-viz-1', bar: 'bg-viz-1', soft: 'bg-[color-mix(in_oklab,var(--viz-1)_12%,transparent)]' },
  canceled: { label: 'Canceled', icon: Ban, text: 'text-t3', border: 'border-l-t3', bar: 'bg-t3', soft: 'bg-nudim' },
  queued: { label: 'Queued', icon: CircleDashed, text: 'text-t2', border: 'border-l-t3', bar: 'bg-t3', soft: 'bg-nudim' },
};

export function runStateOf(e: { status: ExecutionState; paused?: unknown }): RunState {
  return e.paused ? 'paused' : e.status;
}

/** "Succeeded in 28 ms", "Failed in 126 ms", "Running for 3.20 s"… */
export function statusText(state: RunState, durationMs?: number): string {
  const d = duration(durationMs);
  if (state === 'success') return `Succeeded in ${d}`;
  if (state === 'error') return `Failed in ${d}`;
  if (state === 'running') return `Running for ${d}`;
  if (state === 'paused') return `Paused after ${d}`;
  if (state === 'waiting') return 'Waiting';
  if (state === 'queued') return 'Queued';
  return `Canceled after ${d}`;
}

export function RunStateIcon({ state, className }: { state: RunState; className?: string }) {
  const { icon: Icon, text } = RUN_STATE[state];
  return <Icon className={cn('size-3.5 shrink-0', text, state === 'running' && 'animate-spin', className)} fill={state === 'paused' ? 'currentColor' : 'none'} strokeWidth={state === 'paused' ? 0 : 2} />;
}

/** Re-renders every `intervalMs` while `active`, for elapsed times that tick. */
export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}

/** n8n's execution stamp: "Oct 25, 12:03:44" (`stamp` in lib/client/format.ts). */
export const formatStamp = stamp;
