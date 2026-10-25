import { Suspense } from 'react';
import { WorkflowsList } from '@/components/workflows/workflows-list';

/** The list reads `?folder=` with useSearchParams, so it renders inside a Suspense boundary. */
export default function WorkflowsPage() {
  return (
    <Suspense>
      <WorkflowsList />
    </Suspense>
  );
}
