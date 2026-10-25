'use client';
/**
 * A small click-to-open popover for menus and confirmations. The panel is
 * portalled to <body> with fixed positioning, so scroll containers and
 * animated (transformed) ancestors can't clip or offset it.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

interface PopoverProps {
  trigger: (state: { open: boolean; toggle: () => void }) => ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: 'start' | 'end';
  className?: string;
}

export function Popover({ trigger, children, align = 'end', className }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left?: number; right?: number }>();
  const anchor = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);

  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const rect = anchor.current.getBoundingClientRect();
    setPos(align === 'end' ? { top: rect.bottom + 6, right: window.innerWidth - rect.right } : { top: rect.bottom + 6, left: rect.left });
  }, [open, align]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!panel.current?.contains(target) && !anchor.current?.contains(target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onScroll = (e: Event) => !panel.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', close);
    };
  }, [open, close]);

  return (
    <>
      <span ref={anchor} className="inline-flex">
        {trigger({ open, toggle: () => setOpen((o) => !o) })}
      </span>
      {open &&
        pos &&
        createPortal(
          <div
            ref={panel}
            role="menu"
            style={pos}
            className={cn('fixed z-50 min-w-[200px] animate-in rounded-xl border border-hair bg-sf p-1 text-[13px] shadow-pop', className)}
          >
            {typeof children === 'function' ? children(close) : children}
          </div>,
          document.body,
        )}
    </>
  );
}

export function MenuItem({ children, onClick, danger, disabled, hint }: { children: ReactNode; onClick: () => void; danger?: boolean; disabled?: boolean; hint?: ReactNode }) {
  return (
    <button
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex w-full items-start gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-t1 transition-colors disabled:cursor-not-allowed disabled:opacity-45 [&_svg]:mt-0.5 [&_svg]:size-3.5 [&_svg]:shrink-0',
        danger ? 'text-rd hover:bg-rddim' : 'hover:bg-acdim',
      )}
    >
      {children}
      {hint && <span className="ml-auto whitespace-nowrap pl-3 text-[11px] text-t3">{hint}</span>}
    </button>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">{children}</div>;
}

export function MenuSeparator() {
  return <div className="my-1 h-px bg-hair" />;
}
