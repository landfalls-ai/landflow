'use client';
/**
 * The dialog every page uses (docs/ui-review.md#dialogs): a header with the title (an icon before it when given, a
 * subtitle under it on up to two lines) and Close; the body; a footer of Cancel (ghost) and the action (primary). Escape
 * and a click outside close it, the topmost first. On a phone it rises as a bottom sheet that keeps the focus inside.
 */
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePhone } from '@/lib/client/use-phone';
import { useDialogFocus } from './use-dialog-focus';

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
  // A phone: a bottom sheet that keeps the focus inside (docs/mobile.md#sheets-and-dialogs).
  useDialogFocus(panel, usePhone());

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-3 animate-in sm:p-6 max-md:items-end max-md:p-0" onMouseDown={onClose}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[min(760px,92vh)] w-full flex-col overflow-hidden rounded-2xl border border-hair bg-sf shadow-pop animate-panel max-md:!max-w-none max-md:max-h-[92dvh] max-md:rounded-b-none max-md:pb-[env(safe-area-inset-bottom)]"
        style={{ maxWidth: width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-hair px-5 py-3.5">
          {icon}
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="truncate text-[15px] font-semibold text-t1">
              {title}
            </h2>
            {subtitle && <div className="line-clamp-2 text-[12px] leading-snug text-t3">{subtitle}</div>}
          </div>
          <button onClick={onClose} aria-label="Close" className="grid size-7 shrink-0 place-items-center rounded-full text-t3 hover:bg-acdim hover:text-t1 max-md:size-11">
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
