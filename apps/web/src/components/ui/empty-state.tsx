import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Nothing here yet (docs/ui-review.md#empty-states): an optional icon in a round tile, one line, one line of help and
 * at most one action. On a page it sits in a Card; its button is `outline` with the same label as the header's primary.
 */
export function EmptyState({ title, hint, action, icon, compact, className }: { title: ReactNode; hint?: ReactNode; action?: ReactNode; icon?: ReactNode; compact?: boolean; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center text-center text-t2', compact ? 'gap-1 p-4' : 'gap-2 px-4 py-8', className)}>
      {icon && <span className="mb-1 grid size-10 place-items-center rounded-full border border-hair bg-wl text-t2 [&>svg]:size-[18px]">{icon}</span>}
      <p className={cn('font-semibold text-t1', compact ? 'text-[13px]' : 'text-[15px]')}>{title}</p>
      {hint && <p className="max-w-[48ch] text-[13px] leading-snug">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
