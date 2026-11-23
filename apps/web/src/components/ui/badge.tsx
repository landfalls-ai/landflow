import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { languageMeta, transportLabel } from '@/lib/client/format';
import type { ExecutionState, PluginStatus, Transport } from '@/lib/shared/types';

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'muted';

const tones: Record<Tone, string> = {
  neutral: 'bg-nudim text-t2 border-transparent',
  accent: 'bg-acdim text-ac border-acbd',
  success: 'bg-gndim text-gn border-gnbd',
  warning: 'bg-warndim text-warn border-warnbd',
  danger: 'bg-rddim text-rd border-rdbd',
  muted: 'bg-transparent text-t3 border-hair',
};

/** Rounded-rect badge (statuses, counts). */
export function Badge({ children, tone = 'neutral', className, title }: { children: ReactNode; tone?: Tone; className?: string; title?: string }) {
  return (
    <span title={title} className={cn('inline-flex items-center gap-[5px] whitespace-nowrap rounded-md border px-2 py-px text-[11px] font-semibold', tones[tone], className)}>
      {children}
    </span>
  );
}

/** Pill chip (metadata, filters). */
export function Chip({ children, tone = 'muted', className, mono }: { children: ReactNode; tone?: Tone; className?: string; mono?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-px text-[12px]', tones[tone], tone === 'muted' && 'text-t2', mono && 'font-mono text-[11px]', className)}>
      {children}
    </span>
  );
}

/**
 * A filter you turn on and off (a category, a source), in a row of them (docs/ui-review.md#controls). `sm` for a long row
 * of categories; on a phone, where they sit in the Filters sheet, 40 px either way.
 */
export function FilterChip({
  active,
  onClick,
  children,
  size = 'md',
  title,
  className,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  size?: 'sm' | 'md';
  title?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={title}
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border transition-colors max-md:h-10 max-md:px-3.5 max-md:text-[14px]',
        size === 'sm' ? 'h-7 px-2.5 text-[12px]' : 'h-8 px-3.5 text-[13px]',
        active ? 'border-ac bg-acdim font-semibold text-ac' : 'border-hair bg-sf text-t2 hover:border-ac hover:text-t1',
        className,
      )}
    >
      {children}
    </button>
  );
}

export function TransportBadge({ transport, className }: { transport: Transport; className?: string }) {
  return (
    <Badge tone="muted" className={cn('font-mono font-medium', className)}>
      {transportLabel(transport)}
    </Badge>
  );
}

export function LanguageBadge({ language, className }: { language: string; className?: string }) {
  const meta = languageMeta(language);
  return (
    <Badge tone="muted" className={cn('font-medium text-t2', className)}>
      <span className="size-1.5 rounded-full" style={{ background: meta.color }} />
      {meta.label}
    </Badge>
  );
}

const STATUS_TONE: Record<string, string> = {
  online: 'bg-gn',
  success: 'bg-gn',
  running: 'bg-warn',
  paused: 'bg-warn',
  offline: 'bg-t3',
  error: 'bg-rd',
  canceled: 'bg-t3',
};

export function StatusDot({ status, pulse, className }: { status: PluginStatus | ExecutionState | 'paused'; pulse?: boolean; className?: string }) {
  return <span className={cn('inline-block size-2 shrink-0 rounded-full', STATUS_TONE[status] ?? 'bg-t3', pulse && 'animate-pulse-soft', className)} />;
}

export function executionTone(status: ExecutionState | 'paused'): Tone {
  return status === 'success' ? 'success' : status === 'error' ? 'danger' : status === 'paused' || status === 'running' ? 'warning' : 'muted';
}
