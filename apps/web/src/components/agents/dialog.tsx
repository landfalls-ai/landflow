'use client';
/** The agent builder's cards and rows; the dialog itself is the shared one (components/ui/dialog.tsx). */
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Switch } from '../ui/inputs';
export { Dialog, Field } from '../ui/dialog';

/** A setting with a switch on the right. */
export function ToggleRow({
  title,
  description,
  checked,
  onChange,
  disabled,
}: {
  title: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-[10px] border border-hair bg-wl px-3 py-2.5">
      <div className="min-w-0">
        <div className="text-[13px] font-semibold text-t1">{title}</div>
        {description && <div className="text-[12px] leading-snug text-t3">{description}</div>}
      </div>
      <Switch checked={checked} onChange={onChange} disabled={disabled} label={typeof title === 'string' ? title : undefined} />
    </div>
  );
}

/** A card of the Build tab. */
export function Section({
  icon,
  title,
  description,
  actions,
  children,
  className,
}: {
  icon: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('rounded-2xl border border-hair bg-sf animate-fade-up', className)}>
      <div className="flex flex-wrap items-start gap-3 px-4 pb-3 pt-3.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-[10px] border border-hair bg-wl text-t2">{icon}</span>
        {/* The title keeps room for its description: wide actions wrap under it instead. */}
        <div className="min-w-[min(100%,220px)] flex-1">
          <h2 className="text-[14px] font-semibold text-t1">{title}</h2>
          {description && <p className="text-[12px] leading-snug text-t3">{description}</p>}
        </div>
        {actions && <div className="flex max-w-full shrink-0 flex-wrap items-center gap-1.5">{actions}</div>}
      </div>
      {children && <div className="border-t border-hair px-4 py-3.5">{children}</div>}
    </section>
  );
}

/** A row of a Build-tab list (a skill, a tool, a schedule). */
export function ItemRow({
  icon,
  title,
  subtitle,
  badges,
  actions,
  onClick,
}: {
  icon: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  badges?: ReactNode;
  actions?: ReactNode;
  onClick?: () => void;
}) {
  return (
    <div className="group flex items-center gap-3 rounded-xl border border-hair bg-wl px-3 py-2 transition-colors hover:border-bd animate-in">
      {icon}
      <button type="button" onClick={onClick} disabled={!onClick} className="min-w-0 flex-1 text-left disabled:cursor-default">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[13px] font-semibold text-t1">{title}</span>
          {badges}
        </div>
        {subtitle && <div className="truncate text-[12px] text-t3">{subtitle}</div>}
      </button>
      {actions && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
    </div>
  );
}
