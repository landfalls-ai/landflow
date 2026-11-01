import { Suspense } from 'react';
import { PageHeader } from '@/components/shell/page-header';
import { RunSearch } from '@/components/run-trace/run-search';

/** /runs: search the saved runs, compare two and see a workflow's runs over time (docs/run-trace.md). `?workflowId=` preselects one. */
export default async function RunsPage({ searchParams }: { searchParams: Promise<{ workflowId?: string }> }) {
  const { workflowId } = await searchParams;
  return (
    <>
      <PageHeader title="Search runs" className="px-4 md:px-6" />
      <Suspense>
        <RunSearch initialWorkflowId={workflowId ?? ''} />
      </Suspense>
    </>
  );
}
