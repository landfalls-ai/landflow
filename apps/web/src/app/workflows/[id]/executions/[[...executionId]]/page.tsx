import { ExecutionPreview } from '@/components/executions/execution-preview';

/** /workflows/:id/executions opens the newest execution; /workflows/:id/executions/:executionId a given one. */
export default async function WorkflowExecutionPage({ params }: { params: Promise<{ id: string; executionId?: string[] }> }) {
  const { id, executionId } = await params;
  return <ExecutionPreview workflowId={id} executionId={executionId?.[0]} />;
}
