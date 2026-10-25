/** DELETE /api/users/invites/<id> (owners and admins): revoke a pending invite; its link stops working. */
import { deleteInvite, requireUser } from '@/lib/server/auth';
import { error, handler, json } from '@/lib/server/http';
import { recordAudit } from '@/lib/server/audit';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const DELETE = handler(async (_request: Request, { params }: Ctx) => {
  await requireUser('users:manage');
  const { id } = await params;
  if (!deleteInvite(id)) return error('Invite not found', 404);
  recordAudit({ action: 'user.invite_revoke', target: { type: 'invite', id } });
  return json({ ok: true });
});
