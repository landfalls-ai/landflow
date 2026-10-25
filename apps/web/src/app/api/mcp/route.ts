/**
 * The instance MCP server, for coding agents (Claude Code, Cursor…): build, validate and run
 * workflows over Streamable HTTP (stateless, JSON responses). Off by default: Settings → MCP turns
 * it on and shows the access token, sent as `Authorization: Bearer <token>`. 403 while it is off,
 * 401 without the right token. See lib/server/mcp/instance-tools.ts for the tools.
 */
import { handler } from '@/lib/server/http';
import { mcpAccess, verifyMcpToken } from '@/lib/server/mcp/instance';
import { instanceServer } from '@/lib/server/mcp/instance-tools';
import { bearerToken, jsonRpcError, serveMcp, unauthorized } from '@/lib/server/mcp/server';

export const dynamic = 'force-dynamic';

async function handle(request: Request) {
  if (!mcpAccess().enabled) return jsonRpcError(403, -32001, 'The Landflow MCP server is off. Turn it on in Settings → MCP.');
  if (!verifyMcpToken(bearerToken(request))) return unauthorized('Send the access token from Settings → MCP as “Authorization: Bearer <token>”');
  return serveMcp(request, instanceServer);
}

export const GET = handler(handle);
export const POST = handler(handle);
export const DELETE = handler(handle);
