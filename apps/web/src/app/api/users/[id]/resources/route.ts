/**
 * GET /api/users/<id>/resources (owners and admins) — what the user's personal project owns, by kind, so removing
 * them can ask where it goes: `{ projectId, counts: { workflow?, credential?, dataTable?, agent? }, total }`.
 */
import { personalProjectId } from '@/lib/shared/projects';
import { getUser, requireUser } from '@/lib/server/auth';
import { error, handler, json } from '@/lib/server/http';
import { ownedBy } from '@/lib/server/projects';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  await requireUser('users:manage');
  const user = getUser((await params).id);
  if (!user) return error('User not found', 404);
  const counts = ownedBy(user.id);
  return json({ projectId: personalProjectId(user.id), counts, total: Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0) });
});
