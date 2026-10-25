import { EvaluationsPage } from '@/components/evaluations/evaluations-page';

/** /workflows/:id/evaluations: the workflow's evaluation runs, run comparisons and AI Agent grading. */
export default async function WorkflowEvaluationsPage({ params }: { params: Promise<{ id: string }> }) {
  return <EvaluationsPage workflowId={(await params).id} />;
}
