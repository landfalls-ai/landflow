import { Suspense } from 'react';
import { TeamBuilder } from '@/components/agents/team-builder';

/** /agents/teams/:id opens a team: its goal, org chart and publishing. `?flow=` links the flow a template made for it. */
export default async function AgentTeamPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense>
      <TeamBuilder key={id} teamId={id} />
    </Suspense>
  );
}
