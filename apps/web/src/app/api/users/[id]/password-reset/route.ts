/**
 * POST /api/users/<id>/password-reset (owners and admins): make a one-hour password reset link for a user, emailed
 * when SMTP is configured and always returned as `link` to copy. The user's password stays until they use it.
 */
import { canManageUser } from '@/lib/shared/auth';
import { createResetToken, deliverLink, getUser, linkOriginMissing, requireUser } from '@/lib/server/auth';
import { mayActOnUser } from '@/lib/server/auth/user-scope';
import { isInstanceAdmin } from '@/lib/server/projects/access';
import { error, handler, json } from '@/lib/server/http';
import { recordAudit } from '@/lib/server/audit';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const me = await requireUser('users:manage');
  const target = getUser((await params).id);
  if (!target) return error('User not found', 404);
  if (!canManageUser(me, target, { kind: 'reset-password' })) return error('You can’t reset this user’s password', 403);
  if (!mayActOnUser(me, target)) return error('This person belongs to projects you don’t administer', 403);
  const missing = linkOriginMissing();
  if (missing) return error(missing, 503);
  const { token } = createResetToken(target, me.id);
  const delivered = await deliverLink('reset', { to: target.email, token, request });
  recordAudit({ action: 'auth.password_reset_request', target: { type: 'user', id: target.id, name: target.email }, summary: `Made a password reset link for ${target.email}`, details: { emailed: delivered.emailed } });
  // Someone who isn't an owner or admin never sees the link (it would let them sign in as the person): it goes by email.
  if (!isInstanceAdmin(me)) {
    const { link: _link, ...emailedOnly } = delivered;
    return delivered.emailed ? json(emailedOnly) : error('Email isn’t set up (or failed), so the link can’t be sent: ask an owner or admin', 409);
  }
  return json(delivered);
});
