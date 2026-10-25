import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function EmptyState({ title, hint, action, compact, className }: { title: ReactNode; hint?: ReactNode; action?: ReactNode; compact?: boolean; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center text-center text-t2', compact ? 'gap-1 p-4' : 'gap-2 px-4 py-8', className)}>
      <p className={cn('font-semibold text-t1', compact ? 'text-[13px]' : 'text-[15px]')}>{title}</p>
      {hint && <p className="max-w-[48ch] text-[13px] leading-snug">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
