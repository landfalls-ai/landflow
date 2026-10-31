'use client';
/** Small pieces the Run Trace screens share: avatars, result chips, tappable rows, values. */
import { useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge, type Tone } from '../ui/badge';
import { JsonView } from '../ui/json-view';
import type { RunActor } from '@/lib/shared/run-trace';
import { resultOf, type ResultTone, type RunSpan } from '@/lib/shared/run-trace-model';

const AGENT_COLORS = ['--viz-1', '--viz-3', '--viz-2', '--viz-4', '--viz-5', '--viz-7'];

/** The colour variable of an actor: agents by a stable pick, people, the flow and models by kind. */
export function actorColor(actor?: Pick<RunActor, 'id' | 'type'>): string {
  if (!actor) return 'var(--t3)';
  if (actor.type === 'human') return 'var(--viz-5)';
  if (actor.type === 'system' || actor.type === 'tool') return 'var(--t3)';
  if (actor.type === 'model') return 'var(--viz-7)';
  let h = 0;
  for (const c of actor.id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `var(${AGENT_COLORS[h % AGENT_COLORS.length]})`;
}

const initials = (name: string) => {
  const parts = name.split(/[\s\-_:]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[1][0] : '')).toUpperCase();
};

export function Avatar({ actor, size = 28 }: { actor?: RunActor; size?: number }) {
  const color = actorColor(actor);
  return (
    <span
      aria-hidden
      className={cn(
        'grid shrink-0 place-items-center font-semibold',
        actor?.type === 'human' ? 'rounded-full' : actor?.type === 'system' ? 'rounded-md' : 'rounded-[10px]',
      )}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.38),
        color,
        background: `color-mix(in oklab, ${color} 14%, var(--sf))`,
        border: `1px solid color-mix(in oklab, ${color} 40%, transparent)`,
      }}
    >
      {actor ? initials(actor.name) : 'RR'}
    </span>
  );
}

const TONE: Record<ResultTone, Tone> = {
  ok: 'success',
  bad: 'danger',
  warn: 'warning',
  '': 'neutral',
};

export function ResultChip({ span }: { span: RunSpan }) {
  const [label, tone] = resultOf(span);
  return <Badge tone={TONE[tone]}>{label}</Badge>;
}

export function ToneBadge({ tone, children }: { tone: ResultTone; children: ReactNode }) {
  return <Badge tone={TONE[tone]}>{children}</Badge>;
}

export const clock = (iso?: string | number) => {
  if (iso === undefined) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour12: false });
};

/** A tappable row: a real button, 44 px tall at least on a phone. */
export function Tap({ onClick, children, className, label }: { onClick: () => void; children: ReactNode; className?: string; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={cn(
        'block w-full min-w-0 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ac',
        className,
      )}
    >
      {children}
    </button>
  );
}

/** A value from the journal: text as is (cut, expandable), anything else as a JSON tree. */
export function ValueBlock({ label, value, tone }: { label: string; value: unknown; tone?: 'error' }) {
  const [open, setOpen] = useState(false);
  if (value === undefined || value === null || value === '') return null;
  const text = typeof value === 'string' ? value : undefined;
  const long = text ? text.length > 360 || text.split('\n').length > 6 : true;
  return (
    <section className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex min-h-7 w-full items-center gap-1 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-t3 hover:text-t2"
      >
        <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
        {label}
      </button>
      <div
        className={cn(
          'mt-1 overflow-hidden rounded-xl border px-3 py-2 text-[13px]',
          tone === 'error' ? 'border-rdbd bg-rddim text-rd' : 'border-hair bg-sf2 text-t1',
        )}
      >
        {text !== undefined ? (
          <p className={cn('whitespace-pre-wrap break-words', !open && long && 'line-clamp-5')}>{text}</p>
        ) : open ? (
          <div className="max-h-[50dvh] overflow-auto">
            <JsonView value={value} />
          </div>
        ) : (
          <p className="line-clamp-3 break-all font-mono text-[12px] text-t2">{JSON.stringify(value)}</p>
        )}
      </div>
    </section>
  );
}

/** A pulsing line: "Planner working · 2m 04s". */
export function NowLine({ children }: { children: ReactNode }) {
  return (
    <div className="mt-1.5 flex items-center gap-2 rounded-full bg-warndim px-2.5 py-1 text-[12px] text-warn">
      <span className="size-1.5 shrink-0 rounded-full bg-warn animate-pulse-soft" />
      <span className="min-w-0 truncate">{children}</span>
    </div>
  );
}

export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-1.5 mt-4 flex items-center justify-between gap-2 px-0.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3 first:mt-0">
      <h3>{children}</h3>
      {aside}
    </div>
  );
}

export function Card({ children, className, tone }: { children: ReactNode; className?: string; tone?: 'bad' | 'warn' | 'ok' }) {
  return (
    <div
      className={cn(
        'rounded-2xl border bg-sf px-3.5 py-3',
        tone === 'bad' ? 'border-rdbd' : tone === 'warn' ? 'border-warnbd' : tone === 'ok' ? 'border-gnbd' : 'border-hair',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function who(actor?: RunActor) {
  return <b className="font-semibold text-t1">{actor?.name ?? 'Run report'}</b>;
}
