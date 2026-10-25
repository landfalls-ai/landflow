/**
 * Settings → MCP: GET the instance MCP server's state, PATCH { enabled } to turn it on or off
 * (turning it on the first time creates a token), POST to replace the token. A response that
 * created a token carries it as `token`, the only time it is shown.
 */
import { z } from 'zod';
import { handler, json, parseBody } from '@/lib/server/http';
import { mcpAccess, regenerateMcpToken, setMcpEnabled } from '@/lib/server/mcp/instance';
import { recordAudit } from '@/lib/server/audit';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => json({ access: mcpAccess() }));

export const PATCH = handler(async (request: Request) => {
  const body = await parseBody(request, z.strictObject({ enabled: z.boolean() }));
  if (!body.ok) return body.response;
  const access = setMcpEnabled(body.data.enabled);
  recordAudit({ action: 'settings.update', target: { type: 'settings', id: 'mcp', name: 'Instance MCP server' }, summary: `${body.data.enabled ? 'Turned on' : 'Turned off'} the instance MCP server`, details: { enabled: body.data.enabled } });
  return json(access);
});

export const POST = handler(async () => {
  const result = regenerateMcpToken();
  recordAudit({ action: 'settings.update', target: { type: 'settings', id: 'mcp', name: 'Instance MCP server' }, summary: 'Made a new instance MCP token' });
  return json(result);
});
