'use client';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';

/**
 * n8n's "Editor | Executions" switch, centred in a workflow's top bar.
 * `beforeLeave` lets the editor save unsaved changes before switching.
 */
export function WorkflowTabs({ workflowId, active, beforeLeave, className }: { workflowId: string; active: 'editor' | 'executions'; beforeLeave?: () => Promise<unknown>; className?: string }) {
  const router = useRouter();
  const go = async (tab: 'editor' | 'executions') => {
    if (tab === active) return;
    await beforeLeave?.();
    router.push(tab === 'editor' ? `/workflows/${workflowId}` : `/workflows/${workflowId}/executions`);
  };
  return (
    <div role="tablist" className={cn('flex items-center gap-0.5 rounded-full border border-hair bg-sf2 p-0.5', className)}>
      {(['editor', 'executions'] as const).map((tab) => (
        <button
          key={tab}
          role="tab"
          aria-selected={tab === active}
          onClick={() => void go(tab)}
          className={cn(
            'h-7 rounded-full px-3.5 text-[13px] capitalize text-t2 transition-all duration-200 hover:text-t1',
            tab === active && 'bg-sf font-semibold text-t1 shadow-[0_1px_3px_rgba(0,0,0,0.08),0_0_0_1px_var(--hair)]',
          )}
        >
          {tab}
        </button>
      ))}
    </div>
  );
}
