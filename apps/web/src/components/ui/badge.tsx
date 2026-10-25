import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { languageMeta, TRANSPORT_META } from '@/lib/client/format';
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

export function TransportBadge({ transport, className }: { transport: Transport; className?: string }) {
  return (
    <Badge tone="muted" className={cn('font-mono font-medium', className)}>
      {TRANSPORT_META[transport].label}
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
  running: 'bg-ac',
  paused: 'bg-warn',
  offline: 'bg-t3',
  error: 'bg-rd',
  canceled: 'bg-t3',
};

export function StatusDot({ status, pulse, className }: { status: PluginStatus | ExecutionState | 'paused'; pulse?: boolean; className?: string }) {
  return <span className={cn('inline-block size-2 shrink-0 rounded-full', STATUS_TONE[status] ?? 'bg-t3', pulse && 'animate-pulse-soft', className)} />;
}

export function executionTone(status: ExecutionState | 'paused'): Tone {
  return status === 'success' ? 'success' : status === 'error' ? 'danger' : status === 'paused' ? 'warning' : status === 'running' ? 'accent' : 'muted';
}
