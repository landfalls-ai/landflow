/**
 * GET /api/workflows/:id/git-history?limit= — the commits of the source control branch that touched this workflow's file
 * (Settings → Source control), newest first with renames followed: `{ branch, path?, commits[] }`. Fetches the branch first.
 * `GET …/:commit?path=` is one commit's diff; `POST …/:commit/restore` brings that version back as a draft.
 */
import { z } from 'zod';
import { error, handler, json, parseQuery } from '@/lib/server/http';
import { limitParam } from '@/lib/server/pagination';
import { SourceControlError, workflowGitHistory } from '@/lib/server/sync/git';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (request: Request, { params }: Ctx) => {
  const query = parseQuery(request, z.object({ limit: limitParam(200, 50) }));
  if (!query.ok) return query.response;
  const { limit } = query.data;
  try {
    return json(await workflowGitHistory((await params).id, { limit }));
  } catch (caught) {
    if (caught instanceof SourceControlError) return error(caught.message, caught.status);
    throw caught;
  }
});
