/**
 * GET, PUT and DELETE /api/users/roles/<id>: read a custom role, change its name, description or rules (the escalation
 * check runs on the whole new rule set; the holders see it on their next request), or delete it. Deleting a role someone
 * holds answers 409 with the holder count until `?confirm=true`; the holders then become plain members.
 */
import { z } from 'zod';
import { getRole, updateRole, deleteRole } from '@/lib/server/auth/roles';
import { roleUpdateSchema } from '@/lib/server/auth/roles-schema';
import { requireUser } from '@/lib/server/auth';
import { error, handler, json, parseBody, parseQuery } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  await requireUser();
  const role = getRole((await params).id);
  return role ? json({ role }) : error('Role not found', 404);
});

export const PUT = handler(async (request: Request, { params }: Ctx) => {
  const me = await requireUser('users:manage');
  const body = await parseBody(request, roleUpdateSchema);
  if (!body.ok) return body.response;
  return json({ role: updateRole((await params).id, body.data, me) });
});

export const DELETE = handler(async (request: Request, { params }: Ctx) => {
  const me = await requireUser('users:manage');
  const query = parseQuery(request, z.object({ confirm: z.enum(['true', 'false']).optional() }));
  if (!query.ok) return query.response;
  deleteRole((await params).id, me, { confirm: query.data.confirm === 'true' });
  return json({ ok: true });
});
