import type { CSSProperties, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * The 52px top bar every page starts with: title on the left, actions on the right. On a phone it is the app bar: the
 * title (whole, at 17px) and the last action (the page's main one) on the first row, the other actions on the next, then
 * the meta line. CSS only (the actions' box becomes `contents`, its children order themselves), so nothing remounts and
 * the desktop bar is as it was.
 */
export function PageHeader({ title, meta, actions, className }: { title: ReactNode; meta?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <header
      className={cn(
        'sticky top-0 z-20 flex h-[52px] shrink-0 items-center gap-3 border-b border-hair bg-bg px-6',
        // Phone: rows, broken after the title and main action by the ::after.
        "max-md:h-auto max-md:min-h-12 max-md:flex-wrap max-md:gap-x-2 max-md:gap-y-1.5 max-md:px-4 max-md:py-2 max-md:after:order-1 max-md:after:basis-full max-md:after:content-['']",
        className,
      )}
    >
      <h1 className="truncate text-[15px] font-semibold text-t1 max-md:min-w-0 max-md:flex-1 max-md:text-[17px]">{title}</h1>
      {meta && <div className="flex min-w-0 items-center gap-2 text-[12px] text-t3 max-md:order-3 max-md:w-full max-md:overflow-hidden max-md:whitespace-nowrap">{meta}</div>}
      {actions && <div className="ml-auto flex shrink-0 items-center gap-2 max-md:contents max-md:[&>*]:order-2 max-md:[&>*:last-child]:order-none max-md:[&>*:has(input)]:min-w-0 max-md:[&>*:has(input)]:flex-1 max-md:[&>*:has(input)_input]:h-9 max-md:[&>*:has(input)_input]:w-full">{actions}</div>}
    </header>
  );
}

export function PageBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('px-6 py-5 max-md:px-4', className)}>{children}</div>;
}

export function Card({ children, className, style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <div className={cn('rounded-2xl border border-hair bg-sf px-4 py-3.5', className)} style={style}>
      {children}
    </div>
  );
}
