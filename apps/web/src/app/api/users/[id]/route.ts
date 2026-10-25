/**
 * PATCH /api/users/<id> { role } and DELETE /api/users/<id> (owners and admins, by `canManageUser`): change a
 * user's role, or remove them with their sessions and API keys. Nobody changes or removes the owner or themselves,
 * and only the owner manages admins.
 *
 * Removing someone who owns workflows, credentials, data tables or agents (their personal project) needs a transfer
 * target, in the body `{ transferTo: { userId } | { projectId } }` or as `?transferToUser=` / `?transferToProject=`:
 * everything moves there and the user goes, in one transaction (lib/server/projects/transfer.ts).
 */
import { z } from 'zod';
import { ASSIGNABLE_ROLES, canManageUser } from '@/lib/shared/auth';
import type { TransferTarget } from '@/lib/shared/projects';
import { getUser, requireUser, updateUser, userView } from '@/lib/server/auth';
import { editLocks } from '@/lib/server/auth/edit-locks';
import { error, json, parseBody } from '@/lib/server/http';
import { deleteUserWithTransfer } from '@/lib/server/projects';
import { projectRoute } from '@/lib/server/projects/http';
import { recordAudit } from '@/lib/server/audit';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

const schema = z.strictObject({ role: z.enum(ASSIGNABLE_ROLES) });

export const PATCH = projectRoute(async (request: Request, { params }: Ctx) => {
  const me = await requireUser('users:manage');
  const target = getUser((await params).id);
  if (!target) return error('User not found', 404);
  const body = await parseBody(request, schema);
  if (!body.ok) return body.response;
  if (!canManageUser(me, target, { kind: 'role', role: body.data.role })) return error('You can’t change this user’s role', 403);
  const updated = updateUser(target.id, { role: body.data.role });
  recordAudit({ action: 'user.role_change', target: { type: 'user', id: target.id, name: target.email }, summary: `Changed ${target.email}’s role from ${target.role} to ${updated.role}`, details: { from: target.role, to: updated.role } });
  return json({ user: userView(updated) });
});

const transferSchema = z.object({ transferTo: z.union([z.object({ userId: z.string().min(1) }), z.object({ projectId: z.string().min(1) })]).optional() });

/** Where the removed user's resources go: the body's `transferTo`, or `?transferToUser=` / `?transferToProject=`. */
async function transferTarget(request: Request): Promise<TransferTarget | undefined | Response> {
  const query = new URL(request.url).searchParams;
  if (query.get('transferToUser')) return { userId: query.get('transferToUser')! };
  if (query.get('transferToProject')) return { projectId: query.get('transferToProject')! };
  const text = await request.text().catch(() => '');
  if (!text.trim()) return undefined;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return error('Request body must be JSON');
  }
  const parsed = transferSchema.safeParse(body);
  if (!parsed.success) return error('Invalid request', 400, { issues: parsed.error.issues.slice(0, 10) });
  return parsed.data.transferTo;
}

export const DELETE = projectRoute(async (request: Request, { params }: Ctx) => {
  const me = await requireUser('users:manage');
  const target = getUser((await params).id);
  if (!target) return error('User not found', 404);
  if (!canManageUser(me, target, { kind: 'remove' })) return error('You can’t remove this user', 403);
  const transferTo = await transferTarget(request);
  if (transferTo instanceof Response) return transferTo;
  if (transferTo && 'userId' in transferTo && transferTo.userId === target.id) return error('Transfer to someone else, or to a project');
  const result = deleteUserWithTransfer(target.id, transferTo, me.id);
  editLocks.releaseUser(target.id);
  recordAudit({ action: 'user.remove', target: { type: 'user', id: target.id, name: target.email }, summary: `Removed ${target.email}`, details: { role: target.role, moved: result.moved, transferredTo: result.to?.id } });
  return json({ ok: true, moved: result.moved, ...(result.to && { transferredTo: { id: result.to.id, name: result.to.name, type: result.to.type } }) });
});
