import { Suspense } from 'react';
import { RunsList } from '@/components/runs/runs-list';

/** /runs: every run, with one filter row; repeated failures fold into one row (docs/run-trace.md#the-runs-list). */
export default function RunsPage() {
  return (
    <Suspense>
      <RunsList />
    </Suspense>
  );
}
