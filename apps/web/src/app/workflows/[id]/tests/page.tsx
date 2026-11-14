import { EvaluationsPage } from '@/components/evaluations/evaluations-page';

/** /workflows/:id/tests: the workflow's tests (evaluation runs, run comparisons and AI Agent grading). */
export default async function WorkflowTestsPage({ params }: { params: Promise<{ id: string }> }) {
  return <EvaluationsPage workflowId={(await params).id} />;
}
