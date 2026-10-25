/**
 * POST /api/workflows/:id/versions/:versionId/restore — put an older version's
 * nodes, connections, settings, sticky notes and pin data back. The current
 * name, tags, folder and active state stay. The restore is saved, so it
 * becomes the newest version (marked "Restored version N").
 */
import { error, handler, json } from '@/lib/server/http';
import { store } from '@/lib/server/store';
import { applyVersion, getVersion, listVersions, markRestored } from '@/lib/server/versions';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string; versionId: string }> };

export const POST = handler(async (_request: Request, { params }: Ctx) => {
  const { id, versionId } = await params;
  const current = store.getWorkflow(id);
  if (!current) return error('Workflow not found', 404);
  const version = getVersion(id, versionId);
  if (!version) return error('Version not found', 404);
  const newestBefore = listVersions(id)[0]?.id;
  const workflow = store.saveWorkflow(applyVersion(current, version));
  // The save recorded a new version unless the restored content equals the newest one.
  const newest = listVersions(id)[0];
  const marked = newest && newest.id !== newestBefore ? markRestored(id, newest.id, { id: version.id, number: version.number }) : undefined;
  return json({ workflow, ...(marked && { version: marked }) });
});
