/**
 * POST /api/users/invites { email, role } (owners and admins): invite someone. The link goes out by email when
 * SMTP is configured, and always comes back as `link` so it can be copied. A new invite for the same email
 * replaces the old one. Only the owner invites admins.
 */
import { z } from 'zod';
import { ASSIGNABLE_ROLES, type LinkResponse } from '@/lib/shared/auth';
import { createInvite, deliverLink, findUserByEmail, inviteView, requireUser, userNames } from '@/lib/server/auth';
import { error, handler, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

const schema = z.object({ email: z.string().trim().email('Enter a valid email address').max(320), role: z.enum(ASSIGNABLE_ROLES).default('member') });

export const POST = handler(async (request: Request) => {
  const me = await requireUser('users:manage');
  const body = await parseBody(request, schema);
  if (!body.ok) return body.response;
  if (body.data.role === 'admin' && me.role !== 'owner') return error('Only the owner can invite admins', 403);
  if (findUserByEmail(body.data.email)) return error(`${body.data.email} already has an account`, 409);
  const { record, token } = createInvite(body.data.email, body.data.role, me.id);
  const delivered: LinkResponse = await deliverLink('invite', { to: record.email, token, request, invitedBy: me.name, role: record.role });
  return json({ invite: inviteView(record, userNames()), ...delivered }, 201);
});
