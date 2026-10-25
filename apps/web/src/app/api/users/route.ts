/**
 * GET /api/users: every user (name, email, role, how they sign in), and for owners and admins the pending
 * invites. Signed-in users only; changing users is in ./invites and ./[id].
 */
import { can } from '@/lib/shared/auth';
import { inviteView, listInvites, listUsers, requireUser, userNames, userView } from '@/lib/server/auth';
import { handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => {
  const me = await requireUser();
  const names = userNames();
  return json({
    users: listUsers().map(userView),
    ...(can(me, 'users:manage') && { invites: listInvites().map((invite) => inviteView(invite, names)) }),
  });
});
