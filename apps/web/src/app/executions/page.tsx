import { redirect } from 'next/navigation';
import { executionsRedirect } from '@/components/runs/runs-query';

/** /executions is Runs now: the query is kept, and `?id=` opens that run (docs/run-trace.md#the-runs-list). */
export default async function ExecutionsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  redirect(executionsRedirect(await searchParams));
}
