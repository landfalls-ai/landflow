'use client';
/**
 * A "?" button that opens a small popover (a bottom sheet on a phone) with the longer explanation, so a section can
 * say one sentence and keep the rest one tap away. A button with `aria-expanded`, so it works from the keyboard.
 */
import type { ReactNode } from 'react';
import { CircleHelp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Popover } from './popover';

/** What the popover shows: plain text, or anything (env vars in `<code>`). */
export function HelpTipBody({ children }: { children: ReactNode }) {
  return <div className="max-w-[320px] space-y-1.5 px-2.5 py-2 text-[12px] leading-relaxed text-t2 max-md:max-w-none max-md:px-0">{children}</div>;
}

export function HelpTipButton({ label, open, onClick, children, className }: { label: string; open: boolean; onClick?: () => void; children?: ReactNode; className?: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-expanded={open}
      aria-haspopup="dialog"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 rounded-full text-t3 transition-colors hover:text-t1 focus-visible:text-t1 relative after:absolute after:-inset-3 after:content-[""]',
        children ? 'text-[12px] font-medium' : 'size-5 justify-center',
        className,
      )}
    >
      {children ?? <CircleHelp className="size-3.5" strokeWidth={1.8} />}
    </button>
  );
}

/** `label` names the button for a screen reader; `children` is the explanation; `text` makes it a visible link ("How to set up ›"). */
export function HelpTip({ label = 'More about this', title, text, children, className }: { label?: string; title?: string; text?: string; children: ReactNode; className?: string }) {
  return (
    <Popover role="dialog" align="start" title={title ?? label} label={label} className="max-w-[340px]" trigger={({ open, toggle }) => (
      <HelpTipButton label={label} open={open} onClick={toggle} className={className}>
        {text}
      </HelpTipButton>
    )}>
      <HelpTipBody>{children}</HelpTipBody>
    </Popover>
  );
}
