'use client';
import { useRouter } from 'next/navigation';
import { Segmented } from '../ui/segmented';

/**
 * n8n's "Editor | Executions | Evaluations" switch, centred in a workflow's top bar.
 * `beforeLeave` lets the editor save unsaved changes before switching.
 */
export type WorkflowTab = 'editor' | 'executions' | 'evaluations';

export function WorkflowTabs({ workflowId, active, beforeLeave, className }: { workflowId: string; active: WorkflowTab; beforeLeave?: () => Promise<unknown>; className?: string }) {
  const router = useRouter();
  const go = async (tab: WorkflowTab) => {
    if (tab === active) return;
    await beforeLeave?.();
    router.push(tab === 'editor' ? `/workflows/${workflowId}` : `/workflows/${workflowId}/${tab}`);
  };
  return (
    <Segmented
      label="Workflow"
      className={className}
      value={active}
      onChange={(tab) => void go(tab)}
      options={[
        { value: 'editor', label: 'Editor' },
        { value: 'executions', label: 'Executions' },
        { value: 'evaluations', label: 'Evaluations' },
      ]}
    />
  );
}
