import { ExecutionPreview } from '@/components/executions/execution-preview';

/** /workflows/:id/runs opens the newest run; /workflows/:id/runs/:executionId a given one. */
export default async function WorkflowRunPage({ params }: { params: Promise<{ id: string; executionId?: string[] }> }) {
  const { id, executionId } = await params;
  return <ExecutionPreview workflowId={id} executionId={executionId?.[0]} />;
}
