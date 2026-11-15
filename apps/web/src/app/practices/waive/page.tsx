import { WaiveForm } from '@/components/practices/waive-form';

/**
 * /practices/waive?practice=&execution=: waive a required practice that stopped a run (docs/practices.md#waiving-from-a-flow).
 * The link comes from the failed Check Practices step. A person who may approve the practice gives a reason; the waiver is for
 * that run only, and the run is retried from here.
 */
export default async function WaivePage({ searchParams }: { searchParams: Promise<{ practice?: string | string[]; execution?: string | string[] }> }) {
  const params = await searchParams;
  const one = (value?: string | string[]) => (Array.isArray(value) ? value[0] : value) ?? '';
  return <WaiveForm practiceId={one(params.practice)} executionId={one(params.execution)} />;
}
