import { AgentBuilder, type BuilderTab } from '@/components/agents/builder';

const TABS: BuilderTab[] = ['build', 'sessions', 'settings', 'evaluations'];

/** /agents/:id opens the builder; `?tab=sessions&session=<id>` opens a session. */
export default async function AgentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string; session?: string }> }) {
  const [{ id }, { tab, session }] = await Promise.all([params, searchParams]);
  const initialTab = TABS.includes(tab as BuilderTab) ? (tab as BuilderTab) : session ? 'sessions' : 'build';
  return <AgentBuilder key={id} agentId={id} initialTab={initialTab} initialSession={session} />;
}
