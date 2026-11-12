'use client';
/**
 * A sheet: a dialog that rises from the bottom on a phone and sits in the middle on a desktop (docs/mobile.md). It has
 * the dialog role, keeps the focus inside while open (Tab wraps), closes on Escape or a tap on the backdrop, and gives
 * the focus back to what opened it. Portalled to <body>, so no scroll container clips it.
 */
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function Sheet({ open, onClose, title, children, footer, className }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; className?: string }) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // The latest onClose, without re-running the effect: an inline callback would move the focus on every render.
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const el = panel.current;
    el?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close.current();
      } else if (e.key === 'Tab' && el) {
        const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((i) => i.offsetParent !== null);
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    // The page under it doesn't scroll.
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = overflow;
      opener?.focus?.();
    };
  }, [open]);
  if (!open || typeof document === 'undefined') return null;
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-end justify-center md:items-center">
      <div className="absolute inset-0 bg-black/40 animate-in" onClick={onClose} aria-hidden />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cn(
          'relative flex max-h-[85dvh] w-full flex-col overflow-hidden border border-hair bg-sf shadow-pop animate-fade-up',
          'rounded-t-2xl pb-[env(safe-area-inset-bottom)] md:max-w-[480px] md:rounded-2xl md:pb-0',
          className,
        )}
      >
        <span className="mx-auto mt-2 block h-1 w-9 shrink-0 rounded-full bg-hair md:hidden" aria-hidden />
        <div className="flex shrink-0 items-center gap-2 px-4 pb-2 pt-2 md:pt-3">
          <h2 id={titleId} className="min-w-0 flex-1 truncate text-[16px] font-semibold text-t1">
            {title}
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="grid size-11 place-items-center rounded-full text-t3 hover:bg-acdim hover:text-t1">
            <X className="size-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">{children}</div>
        {footer && <div className="shrink-0 border-t border-hair px-4 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
