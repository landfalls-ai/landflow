import type { ReactNode } from 'react';
import { ExecutionsShell } from '@/components/executions/executions-shell';

/** The shell (top bar + execution list) persists while moving between executions. */
export default async function WorkflowExecutionsLayout({ children, params }: { children: ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ExecutionsShell workflowId={id}>{children}</ExecutionsShell>;
}
