import { AgentBuilder } from '@/components/agents/builder';
import { mapLegacyTab } from '@/components/agents/tabs';

/** /agents/:id opens the builder (AG12: `?tab=abilities&open=<row>&tool=<id>` opens an Abilities row and outlines a tool); `?tab=activity&view=evaluations` or the older `?tab=sessions&session=<id>` open Activity. */
export default async function AgentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; session?: string; view?: string; open?: string; tool?: string }>;
}) {
  const [{ id }, { tab, session, view, open, tool }] = await Promise.all([params, searchParams]);
  return <AgentBuilder key={id} agentId={id} initialTarget={mapLegacyTab(tab, session, view, open, tool)} initialSession={session} />;
}
