/**
 * The per-plugin MCP endpoints: /api/mcp/plugins/<id> serves the tools of one exposed plugin (`core` is the host's
 * built-in nodes) over Streamable HTTP, stateless, to 2026-07-28 clients (`server/discover`, the `_meta` envelope,
 * `subscriptions/listen`) and 2025-xx clients (`initialize`; JSON responses, 405 for GET and DELETE). Callers are the
 * bundled gateway (the gateway secret plus the identity it validated), a Landflow MCP token, an identity provider
 * token, an API key or a session; anything else is 401. 404 for a plugin that isn't installed or isn't exposed to
 * agents. Each tools/call is an execution with mode `mcp`. See lib/server/mcp/plugin-servers.ts.
 */
import { handler } from '@/lib/server/http';
import { handlePluginMcpRequest } from '@/lib/server/mcp/plugin-servers';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

async function handle(request: Request, { params }: Ctx) {
  const { id } = await params;
  return handlePluginMcpRequest(request, id);
}

export const GET = handler(handle);
export const POST = handler(handle);
export const DELETE = handler(handle);
