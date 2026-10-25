/**
 * PATCH /api/users/<id> { role } and DELETE /api/users/<id> (owners and admins, by `canManageUser`): change a
 * user's role, or remove them with their sessions and API keys (their workflows stay). Nobody changes or removes
 * the owner or themselves, and only the owner manages admins.
 */
import { z } from 'zod';
import { ASSIGNABLE_ROLES, canManageUser } from '@/lib/shared/auth';
import { deleteUser, deleteUserSessions, getUser, requireUser, updateUser, userView } from '@/lib/server/auth';
import { editLocks } from '@/lib/server/auth/edit-locks';
import { error, handler, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

const schema = z.strictObject({ role: z.enum(ASSIGNABLE_ROLES) });

export const PATCH = handler(async (request: Request, { params }: Ctx) => {
  const me = await requireUser('users:manage');
  const target = getUser((await params).id);
  if (!target) return error('User not found', 404);
  const body = await parseBody(request, schema);
  if (!body.ok) return body.response;
  if (!canManageUser(me, target, { kind: 'role', role: body.data.role })) return error('You can’t change this user’s role', 403);
  return json({ user: userView(updateUser(target.id, { role: body.data.role })) });
});

export const DELETE = handler(async (_request: Request, { params }: Ctx) => {
  const me = await requireUser('users:manage');
  const target = getUser((await params).id);
  if (!target) return error('User not found', 404);
  if (!canManageUser(me, target, { kind: 'remove' })) return error('You can’t remove this user', 403);
  deleteUserSessions(target.id);
  deleteUser(target.id);
  editLocks.releaseUser(target.id);
  return json({ ok: true });
});
