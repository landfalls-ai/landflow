/**
 * POST /api/users/<id>/password-reset (owners and admins): make a one-hour password reset link for a user, emailed
 * when SMTP is configured and always returned as `link` to copy. The user's password stays until they use it.
 */
import { canManageUser } from '@/lib/shared/auth';
import { createResetToken, deliverLink, getUser, requireUser } from '@/lib/server/auth';
import { error, handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const me = await requireUser('users:manage');
  const target = getUser((await params).id);
  if (!target) return error('User not found', 404);
  if (!canManageUser(me, target, { kind: 'reset-password' })) return error('You can’t reset this user’s password', 403);
  const { token } = createResetToken(target, me.id);
  return json(await deliverLink('reset', { to: target.email, token, request }));
});
