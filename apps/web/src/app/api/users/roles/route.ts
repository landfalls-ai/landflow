/**
 * GET /api/users/roles: the custom roles with their rules and how many members hold each (any signed-in user, like the
 * user list: Settings → Users shows who holds what). POST /api/users/roles { name, description?, rules } creates one
 * (`users:manage` by the policy table, and the escalation check in the library: you grant only what you hold; only the
 * owner grants `users:manage` or `apiKeys:admin`; nobody grants `projects:manage`). Custom roles are docs/features/authentication.md#custom-roles.
 */
import { createRole, listRoles } from '@/lib/server/auth/roles';
import { roleCreateSchema } from '@/lib/server/auth/roles-schema';
import { requireUser } from '@/lib/server/auth';
import { handler, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => {
  await requireUser();
  return json({ roles: listRoles() });
});

export const POST = handler(async (request: Request) => {
  const me = await requireUser('users:manage');
  const body = await parseBody(request, roleCreateSchema);
  if (!body.ok) return body.response;
  return json({ role: createRole(body.data, me) }, 201);
});
