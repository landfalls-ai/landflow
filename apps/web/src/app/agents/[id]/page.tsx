import { AgentBuilder } from '@/components/agents/builder';
import { mapLegacyTab } from '@/components/agents/tabs';

/** /agents/:id opens the builder; `?tab=activity&view=evaluations` or the older `?tab=sessions&session=<id>` open Activity. */
export default async function AgentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; session?: string; view?: string }>;
}) {
  const [{ id }, { tab, session, view }] = await Promise.all([params, searchParams]);
  return <AgentBuilder key={id} agentId={id} initialTarget={mapLegacyTab(tab, session, view)} initialSession={session} />;
}
