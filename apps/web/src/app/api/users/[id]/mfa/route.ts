/**
 * DELETE /api/users/<id>/mfa (owners and admins): reset a person's second factors, for someone locked out. The owner
 * resets anyone's but their own; an admin resets members' and other admins', never the owner's; nobody uses this on
 * themselves (they use Sign-in & security). Removes every factor and recovery code and ends the person's sessions; the
 * `auth.mfa_reset` event is stored in the same transaction (503 when LANDFLOW_AUDIT_FAIL_CLOSED and the audit log is
 * down, and nothing changes).
 */
import { canResetMfa } from '@/lib/shared/auth';
import { getUser, requireUser } from '@/lib/server/auth';
import { resetFactors } from '@/lib/server/auth/mfa';
import { mayActOnUser } from '@/lib/server/auth/user-scope';
import { error, handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const DELETE = handler(async (_request: Request, { params }: Ctx) => {
  const me = await requireUser('users:manage');
  const target = getUser((await params).id);
  if (!target) return error('User not found', 404);
  if (target.id === me.id) return error('Use Sign-in & security to change your own second factor', 400);
  if (!canResetMfa(me, target)) return error('You can’t reset this person’s second factor', 403);
  if (!mayActOnUser(me, target)) return error('This person belongs to projects you don’t administer', 403);
  return json({ ok: true, removed: resetFactors(me, target) });
});
