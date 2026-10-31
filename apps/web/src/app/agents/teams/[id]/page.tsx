import { TeamBuilder } from '@/components/agents/team-builder';

/** /agents/teams/:id opens a team: its goal, org chart and publishing. */
export default async function AgentTeamPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TeamBuilder key={id} teamId={id} />;
}
