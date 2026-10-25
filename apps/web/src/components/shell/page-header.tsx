import type { CSSProperties, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** The 52px top bar every page starts with: title on the left, actions on the right. */
export function PageHeader({ title, meta, actions, className }: { title: ReactNode; meta?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <header className={cn('sticky top-0 z-20 flex h-[52px] shrink-0 items-center gap-3 border-b border-hair bg-bg px-6', className)}>
      <h1 className="truncate text-[15px] font-semibold text-t1">{title}</h1>
      {meta && <div className="flex min-w-0 items-center gap-2 text-[12px] text-t3">{meta}</div>}
      {actions && <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}

export function PageBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('px-6 py-5', className)}>{children}</div>;
}

export function Card({ children, className, style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <div className={cn('rounded-2xl border border-hair bg-sf px-4 py-3.5', className)} style={style}>
      {children}
    </div>
  );
}
