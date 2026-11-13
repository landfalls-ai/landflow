'use client';
/**
 * A number that sums something up (docs/ui-review.md#controls): Home's and Insights' KPI cards. The label, an icon tile
 * when given, the number (28 px), one line under it. `color` draws a 3 px bar on top and tints the icon.
 */
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Card } from '../shell/page-header';
import { SectionLabel } from './inputs';

export function StatCard({
  label,
  value,
  sub,
  icon,
  color,
  danger,
  index = 0,
  className,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  icon?: ReactNode;
  color?: string;
  danger?: boolean;
  index?: number;
  className?: string;
}) {
  return (
    <Card className={cn('relative animate-fade-up overflow-hidden', className)} style={{ animationDelay: `${index * 60}ms` }}>
      {color && <span className="absolute inset-x-0 top-0 h-[3px]" style={{ background: color }} />}
      <div className="flex min-h-7 items-center justify-between gap-2">
        <SectionLabel className="truncate">{label}</SectionLabel>
        {icon && (
          <span className="grid size-7 shrink-0 place-items-center rounded-lg" style={color ? { background: `color-mix(in oklab, ${color} 13%, var(--sf))`, color } : undefined}>
            {icon}
          </span>
        )}
      </div>
      <div className={cn('mt-1 text-[28px] font-semibold leading-none tabular-nums', danger ? 'text-rd' : 'text-t1')}>{value}</div>
      {sub && <div className="mt-2 flex flex-wrap items-center gap-x-1 text-[12px] text-t3">{sub}</div>}
    </Card>
  );
}
