import { redirect } from 'next/navigation';

/** The old /workflows/:id/executions[/:executionId] link: the run list is /workflows/:id/runs now. The query string is kept. */
export default async function LegacyExecutionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; executionId?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id, executionId } = await params;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, v);
  const search = query.size ? `?${query}` : '';
  redirect(`/workflows/${id}/runs${executionId?.[0] ? `/${encodeURIComponent(executionId[0])}` : ''}${search}`);
}
