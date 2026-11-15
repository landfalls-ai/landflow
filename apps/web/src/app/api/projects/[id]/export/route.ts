/**
 * GET /api/projects/:id/export?format=claude-plugin[&marketplace=1][&preview=1] — the project as a Claude Code plugin, a
 * zip: `PROJECT.md` (its brief and the goals it serves), `.claude-plugin/plugin.json`, and the `agents/` and `skills/` of
 * the agents whose home it is, with `.landflow/` for what only Landflow uses. No people, ids, settings, workspace or
 * secrets. Any role in the project (owners and admins: any); none is a 404. `preview=1` answers with the file list.
 */
import { handler } from '@/lib/server/http';
import { exportQuery, exportResponse } from '@/lib/server/marketplace/export-http';
import { exportProjectPlugin } from '@/lib/server/marketplace/project-export';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (request: Request, { params }: Ctx) => {
  const query = exportQuery(request);
  if (query instanceof Response) return query;
  return exportResponse(exportProjectPlugin((await params).id, routeActor(), query.options), query.preview);
});
