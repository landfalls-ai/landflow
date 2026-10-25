/** DELETE /api/users/invites/<id> (owners and admins): revoke a pending invite; its link stops working. */
import { deleteInvite, requireUser } from '@/lib/server/auth';
import { error, handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const DELETE = handler(async (_request: Request, { params }: Ctx) => {
  await requireUser('users:manage');
  return deleteInvite((await params).id) ? json({ ok: true }) : error('Invite not found', 404);
});
