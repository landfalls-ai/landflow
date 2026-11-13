import type { CSSProperties, ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The way back from a detail page (docs/ui-review.md#page-layout): ← and the parent's name, then "/" before the page's own
 * title. A phone shows the arrow alone, 44 px.
 */
export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <>
      <Link
        href={href}
        aria-label={`Back to ${label}`}
        className="flex shrink-0 items-center gap-1 rounded-full px-1.5 py-1 text-[13px] font-normal text-t2 transition-colors hover:bg-acdim hover:text-t1 max-md:-ml-2.5 max-md:size-11 max-md:justify-center max-md:p-0"
      >
        <ArrowLeft className="size-4" />
        <span className="max-md:hidden">{label}</span>
      </Link>
      <span aria-hidden className="shrink-0 font-normal text-t3 max-md:hidden">
        /
      </span>
    </>
  );
}

/**
 * The 52px top bar every page starts with: title on the left, actions on the right. On a phone it is the app bar: the
 * title (whole, at 17px) and the last action (the page's main one) on the first row, the other actions on the next, then
 * the meta line. CSS only (the actions' box becomes `contents`, its children order themselves), so nothing remounts and
 * the desktop bar is as it was. Its buttons and links are 44 px tall on a phone; a hidden file input among the actions
 * doesn't count as the last one. `back` puts the way back (BackLink) before the title, on a detail page.
 */
export function PageHeader({ title, meta, actions, back, className }: { title: ReactNode; meta?: ReactNode; actions?: ReactNode; back?: { href: string; label: string }; className?: string }) {
  const heading = <h1 className="truncate text-[15px] font-semibold text-t1 max-md:min-w-0 max-md:flex-1 max-md:text-[17px]">{title}</h1>;
  return (
    <header
      className={cn(
        'sticky top-0 z-20 flex h-[52px] shrink-0 items-center gap-3 border-b border-hair bg-bg px-6',
        // Phone: rows, broken after the title and main action by the ::after.
        "max-md:h-auto max-md:min-h-12 max-md:flex-wrap max-md:gap-x-2 max-md:gap-y-1.5 max-md:px-4 max-md:py-2 max-md:after:order-1 max-md:after:basis-full max-md:after:content-['']",
        className,
      )}
    >
      {back ? (
        <div className="flex min-w-0 items-center gap-1.5 max-md:flex-1">
          <BackLink {...back} />
          {heading}
        </div>
      ) : (
        heading
      )}
      {meta && <div className="flex min-w-0 items-center gap-2 text-[12px] text-t3 max-md:order-3 max-md:w-full max-md:overflow-hidden max-md:whitespace-nowrap">{meta}</div>}
      {actions && <div className="ml-auto flex shrink-0 items-center gap-2 max-md:contents max-md:[&>*]:order-2 max-md:[&>*:nth-last-child(1_of_:not(input[type=file]))]:order-none max-md:[&>*:has(input:not([type=file]))]:min-w-0 max-md:[&>*:has(input:not([type=file]))]:flex-1 max-md:[&>*:has(input:not([type=file]))_input]:w-full max-md:[&_a]:min-h-11 max-md:[&_button:not([role=switch])]:min-h-11">{actions}</div>}
    </header>
  );
}

/**
 * A page's content under its header: 24 px in, 16 px on a phone. `narrow` (a list of settings, records or a form) stops
 * at 980 px, left-aligned like every other page; the default fills the width (grids, tables, canvases).
 */
export function PageBody({ children, className, width = 'full' }: { children: ReactNode; className?: string; width?: 'full' | 'narrow' }) {
  return <div className={cn('px-6 py-5 max-md:px-4', width === 'narrow' && 'max-w-[980px]', className)}>{children}</div>;
}

export function Card({ children, className, style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <div className={cn('rounded-2xl border border-hair bg-sf px-4 py-3.5', className)} style={style}>
      {children}
    </div>
  );
}
