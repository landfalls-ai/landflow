'use client';
/**
 * How a canvas group looks, shared by the editor and the read-only canvases (executions, version and template
 * previews): a tinted frame with its label on top, or, collapsed, a compact box with the name, the node count and the
 * icons of its first nodes. Groups never run: they live in `workflow.groups`, beside the nodes. Colours come from the
 * sticky-note palette, lighter, so a frame stays behind what it holds. On the read-only canvases a collapsed box also
 * sums up how its nodes ran (`status`): a red outline when one failed, blue while one waits, and so on. A composite
 * (docs/composites.md) adds its type to the header (`badge`) and, collapsed, its named outputs.
 */
import type { CSSProperties, ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { NodeIcon } from '../ui/icon';
import { STICKY_COLORS } from './sticky-note';
import { plural } from '@/lib/client/format';

/** Fill, border, label and swatch colours of palette entry `index`. */
export function groupColors(index = 0) {
  const { base } = STICKY_COLORS[Math.max(0, Math.min(STICKY_COLORS.length - 1, index))] ?? STICKY_COLORS[0];
  const neutral = index === 0;
  return {
    fill: `color-mix(in oklab, ${base} ${neutral ? 4 : 7}%, transparent)`,
    border: `color-mix(in oklab, ${base} ${neutral ? 24 : 42}%, transparent)`,
    label: neutral ? 'var(--t2)' : `color-mix(in oklab, ${base} 70%, var(--t1))`,
    swatch: neutral ? 'var(--bd)' : `color-mix(in oklab, ${base} 55%, var(--sf))`,
  };
}


export interface GroupFrameViewProps {
  name: string;
  color?: number;
  count: number;
  selected?: boolean;
  /** Replaces the label (the editor's rename field). */
  label?: ReactNode;
  /** Buttons at the right end of the header. */
  actions?: ReactNode;
  /** After the count: a composite's type and how its contract stands. */
  badge?: ReactNode;
  /** Class of the header, e.g. the editor's drag handle. */
  headerClassName?: string;
  className?: string;
  style?: CSSProperties;
  onHeaderDoubleClick?: () => void;
  /** In the body: a composite's placeholders for its empty slots. They take the pointer; the rest of the body doesn't. */
  children?: ReactNode;
}

/** An expanded group: fills its React Flow node. Only the header takes the pointer; the body lets clicks through to the canvas. */
export function GroupFrameView({ name, color = 0, count, selected, label, actions, badge, headerClassName, className, style, onHeaderDoubleClick, children }: GroupFrameViewProps) {
  const colors = groupColors(color);
  return (
    <div
      className={cn(
        'pointer-events-none relative size-full rounded-[22px] border-[1.5px] transition-shadow duration-150',
        selected && 'shadow-[0_0_0_2px_var(--sf),0_0_0_4px_var(--acbd)]',
        className,
      )}
      style={{ background: colors.fill, borderColor: colors.border, ...style }}
    >
      <div
        onDoubleClick={onHeaderDoubleClick}
        className={cn('pointer-events-auto absolute inset-x-0 top-0 flex h-11 items-center gap-2 rounded-t-[22px] pl-4 pr-2', headerClassName)}
      >
        <span className="size-2.5 shrink-0 rounded-full" style={{ background: colors.swatch, boxShadow: `0 0 0 1px ${colors.border}` }} />
        {label ?? <span className="min-w-0 truncate text-[13.5px] font-semibold tracking-[-0.01em]" style={{ color: colors.label }}>{name}</span>}
        <span className="shrink-0 font-mono text-[11px] text-t3">{count}</span>
        {badge}
        <span className="flex-1" />
        {actions}
      </div>
      {children}
    </div>
  );
}

/** A composite's type in a frame's header: its icon and name, and on the read-only canvases nothing more. */
export function CompositeBadge({ icon, label, title, tone, children, onClick }: { icon?: string; label: string; title?: string; tone?: 'error' | 'warning' | 'ok'; children?: ReactNode; onClick?: () => void }) {
  const Tag = onClick ? 'button' : 'span';
  return (
    <Tag
      {...(onClick && { type: 'button' as const, onClick })}
      title={title}
      className={cn(
        'nodrag flex h-6 min-w-0 shrink items-center gap-1.5 rounded-full border bg-sf px-2 text-[11.5px] font-medium text-t2',
        onClick && 'transition-colors hover:text-t1',
        tone === 'error' ? 'border-rdbd' : tone === 'warning' ? 'border-warnbd' : 'border-hair',
      )}
    >
      <NodeIcon icon={icon ?? 'lucide:boxes'} size={12} />
      <span className="truncate">{label}</span>
      {children}
    </Tag>
  );
}

/** How a collapsed group's nodes ran: its outline colour and a few words in place of the node count. */
export interface GroupBoxStatus {
  tone: 'error' | 'paused' | 'running' | 'waiting' | 'success' | 'idle';
  label: string;
  /** Longer text for the tooltip. */
  title?: string;
}

const TONE: Record<GroupBoxStatus['tone'], { border?: string; ring?: string; text: string }> = {
  error: { border: 'var(--rd)', ring: 'var(--rddim)', text: 'text-rd' },
  paused: { border: 'var(--warn)', ring: 'var(--warndim)', text: 'text-warn' },
  running: { border: 'var(--warn)', ring: 'var(--warndim)', text: 'text-warn' },
  waiting: { border: 'var(--viz-1)', ring: 'color-mix(in oklab, var(--viz-1) 16%, transparent)', text: 'text-viz-1' },
  success: { border: 'var(--gn)', text: 'text-gn' },
  idle: { text: 'text-t3' },
};

export interface GroupBoxViewProps {
  name: string;
  color?: number;
  count: number;
  /** Read-only canvases: how its nodes ran. */
  status?: GroupBoxStatus;
  /** Icon and colour of the first nodes, shown in a row. */
  icons: { icon?: string; color: string }[];
  selected?: boolean;
  label?: ReactNode;
  actions?: ReactNode;
  className?: string;
  /** Extra content: the editor's connection handles. */
  children?: ReactNode;
  onDoubleClick?: () => void;
}

/** A collapsed group: one compact box standing in for its nodes, their connections drawn to its edges. */
export function GroupBoxView({ name, color = 0, count, status, icons, selected, label, actions, className, children, onDoubleClick }: GroupBoxViewProps) {
  const colors = groupColors(color);
  const shown = icons.slice(0, 5);
  const tone = status ? TONE[status.tone] : undefined;
  return (
    <div
      onDoubleClick={onDoubleClick}
      title={status?.title}
      className={cn(
        'pointer-events-auto relative flex size-full flex-col justify-center gap-1.5 rounded-[18px] border-[1.5px] bg-sf px-3.5 shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-shadow duration-150',
        selected && 'shadow-[0_0_0_2px_var(--sf),0_0_0_4px_var(--acbd)]',
        status?.tone === 'error' && 'animate-shake',
        status?.tone === 'paused' && 'animate-pulse-soft',
        className,
      )}
      style={{
        borderColor: tone?.border ?? colors.border,
        backgroundImage: `linear-gradient(${colors.fill}, ${colors.fill})`,
        ...(tone?.ring && !selected && { boxShadow: `0 0 0 4px ${tone.ring}` }),
      }}
    >
      <div className="flex items-center gap-2">
        <span className="size-2.5 shrink-0 rounded-full" style={{ background: colors.swatch, boxShadow: `0 0 0 1px ${colors.border}` }} />
        {label ?? <span className="min-w-0 flex-1 truncate text-[13px] font-semibold tracking-[-0.01em]" style={{ color: colors.label }}>{name}</span>}
        {actions ?? <ChevronRight className="size-3.5 shrink-0 text-t3" />}
      </div>
      <div className="flex items-center gap-1">
        {shown.map((item, i) => (
          <span key={i} className="grid size-6 place-items-center rounded-[7px] border border-hair bg-sf">
            <NodeIcon icon={item.icon} size={13} style={{ color: item.color }} />
          </span>
        ))}
        {icons.length > shown.length && <span className="px-0.5 font-mono text-[10.5px] text-t3">+{icons.length - shown.length}</span>}
        {status ? (
          <span className={cn('ml-auto min-w-0 truncate text-[11.5px] font-medium', tone?.text)}>{status.label}</span>
        ) : (
          <span className="ml-auto text-[11.5px] text-t3">{plural(count, 'node')}</span>
        )}
      </div>
      {children}
    </div>
  );
}
