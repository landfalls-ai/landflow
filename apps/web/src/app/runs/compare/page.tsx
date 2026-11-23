import { redirect } from 'next/navigation';
import { RunCompare } from '@/components/run-trace/run-compare';
import { PageHeader } from '@/components/shell/page-header';
import { compareRedirect } from '@/components/runs/runs-query';

/** /runs/compare?a=&b=: two runs side by side (docs/run-trace.md). With fewer than two it goes back to the list. */
export default async function CompareRunsPage({ searchParams }: { searchParams: Promise<{ a?: string; b?: string }> }) {
  const { a, b } = await searchParams;
  const back = compareRedirect({ a, b });
  if (back) redirect(back);
  return (
    <>
      <PageHeader back={{ href: '/runs', label: 'Runs' }} title="Compare runs" />
      <RunCompare a={a ?? ''} b={b ?? ''} />
    </>
  );
}
