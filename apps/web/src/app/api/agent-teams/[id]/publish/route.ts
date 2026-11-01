/** Publish the draft as a new version (what flows run), refused with the `issues` while the team can't run. */
import { AgentTeamError, agentTeamStore } from '@/lib/server/agent-teams/store';
import { error, handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const POST = handler(async (_request: Request, { params }: Ctx) => {
  try {
    const team = agentTeamStore.publish((await params).id);
    return team ? json({ team }) : error('Agent team not found', 404);
  } catch (caught) {
    if (caught instanceof AgentTeamError) return error(caught.message, 400, { issues: caught.issues });
    throw caught;
  }
});
