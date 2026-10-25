/** GET /api/workflows/:id/versions/:versionId — one version with its workflow snapshot. */
import { error, handler, json } from '@/lib/server/http';
import { store } from '@/lib/server/store';
import { getVersion } from '@/lib/server/versions';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string; versionId: string }> };

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const { id, versionId } = await params;
  if (!store.getWorkflow(id)) return error('Workflow not found', 404);
  const version = getVersion(id, versionId);
  return version ? json({ version }) : error('Version not found', 404);
});
