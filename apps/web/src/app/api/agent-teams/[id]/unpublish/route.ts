import { agentTeamStore } from '@/lib/server/agent-teams/store';
import { error, handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** Stop flows from running the team; the draft and the version count stay. */
export const POST = handler(async (_request: Request, { params }: Ctx) => {
  const team = agentTeamStore.unpublish((await params).id);
  return team ? json({ team }) : error('Agent team not found', 404);
});
