import { redirect } from 'next/navigation';

/** The old /workflows/:id/evaluations link: the tab is Tests now. The query string is kept. */
export default async function LegacyEvaluationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, v);
  redirect(`/workflows/${encodeURIComponent(id)}/tests${query.size ? `?${query}` : ''}`);
}
