import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { RunCompare } from '@/components/run-trace/run-compare';
import { PageHeader } from '@/components/shell/page-header';

/** /runs/compare?a=&b=: two runs side by side (docs/run-trace.md). */
export default async function CompareRunsPage({ searchParams }: { searchParams: Promise<{ a?: string; b?: string }> }) {
  const { a, b } = await searchParams;
  return (
    <>
      <PageHeader
        title="Compare runs"
        className="px-4 md:px-6"
        actions={
          <Link href="/runs" className="inline-flex h-9 items-center gap-1.5 rounded-full px-2.5 text-[13px] text-t2 hover:bg-acdim hover:text-t1">
            <ArrowLeft className="size-4" /> Search
          </Link>
        }
      />
      <RunCompare a={a ?? ''} b={b ?? ''} />
    </>
  );
}
