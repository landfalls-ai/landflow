/** One MCP policy hook (C14): read, change or remove it. Admin `mcp:manage` (the `/api/settings/mcp` rule). */
import { error, handler, json, parseBody } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';
import { deletePolicyHook, getPolicyHook, hookView, updatePolicyHook } from '@/lib/server/mcp/policy-hooks';
import { hookPatch } from '@/lib/server/mcp/policy-hooks-schema';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** `{ hook }`, or 404. Who: an admin. */
export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const hook = getPolicyHook((await params).id);
  return hook ? json({ hook: hookView(hook) }) : error('Policy hook not found', 404);
});

/** Change any field (`credentialId: null` clears the credential): `{ hook }`. Who: an admin. */
export const PATCH = handler(async (request: Request, { params }: Ctx) => {
  const body = await parseBody(request, hookPatch);
  if (!body.ok) return body.response;
  return json({ hook: hookView(updatePolicyHook((await params).id, body.data, routeActor().id)) });
});

/** Remove the hook: `{ ok: true }`. Who: an admin. */
export const DELETE = handler(async (_request: Request, { params }: Ctx) => {
  deletePolicyHook((await params).id, routeActor().id);
  return json({ ok: true });
});
