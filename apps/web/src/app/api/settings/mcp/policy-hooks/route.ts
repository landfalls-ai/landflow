/**
 * Settings → MCP → Policy hooks (C14): the webhooks asked before an outbound MCP request. Admin `mcp:manage` by the
 * `/api/settings/mcp` rule in lib/server/auth/policy.ts; the credential is shown by id and name, never its data.
 */
import { handler, json, parseBody } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';
import { createPolicyHook, hookView, listPolicyHooks } from '@/lib/server/mcp/policy-hooks';
import { hookInput } from '@/lib/server/mcp/policy-hooks-schema';

export const dynamic = 'force-dynamic';

/** `{ hooks }`: every policy hook, oldest first. Who: an admin (`mcp:manage`). */
export const GET = handler(async () => json({ hooks: listPolicyHooks().map(hookView) }));

/** Create a hook (at most 20): 201 `{ hook }`. A URL the outbound rules refuse, or a credential that is not a Bearer Auth one, is a 400. Who: an admin. */
export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, hookInput);
  if (!body.ok) return body.response;
  return json({ hook: hookView(createPolicyHook(body.data, routeActor().id)) }, 201);
});
