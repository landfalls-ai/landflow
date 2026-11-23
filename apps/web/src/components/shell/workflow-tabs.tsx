'use client';
import { useRouter } from 'next/navigation';
import { Segmented } from '../ui/segmented';

/**
 * The "Editor | Runs | Tests" switch, centred in a workflow's top bar.
 * `beforeLeave` lets the editor save unsaved changes before switching.
 */
export type WorkflowTab = 'editor' | 'runs' | 'tests';

/** Where a workflow tab lives. */
export const workflowTabPath = (workflowId: string, tab: WorkflowTab) => (tab === 'editor' ? `/workflows/${workflowId}` : `/workflows/${workflowId}/${tab}`);

export function WorkflowTabs({ workflowId, active, beforeLeave, className }: { workflowId: string; active: WorkflowTab; beforeLeave?: () => Promise<unknown>; className?: string }) {
  const router = useRouter();
  const go = async (tab: WorkflowTab) => {
    if (tab === active) return;
    await beforeLeave?.();
    router.push(workflowTabPath(workflowId, tab));
  };
  return (
    <Segmented
      label="Workflow"
      className={className}
      value={active}
      onChange={(tab) => void go(tab)}
      options={[
        { value: 'editor', label: 'Editor' },
        { value: 'runs', label: 'Runs' },
        { value: 'tests', label: 'Tests' },
      ]}
    />
  );
}
