'use client';
/**
 * The modal frame the Data Tables page uses (same look as the credential
 * dialog): portalled, Escape and a click outside close it, plus a small
 * confirmation dialog for destructive actions.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Trash2, X } from 'lucide-react';
import { Button } from '../ui/button';
import { useDialogFocus } from '../ui/use-dialog-focus';
import { usePhone } from '@/lib/client/use-phone';

export function Dialog({ title, subtitle, icon, onClose, children, footer, width = 520 }: { title: ReactNode; subtitle?: ReactNode; icon?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number }) {
  const panel = useRef<HTMLDivElement>(null);
  const phone = usePhone();
  // A phone: a bottom sheet that keeps the focus inside (docs/mobile.md#sheets-and-dialogs).
  useDialogFocus(panel, phone);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-6 animate-in max-md:items-end max-md:p-0" onMouseDown={onClose}>
      <div
        ref={panel}
        role="dialog"
        aria-modal={phone || undefined}
        aria-label={typeof title === 'string' ? title : undefined}
        onMouseDown={(e) => e.stopPropagation()}
        style={{ width }}
        className="flex max-h-[min(760px,90vh)] max-w-full flex-col overflow-hidden rounded-2xl border border-hair bg-sf shadow-pop animate-panel max-md:!w-full max-md:!max-w-none max-md:max-h-[92dvh] max-md:rounded-b-none max-md:pb-[env(safe-area-inset-bottom)]"
      >
        <header className="flex items-center gap-3 border-b border-hair px-5 py-3.5">
          {icon}
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[15px] font-semibold text-t1">{title}</h2>
            {subtitle && <p className="truncate text-[12px] text-t3">{subtitle}</p>}
          </div>
          <Button size="icon-sm" variant="ghost" onClick={onClose} aria-label="Close" className="max-md:size-11">
            <X className="size-4" />
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="flex items-center justify-end gap-2 border-t border-hair px-5 py-3">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

/** "Delete …?" with a danger button. */
export function ConfirmDialog({ title, message, action = 'Delete', busy, onConfirm, onClose }: { title: string; message: ReactNode; action?: string; busy?: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <Dialog
      title={title}
      onClose={onClose}
      width={420}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} loading={busy} autoFocus>
            <Trash2 className="size-3.5" /> {action}
          </Button>
        </>
      }
    >
      <p className="text-[13px] leading-relaxed text-t2">{message}</p>
    </Dialog>
  );
}
