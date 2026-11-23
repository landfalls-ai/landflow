/** GET /api/workflows/:id/git-history/:commit?path= — a commit's message, the unified diff of this workflow's file in it, and the workflow as it was then. */
import { handler, json } from '@/lib/server/http';
import { workflowGitCommit } from '@/lib/server/sync/git';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string; commit: string }> };

export const GET = handler(async (request: Request, { params }: Ctx) => {
  const { id, commit } = await params;
  const path = new URL(request.url).searchParams.get('path') ?? '';
  return json(await workflowGitCommit(id, commit, path));
});
