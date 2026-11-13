import { RunCompare } from '@/components/run-trace/run-compare';
import { PageHeader } from '@/components/shell/page-header';

/** /runs/compare?a=&b=: two runs side by side (docs/run-trace.md). */
export default async function CompareRunsPage({ searchParams }: { searchParams: Promise<{ a?: string; b?: string }> }) {
  const { a, b } = await searchParams;
  return (
    <>
      <PageHeader back={{ href: '/runs', label: 'Search runs' }} title="Compare runs" />
      <RunCompare a={a ?? ''} b={b ?? ''} />
    </>
  );
}
