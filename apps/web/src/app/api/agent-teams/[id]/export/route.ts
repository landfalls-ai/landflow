/**
 * GET /api/agent-teams/:id/export?format=claude-plugin[&marketplace=1][&preview=1] — the team as a Claude Code plugin, a
 * zip: its Landflow agents' files, the skills they use, and `.landflow/team.json` with who reports to whom. Remote
 * (A2A) members are in `team.json` only. `preview=1` answers with the file list instead.
 */
import { agentTeamStore } from '@/lib/server/agent-teams/store';
import { error, handler } from '@/lib/server/http';
import { exportTeamPlugin } from '@/lib/server/marketplace/export';
import { exportQuery, exportResponse } from '@/lib/server/marketplace/export-http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (request: Request, { params }: Ctx) => {
  const query = exportQuery(request);
  if (query instanceof Response) return query;
  const team = agentTeamStore.get((await params).id);
  if (!team) return error('Agent team not found', 404);
  return exportResponse(exportTeamPlugin(team.draft, query.options), query.preview);
});
