import { AgentBuilder, type BuilderTab } from '@/components/agents/builder';

const TABS: BuilderTab[] = ['persona', 'abilities', 'deploy', 'safety', 'sessions', 'evaluations'];
/** Tabs older links name, from before the Persona tab. */
const RENAMED: Record<string, BuilderTab> = { build: 'persona', settings: 'safety' };

/** /agents/:id opens the builder; `?tab=sessions&session=<id>` opens a session. */
export default async function AgentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string; session?: string }> }) {
  const [{ id }, { tab, session }] = await Promise.all([params, searchParams]);
  const named = tab ? (RENAMED[tab] ?? tab) : undefined;
  const initialTab = TABS.includes(named as BuilderTab) ? (named as BuilderTab) : session ? 'sessions' : 'persona';
  return <AgentBuilder key={id} agentId={id} initialTab={initialTab} initialSession={session} />;
}
