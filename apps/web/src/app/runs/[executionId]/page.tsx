import { RunPage } from '@/components/run-trace/run-page';

/** /runs/:executionId: the Run Trace of one execution, full screen (made for a phone). */
export default async function RunTracePage({ params }: { params: Promise<{ executionId: string }> }) {
  const { executionId } = await params;
  return <RunPage executionId={executionId} />;
}
