import type { ReactNode } from 'react';
import { ExecutionsShell } from '@/components/executions/executions-shell';

/** The shell (top bar + run list) persists while moving between runs. */
export default async function WorkflowRunsLayout({ children, params }: { children: ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ExecutionsShell workflowId={id}>{children}</ExecutionsShell>;
}
