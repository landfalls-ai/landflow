/** GET /api/workflows/:id/versions — the workflow's saved versions, newest first, and which one is published. */
import { error, handler, json } from '@/lib/server/http';
import { publishedVersionId } from '@/lib/server/publications';
import { store } from '@/lib/server/store';
import { listVersions } from '@/lib/server/versions';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!store.getWorkflow(id)) return error('Workflow not found', 404);
  const published = publishedVersionId(id);
  return json({ versions: listVersions(id), ...(published && { publishedVersionId: published }) });
});
