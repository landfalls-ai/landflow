'use client';
/** The modal shell of the agent builder's dialogs, styled like the credential dialog. */
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Switch } from '../ui/inputs';

export function Dialog({
  title,
  subtitle,
  icon,
  onClose,
  children,
  footer,
  width = 560,
  bodyClassName,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  bodyClassName?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // Capture phase, and only for the topmost dialog: Escape closes a credential dialog opened from this one first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const dialogs = document.querySelectorAll('[role="dialog"]');
      if (dialogs[dialogs.length - 1] !== panel.current) return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-3 animate-in sm:p-6" onMouseDown={onClose}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[min(760px,92vh)] w-full flex-col overflow-hidden rounded-2xl border border-hair bg-sf shadow-pop animate-panel"
        style={{ maxWidth: width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-hair px-5 py-3.5">
          {icon}
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="truncate text-[15px] font-semibold text-t1">
              {title}
            </h2>
            {subtitle && <div className="truncate text-[12px] text-t3">{subtitle}</div>}
          </div>
          <button onClick={onClose} aria-label="Close" className="grid size-7 shrink-0 place-items-center rounded-full text-t3 hover:bg-acdim hover:text-t1">
            <X className="size-4" />
          </button>
        </div>
        <div className={cn('min-h-0 flex-1 overflow-y-auto px-5 py-4', bodyClassName)}>{children}</div>
        {footer && <div className="flex shrink-0 items-center justify-end gap-2 border-t border-hair px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** A labelled form row: the label is tied to its control with htmlFor. */
export function Field({
  id,
  label,
  required,
  hint,
  aside,
  children,
  className,
}: {
  id?: string;
  label: ReactNode;
  required?: boolean;
  hint?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="mb-[5px] flex items-center gap-2">
        <label htmlFor={id} className="text-[12px] font-semibold text-t2">
          {label}
          {required && <span className="text-rd"> *</span>}
        </label>
        {aside && <span className="ml-auto text-[11px] text-t3">{aside}</span>}
      </div>
      {children}
      {hint && <p className="mt-1 text-[12px] leading-snug text-t3">{hint}</p>}
    </div>
  );
}

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
        <div className="min-w-0 flex-1">
          <h2 className="text-[14px] font-semibold text-t1">{title}</h2>
          {description && <p className="text-[12px] leading-snug text-t3">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-1.5">{actions}</div>}
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
