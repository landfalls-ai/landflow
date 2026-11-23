/**
 * Send one sample request to a policy hook (C14): `tool: "example_tool"`, no arguments, `test: true`. It is not a run:
 * nothing is audited, cached or counted. Admin `mcp:manage` (the `/api/settings/mcp` rule).
 */
import { error, handler, json } from '@/lib/server/http';
import { askHook, hookRequestBody } from '@/lib/server/mcp/policy-check';
import { getPolicyHook } from '@/lib/server/mcp/policy-hooks';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** `{ ok, decision?, reason?, ruleId?, status?, error?, ms }`: what the service answered, or why it did not. Who: an admin. */
export const POST = handler(async (_request: Request, { params }: Ctx) => {
  const hook = getPolicyHook((await params).id);
  if (!hook) return error('Policy hook not found', 404);
  const sample = { method: 'tools/call' as const, serverUrl: 'https://mcp.example.com/mcp', tool: 'example_tool', args: {} };
  return json(await askHook(hook, hookRequestBody(sample, {}, { test: true })));
});
