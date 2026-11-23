/**
 * POST /api/settings/encryption/project-keys/[projectId]/rotate — a new key version for one project: its credentials
 * are re-sealed with it one at a time (no other project is touched) and the old version is retired.
 * The old version is only retired: a later sweep (migrate) deletes it. Owner only, session only. Each call makes one more
 * version; answers the new version, how many credentials moved and which could not. Audited fail-closed.
 */
import { requireUser } from '@/lib/server/auth';
import { projectKeys } from '@/lib/server/credentials/project-keys';
import { error, handler, json } from '@/lib/server/http';
import { getProject } from '@/lib/server/projects/store';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ projectId: string }> };

export const POST = handler(async (_request: Request, { params }: Ctx) => {
  const user = await requireUser();
  if (user.role !== 'owner') return error('Only the owner can rotate a project’s key', 403);
  const { projectId } = await params;
  if (!getProject(projectId)) return error('Project not found', 404);
  const result = await projectKeys.rotate(projectId);
  return json({ ...result, done: result.failed.length === 0 });
});
